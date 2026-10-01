package com.emir.minimaxwaker;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

// Always-on foreground service: a tiny HTTP server on PORT that the main
// app's offline page calls (over Tailscale when away, or the LAN at home):
//
//   GET /wake    → sends the PC a Wake-on-LAN packet from inside the house
//   GET /status  → "is the relay alive?"
//
// GET only (no body, no custom headers) so the page's cross-origin fetch
// needs no CORS preflight. Anyone who can reach it can only wake the PC,
// which is harmless — and only the LAN and the user's own Tailscale devices
// can reach it at all.
public class WakerService extends Service {

    static final int PORT = 8099;
    private static final String TAG = "MiniMaxWaker";
    private static final String CHANNEL_ID = "waker";
    private static final int NOTIFICATION_ID = 1;

    // Read by MainActivity for its status line.
    static volatile boolean running = false;
    static volatile long lastWakeAt = 0;
    static volatile String lastWakeFrom = null;
    static volatile int wakeCount = 0;

    private ServerSocket serverSocket;
    private Thread serverThread;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    static void start(Context context) {
        Intent intent = new Intent(context, WakerService.class);
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent);
        else context.startService(intent);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startInForeground();
        if (serverThread == null) {
            acquireLocks();
            serverThread = new Thread(this::serve, "waker-http");
            serverThread.start();
        }
        return START_STICKY;
    }

    private void startInForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Uyandırıcı", NotificationManager.IMPORTANCE_LOW);
            nm.createNotificationChannel(channel);
        }
        PendingIntent open = PendingIntent.getActivity(
            this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        Notification notification = builder
            .setSmallIcon(android.R.drawable.ic_lock_power_off)
            .setContentTitle("PC uyandırıcı çalışıyor")
            .setContentText("Port " + PORT + " — uyandırma isteği bekleniyor")
            .setContentIntent(open)
            .setOngoing(true)
            .build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    // The phone sits on a charger doing nothing for weeks: keep the CPU and
    // the Wi-Fi radio from napping, or requests time out until something
    // else happens to wake it.
    private void acquireLocks() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MiniMaxWaker::cpu");
        wakeLock.acquire();
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
        @SuppressWarnings("deprecation")
        int mode = Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
        wifiLock = wm.createWifiLock(mode, "MiniMaxWaker::wifi");
        wifiLock.acquire();
    }

    private void serve() {
        while (!Thread.currentThread().isInterrupted()) {
            try (ServerSocket server = new ServerSocket()) {
                serverSocket = server;
                server.setReuseAddress(true);
                server.bind(new InetSocketAddress(PORT)); // all interfaces: Wi-Fi and Tailscale
                running = true;
                while (true) {
                    Socket client = server.accept();
                    new Thread(() -> handle(client), "waker-client").start();
                }
            } catch (Exception e) {
                running = false;
                if (Thread.currentThread().isInterrupted()) return;
                Log.w(TAG, "server error, restarting in 3s", e);
                try {
                    Thread.sleep(3000);
                } catch (InterruptedException ie) {
                    return;
                }
            }
        }
    }

    private void handle(Socket client) {
        try (Socket socket = client) {
            socket.setSoTimeout(5000);
            BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
            String requestLine = in.readLine();
            if (requestLine == null) return;
            String[] parts = requestLine.split(" ");
            String method = parts.length > 0 ? parts[0] : "";
            String path = parts.length > 1 ? parts[1].split("\\?")[0] : "";

            int status;
            String body;
            if (method.equals("OPTIONS")) {
                status = 204;
                body = "";
            } else if (path.equals("/wake")) {
                try {
                    MagicPacket.send();
                    lastWakeAt = System.currentTimeMillis();
                    lastWakeFrom = socket.getInetAddress().getHostAddress();
                    wakeCount++;
                    status = 200;
                    body = "{\"ok\":true}";
                } catch (Exception e) {
                    status = 500;
                    body = "{\"ok\":false,\"error\":\"" + String.valueOf(e.getMessage()).replace("\"", "'") + "\"}";
                }
            } else if (path.equals("/status")) {
                status = 200;
                body = "{\"ok\":true,\"wakeCount\":" + wakeCount + ",\"lastWakeAt\":" + lastWakeAt + "}";
            } else {
                status = 404;
                body = "{\"ok\":false}";
            }

            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            String head = "HTTP/1.1 " + status + (status == 200 ? " OK" : status == 204 ? " No Content" : " Error") + "\r\n"
                + "Content-Type: application/json\r\n"
                + "Content-Length: " + bytes.length + "\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Methods: GET, OPTIONS\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
            OutputStream out = socket.getOutputStream();
            out.write(head.getBytes(StandardCharsets.UTF_8));
            out.write(bytes);
            out.flush();
        } catch (Exception e) {
            Log.w(TAG, "request failed", e);
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        if (serverThread != null) serverThread.interrupt();
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (Exception ignored) {
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
