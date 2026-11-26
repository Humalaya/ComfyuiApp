package com.emir.minimaxcontrol;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.webkit.JavascriptInterface;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.json.JSONObject;

// The PC's address, changeable from the phone. The app is served live from
// the PC (capacitor.config.ts server.url), and that address is baked into the
// APK — when the router hands the PC a new IP (no DHCP reservation
// possible here), the offline page lets you type the new one instead of
// rebuilding the APK.
//
// Exposed to pages as window.ServerAddress (addJavascriptInterface, like
// WakeOnLan — Capacitor plugins don't reach offline.html). Only a private
// LAN or Tailscale IPv4 is accepted, the port and scheme are fixed
// (http, 5173), and the address is saved only after that IP answers this
// app's own /api/app-version — so the app can't be pointed at some other
// site. MainActivity reads the saved address before the bridge is built.
public class ServerAddress {

    public static final String JS_NAME = "ServerAddress";
    static final String PREFS = "server-address";
    static final String KEY_IP = "ip";
    static final int PORT = 5173;

    private final Activity activity;

    public ServerAddress(Activity activity) {
        this.activity = activity;
    }

    // 192.168.x.x, 10.x.x.x, 172.16–31.x.x, and Tailscale's 100.64–127.x.x.
    static boolean isAllowed(String ip) {
        Matcher m = Pattern.compile("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$").matcher(ip);
        if (!m.matches()) return false;
        int[] o = new int[4];
        for (int i = 0; i < 4; i++) {
            o[i] = Integer.parseInt(m.group(i + 1));
            if (o[i] > 255) return false;
        }
        return o[0] == 192 && o[1] == 168
            || o[0] == 10
            || o[0] == 172 && o[1] >= 16 && o[1] <= 31
            || o[0] == 100 && o[1] >= 64 && o[1] <= 127;
    }

    static String urlFor(String ip) {
        return "http://" + ip + ":" + PORT;
    }

