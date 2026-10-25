package com.emir.minimaxcontrol;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.Context;
import android.net.Uri;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

// Backs the "Yapıştır" button on the picture inputs (video first/last
// frame, Anime2Real input). It has to be native: the app is served over
// plain http from the PC, and browsers only allow reading images from the
// clipboard (navigator.clipboard.read) on secure https pages.
//
// Accepts what Android apps actually put on the clipboard when copying a
// picture — a content:// URI (Chrome's "Copy image", gallery apps, this
// app's own Galeri "Kopyala") — or a plain-text http(s) link to an image,
// which is downloaded.
@CapacitorPlugin(name = "ClipboardImage")
public class ClipboardImagePlugin extends Plugin {

    // Bytes travel to the WebView as base64 — keep it to sane photo sizes.
    private static final int MAX_BYTES = 30 * 1024 * 1024;

    @PluginMethod
    public void read(PluginCall call) {
        // Android 10+ only lets the app with window focus read the clipboard
        // — fine here, it's always a tap inside the app.
        ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        ClipData clip = clipboard != null ? clipboard.getPrimaryClip() : null;
        if (clip == null || clip.getItemCount() == 0) {
            call.reject("Pano boş.");
            return;
        }

        new Thread(() -> {
            try {
                ContentResolver resolver = getContext().getContentResolver();
                for (int i = 0; i < clip.getItemCount(); i++) {
                    ClipData.Item item = clip.getItemAt(i);
                    Uri uri = item.getUri();
                    if (uri != null) {
                        String type = resolver.getType(uri);
                        if (type == null || type.startsWith("image/")) {
                            try (InputStream in = resolver.openInputStream(uri)) {
                                resolve(call, readAll(in), type != null ? type : "image/png");
                                return;
                            }
                        }
                    }
                    CharSequence text = item.getText();
                    if (text != null) {
                        String link = text.toString().trim();
                        if (link.startsWith("http://") || link.startsWith("https://")) {
                            HttpURLConnection conn = (HttpURLConnection) new URL(link).openConnection();
                            conn.setConnectTimeout(15000);
                            conn.setReadTimeout(60000);
                            String type = conn.getContentType();
                            if (type != null && type.startsWith("image/")) {
                                try (InputStream in = conn.getInputStream()) {
                                    resolve(call, readAll(in), type.split(";")[0]);
                                    return;
                                }
                            }
                            conn.disconnect();
                        }
                    }
                }
                call.reject("Panoda görsel yok.");
            } catch (Exception e) {
                call.reject("Panodaki görsel okunamadı: " + e.getMessage(), e);
            }
        }).start();
    }

    private static void resolve(PluginCall call, byte[] bytes, String mimeType) {
        JSObject ret = new JSObject();
        ret.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
        ret.put("mimeType", mimeType);
        call.resolve(ret);
    }

    private static byte[] readAll(InputStream in) throws Exception {
        if (in == null) throw new Exception("açılamadı");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[64 * 1024];
        int n;
        while ((n = in.read(buffer)) != -1) {
            out.write(buffer, 0, n);
            if (out.size() > MAX_BYTES) throw new Exception("görsel çok büyük");
        }
        return out.toByteArray();
    }
}
