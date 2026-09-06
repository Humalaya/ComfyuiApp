package com.emir.minimaxcontrol;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

// A foreground service with two jobs:
//
// 1. Make Android treat this app as actively doing user-requested work, not
//    an idle background tab — that's what stops the OS from killing the
//    process the moment the screen locks.
//
// 2. Poll ComfyUI's /history endpoint directly (bypassing the WebView
//    entirely) and post the "generation finished" notification itself.
//    This is NOT redundant with the WebView's own WS + /history polling in
//    useComfyGeneration.ts — that JS-side polling is what updates the UI
//    while the app is in the foreground, but Chromium throttles/freezes a
//    backgrounded WebView's JS timers independently of this service's
//    process priority, so the JS side can go silent for the entire time the
//    app is backgrounded. This native poll loop is what still notices
//    completion (and shows a notification) in that case — and also notices
//    if ComfyUI itself goes unreachable (server down/crashed) for several
//    polls in a row, which the WebView side never surfaced as anything
//    beyond a silently-retried fetch.
public class KeepAliveService extends Service {

    private static final String CHANNEL_ID = "keepalive";
    // Bumped from "generation_result" — Android notification channels are
    // immutable once created (including their sound), so giving this
    // channel a custom sound (res/raw/notification_sound.mp3) required a
    // fresh id; the old channel is deleted in createNotificationChannels()
    // below so it doesn't linger as a dead duplicate in system settings.
    private static final String RESULT_CHANNEL_ID = "generation_result_v2";
    private static final String LEGACY_RESULT_CHANNEL_ID = "generation_result";
    private static final int NOTIFICATION_ID = 1;
    // Same id the WebView side uses for its own LocalNotifications call
    // (see src/native/notifications.ts) — whichever of the two paths notices
    // completion first "wins" the notification slot, the other is a no-op
    // overwrite of the same id rather than a second visible notification.
    private static final int RESULT_NOTIFICATION_ID = 1000;
    // Separate id/slot from RESULT_NOTIFICATION_ID so an "unreachable" alert
    // never overwrites (or gets overwritten by) the actual generation result.
    private static final int UNREACHABLE_NOTIFICATION_ID = 1001;
    private static final long POLL_INTERVAL_MS = 5000;
    private static final int HTTP_TIMEOUT_MS = 10000;
    // 3 failed polls in a row (~15s) before treating it as "ComfyUI is down"
    // rather than one dropped request.
    private static final int UNREACHABLE_THRESHOLD = 3;