    // The saved IP, or null — then the APK's built-in address is used.
    static String savedIp(Context context) {
        String ip = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_IP, null);
        return ip != null && isAllowed(ip) ? ip : null;
    }

    // Writes the bundled capacitor.config.json with server.url replaced into
    // the app's files dir; returns that dir (for CapConfig.loadFromFile), or
    // null when there's no saved address or it can't be written.
    static String writeConfigOverride(Context context) {
        String ip = savedIp(context);
        if (ip == null) return null;
        try (InputStream in = context.getAssets().open("capacitor.config.json")) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int n;
            while ((n = in.read(chunk)) != -1) buf.write(chunk, 0, n);
            JSONObject json = new JSONObject(buf.toString(StandardCharsets.UTF_8.name()));
            JSONObject server = json.optJSONObject("server");
            if (server == null) server = new JSONObject();
            server.put("url", urlFor(ip));
            json.put("server", server);
            File dir = new File(context.getFilesDir(), "server-config");
            if (!dir.exists() && !dir.mkdirs()) return null;
            try (FileOutputStream out = new FileOutputStream(new File(dir, "capacitor.config.json"))) {
                out.write(json.toString().getBytes(StandardCharsets.UTF_8));
            }
            return dir.getAbsolutePath();
        } catch (Exception e) {
            return null;
        }
    }

    // The address the app uses now, e.g. "http://192.168.1.62:5173".
    @JavascriptInterface
    public String current() {
        String ip = savedIp(activity);
        if (ip != null) return urlFor(ip);
        try {
            return ((MainActivity) activity).getBridge().getServerUrl();
        } catch (Exception e) {
            return "";
        }
    }

    // Checks the IP, saves it and restarts the app on it. Returns "" on
    // success, else a message for the page (JS interfaces can't throw).
    // Runs on the WebView's JavaBridge thread, so the blocking check is fine.
    @JavascriptInterface
    public String set(String rawIp) {
        String ip = rawIp == null ? "" : rawIp.trim();
        if (!isAllowed(ip)) return "Sadece ev ağı (192.168.x.x, 10.x.x.x) ya da Tailscale (100.x.x.x) adresi girilebilir.";
        if (!answersAsThisApp(ip)) return "Bu adreste uygulamanın sunucusu cevap vermiyor. Adresi ve bilgisayarın açık olduğunu kontrol et.";
        activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_IP, ip).commit();
        activity.runOnUiThread(activity::recreate);
        return "";
    }

    // Back to the APK's built-in address.
    @JavascriptInterface
    public void reset() {
        activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_IP).commit();
        activity.runOnUiThread(activity::recreate);
    }

    // The PC's Tailscale address — fixed, tried when the phone's VPN is on.
    static final String TAILSCALE_IP = "100.78.9.7";

    // Why the app can't reach the PC — for the offline page's message. JSON:
    //   wifi / vpn: the phone is on Wi-Fi / a VPN (Tailscale) is up
    //   sameLan: the phone's Wi-Fi is the same /24 as the address in use
    //   target: "ok" (answers as this app), "refused" (a device is there,
    //     nothing on the app's port), "other" (something else answers),
    //     "timeout" (nothing there: off, asleep, or the address moved)
    //   found: the address this app answers on now (LAN scan, then
    //     Tailscale), when it isn't the one in use — or null
    // No address is shown to the user; `found` is only used to reconnect.
    // Blocks for a few seconds (scan) — call it off the page's first paint.
    @JavascriptInterface
    public String diagnose() {
        JSONObject out = new JSONObject();
        try {
            String current = current();
            String host = android.net.Uri.parse(current).getHost();
            boolean wifi = false, vpn = false;
            String phoneIp = null;
            ConnectivityManager cm = (ConnectivityManager) activity.getSystemService(Context.CONNECTIVITY_SERVICE);
            for (Network n : cm.getAllNetworks()) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(n);
                if (caps == null) continue;
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) vpn = true;
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    wifi = true;
                    LinkProperties lp = cm.getLinkProperties(n);
                    if (lp != null)
                        for (LinkAddress la : lp.getLinkAddresses())
                            if (la.getAddress() instanceof Inet4Address) phoneIp = la.getAddress().getHostAddress();
                }
            }
            boolean sameLan = phoneIp != null && host != null && prefix24(phoneIp).equals(prefix24(host));
            String target = host == null ? "timeout" : probe(host);
            String found = null;
            if (!"ok".equals(target)) {
                if (phoneIp != null) found = scanLan(prefix24(phoneIp), host);
                if (found == null && vpn && !TAILSCALE_IP.equals(host) && answersAsThisApp(TAILSCALE_IP)) found = TAILSCALE_IP;
            }
            out.put("wifi", wifi).put("vpn", vpn).put("sameLan", sameLan).put("target", target).put("found", found == null ? JSONObject.NULL : found);
        } catch (Exception e) {
            try {
                out.put("error", String.valueOf(e.getMessage()));
            } catch (Exception ignored) {
            }
        }
        return out.toString();
    }

    private static String prefix24(String ip) {
        int i = ip.lastIndexOf('.');
        return i > 0 ? ip.substring(0, i) : ip;
    }

    // ok / refused / other / timeout — see diagnose().
    private static String probe(String host) {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(host, PORT), 2500);
        } catch (ConnectException e) {
            return "refused";
        } catch (Exception e) {
            return "timeout";
        }
        return answersAsThisApp(host) ? "ok" : "other";
    }

    // Every address of the phone's /24 that has the app's port open, then the
    // first that answers as this app. ~2 s for 254 hosts.
    private static String scanLan(String prefix, String skip) {
        ExecutorService pool = Executors.newFixedThreadPool(64);
        try {
            List<Future<String>> jobs = new ArrayList<>();
            for (int i = 1; i <= 254; i++) {
                final String ip = prefix + "." + i;
                if (ip.equals(skip)) continue;
                jobs.add(pool.submit(() -> {
                    try (Socket socket = new Socket()) {
                        socket.connect(new InetSocketAddress(ip, PORT), 600);
                        return ip;
                    } catch (Exception e) {
                        return null;
                    }
                }));
            }
            for (Future<String> job : jobs) {
                String ip = job.get(5, TimeUnit.SECONDS);
                if (ip != null && answersAsThisApp(ip)) return ip;
            }
        } catch (Exception ignored) {
        } finally {
            pool.shutdownNow();
        }
        return null;
    }

    private static boolean answersAsThisApp(String ip) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(urlFor(ip) + "/api/app-version").openConnection();
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(4000);
            if (conn.getResponseCode() != 200) return false;
            try (InputStream in = conn.getInputStream()) {
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                byte[] chunk = new byte[1024];
                int n;
                while ((n = in.read(chunk)) != -1 && buf.size() < 4096) buf.write(chunk, 0, n);
                return new JSONObject(buf.toString(StandardCharsets.UTF_8.name())).has("version");
            }
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
