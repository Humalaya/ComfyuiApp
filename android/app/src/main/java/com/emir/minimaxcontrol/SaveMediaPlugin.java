package com.emir.minimaxcontrol;

import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

// Backs Galeri's long-press "Kaydet"/"Paylaş" menu (see FullscreenViewer.tsx)
// — Android's WebView (unlike the Chrome *browser app*) has no built-in
// "save image"/"share image" on long-press of its own; this plugin is what
// actually makes those work from inside this native-wrapped app.
@CapacitorPlugin(name = "SaveMedia")
public class SaveMediaPlugin extends Plugin {

    // Saves straight into the system Photos/Gallery app via MediaStore
    // (scoped storage — no WRITE_EXTERNAL_STORAGE permission needed on
    // Android 10+, which this app's real-world usage always is).
    @PluginMethod
    public void save(PluginCall call) {
        String url = call.getString("url");
        String filename = call.getString("filename");
        String mimeType = call.getString("mimeType");
        if (url == null || filename == null || mimeType == null) {
            call.reject("url, filename ve mimeType gerekli.");
            return;
        }

        new Thread(() -> {
            try {
                byte[] data = downloadBytes(url);
                Uri saved = saveToMediaStore(getContext(), filename, mimeType, data);
                JSObject ret = new JSObject();
                ret.put("uri", saved.toString());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Kaydedilemedi: " + e.getMessage(), e);
            }
        }).start();
    }

    // Downloads to a temp file in the app's own cache dir, hands it to the
    // system share sheet via the FileProvider already declared in
    // AndroidManifest.xml (content:// URI — a raw file:// URI would be
    // rejected by other apps on modern Android).
    @PluginMethod
    public void share(PluginCall call) {
        String url = call.getString("url");
        String filename = call.getString("filename");
        String mimeType = call.getString("mimeType");
        if (url == null || filename == null || mimeType == null) {
            call.reject("url, filename ve mimeType gerekli.");
            return;
        }

        new Thread(() -> {
            try {
                byte[] data = downloadBytes(url);
                File cacheDir = new File(getContext().getCacheDir(), "shared-media");
                if (!cacheDir.exists() && !cacheDir.mkdirs()) {
                    throw new Exception("Geçici klasör oluşturulamadı.");
                }
                File tempFile = new File(cacheDir, filename);
                try (FileOutputStream out = new FileOutputStream(tempFile)) {
                    out.write(data);
                }

                Uri contentUri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", tempFile);

                Intent shareIntent = new Intent(Intent.ACTION_SEND);
                shareIntent.setType(mimeType);
                shareIntent.putExtra(Intent.EXTRA_STREAM, contentUri);
                shareIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                shareIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

                Intent chooser = Intent.createChooser(shareIntent, null);
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(chooser);

                call.resolve();
            } catch (Exception e) {
                call.reject("Paylaşılamadı: " + e.getMessage(), e);
            }
        }).start();
    }

    private byte[] downloadBytes(String urlStr) throws Exception {
        URL url = new URL(urlStr);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(120000); // videos can be large — this is on a local LAN, not the open internet
        try (InputStream in = conn.getInputStream()) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) != -1) buffer.write(chunk, 0, n);
            return buffer.toByteArray();
        } finally {
            conn.disconnect();
        }
    }

    private Uri saveToMediaStore(Context context, String filename, String mimeType, byte[] data) throws Exception {
        boolean isVideo = mimeType.startsWith("video/");
        Uri collection = isVideo ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;

        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            String subDir = isVideo ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_PICTURES;
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, subDir + "/MiniMaxKontrol");
        }

        Uri itemUri = context.getContentResolver().insert(collection, values);
        if (itemUri == null) throw new Exception("MediaStore kaydı oluşturulamadı.");
        try (OutputStream out = context.getContentResolver().openOutputStream(itemUri)) {
            if (out == null) throw new Exception("Dosya yazılamadı.");
            out.write(data);
        }
        return itemUri;
    }
}