    private ScheduledExecutorService poller;
    private int consecutiveFailures = 0;
    private boolean unreachableNotified = false;
    private WifiManager.WifiLock wifiLock;
    private PowerManager.WakeLock wakeLock;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createNotificationChannels();

        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, launchIntent, piFlags);

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("MiniMax Kontrol")
            .setContentText("Arka planda açık kalıyor")
            .setSmallIcon(R.drawable.ic_stat_keepalive)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();

        if (Build.VERSION.SDK_INT >= 34) { // Android 14 (UPSIDE_DOWN_CAKE)
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }

        acquireLocks();
        stopPolling(); // a fresh generation replaces whatever the previous one was tracking

        String comfyBaseUrl = intent != null ? intent.getStringExtra("comfyBaseUrl") : null;
        String promptId = intent != null ? intent.getStringExtra("promptId") : null;
        String videoNodeId = intent != null ? intent.getStringExtra("videoNodeId") : null;

        if (comfyBaseUrl != null && promptId != null && videoNodeId != null) {
            startPolling(comfyBaseUrl, promptId, videoNodeId);
        }

        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        stopPolling();
        releaseLocks();
    }

    // A foreground service alone stops Android from killing the *process*
    // on screen lock, but it does nothing to stop the WiFi radio's own power
    // save mode from kicking in — which was dropping the LAN socket to the
    // ComfyUI proxy outright (ECONNRESET on the dev-server side) the moment
    // the screen locked, independent of anything JS-side. These two locks
    // are the standard Android mechanism for exactly that: keep WiFi at full
    // power and the CPU schedulable so the poll loop's socket survives.
    private void acquireLocks() {
        if (wifiLock == null) {
            WifiManager wifiManager = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifiManager != null) {
                wifiLock = wifiManager.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "MiniMaxKontrol:wifi");
                wifiLock.setReferenceCounted(false);
            }
        }
        if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire();

        if (wakeLock == null) {
            PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (powerManager != null) {
                wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MiniMaxKontrol:cpu");
                wakeLock.setReferenceCounted(false);
            }
        }
        if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire();
    }

    private void releaseLocks() {
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    }

    private void startPolling(String comfyBaseUrl, String promptId, String videoNodeId) {
        poller = Executors.newSingleThreadScheduledExecutor();
        poller.scheduleWithFixedDelay(
            () -> pollOnce(comfyBaseUrl, promptId, videoNodeId),
            POLL_INTERVAL_MS,
            POLL_INTERVAL_MS,
            TimeUnit.MILLISECONDS
        );
    }

    private void stopPolling() {
        if (poller != null) {
            poller.shutdownNow();
            poller = null;
        }
        consecutiveFailures = 0;
        clearUnreachableNotification();
    }

    private void pollOnce(String comfyBaseUrl, String promptId, String videoNodeId) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(comfyBaseUrl + "/history/" + promptId);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(HTTP_TIMEOUT_MS);
            conn.setReadTimeout(HTTP_TIMEOUT_MS);
            if (conn.getResponseCode() != 200) {
                onPollFailure();
                return;
            }

            String body = readStream(conn.getInputStream());
            onPollSuccess();

            JSONObject entry = new JSONObject(body).optJSONObject(promptId);
            if (entry == null) return; // not queued yet from ComfyUI's point of view

            JSONObject status = entry.optJSONObject("status");
            if (status == null || !status.optBoolean("completed", false)) return;

            boolean hasFile = false;
            JSONObject outputs = entry.optJSONObject("outputs");
            if (outputs != null) {
                JSONObject nodeOutput = outputs.optJSONObject(videoNodeId);
                if (nodeOutput != null) {
                    hasFile = nonEmpty(nodeOutput.optJSONArray("gifs"))
                        || nonEmpty(nodeOutput.optJSONArray("videos"))
                        || nonEmpty(nodeOutput.optJSONArray("images"));
                }
            }

            if (hasFile) {
                postResultNotification("✓ Üretim tamamlandı", "Video hazır.");
            } else {
                postResultNotification("✗ Üretim hatası", "Çıktı bulunamadı (workflow beklenmedik şekilde sonuçlandı).");
            }

            stopPolling();
            stopForeground(true);
            stopSelf();
        } catch (Exception e) {
            // Connection refused/timeout/DNS failure — the exact "ComfyUI is
            // down" case this method exists to catch, not a parse bug.
            onPollFailure();
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    // A single failed poll is routine (brief LAN hiccup, ComfyUI momentarily
    // busy) — only a run of them means the server is actually unreachable.
    private void onPollFailure() {
        consecutiveFailures++;
        if (consecutiveFailures >= UNREACHABLE_THRESHOLD && !unreachableNotified) {
            unreachableNotified = true;
            postUnreachableNotification();
        }
    }

    private void onPollSuccess() {
        consecutiveFailures = 0;
        clearUnreachableNotification();
    }

    private void clearUnreachableNotification() {
        if (unreachableNotified) {
            unreachableNotified = false;
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.cancel(UNREACHABLE_NOTIFICATION_ID);
        }
    }

    private static boolean nonEmpty(JSONArray arr) {
        return arr != null && arr.length() > 0;
    }

    private static String readStream(InputStream in) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) sb.append(line);
        }
        return sb.toString();
    }

    private void postResultNotification(String title, String body) {
        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, launchIntent, piFlags);

        Notification notification = new NotificationCompat.Builder(this, RESULT_CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(R.drawable.ic_stat_keepalive)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build();

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(RESULT_NOTIFICATION_ID, notification);
        }
    }

    private void postUnreachableNotification() {
        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, launchIntent, piFlags);

        Notification notification = new NotificationCompat.Builder(this, RESULT_CHANNEL_ID)
            .setContentTitle("⚠ ComfyUI'ye ulaşılamıyor")
            .setContentText("Sunucu kapalı veya çökmüş olabilir. Bağlantı geri gelince üretim takibine devam edilecek.")
            .setSmallIcon(R.drawable.ic_stat_keepalive)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build();

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(UNREACHABLE_NOTIFICATION_ID, notification);
        }
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager == null) return;

            NotificationChannel keepAlive = new NotificationChannel(
                CHANNEL_ID,
                "Arka Plan Takibi",
                NotificationManager.IMPORTANCE_LOW
            );
            keepAlive.setDescription("Uygulama arka planda çalışırken gösterilen bildirim");
            manager.createNotificationChannel(keepAlive);

            NotificationChannel result = new NotificationChannel(
                RESULT_CHANNEL_ID,
                "Üretim Sonucu",
                NotificationManager.IMPORTANCE_HIGH
            );
            result.setDescription("Video üretimi tamamlandığında veya hata verdiğinde gösterilen bildirim");
            Uri soundUri = Uri.parse("android.resource://" + getPackageName() + "/raw/notification_sound");
            AudioAttributes audioAttributes = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
            result.setSound(soundUri, audioAttributes);
            manager.createNotificationChannel(result);

            // Deletes the pre-existing channel from earlier app versions —
            // otherwise it lingers forever as an unused duplicate "Üretim
            // Sonucu" entry in the system notification settings screen.
            manager.deleteNotificationChannel(LEGACY_RESULT_CHANNEL_ID);
        }
    }
}
