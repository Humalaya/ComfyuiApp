package com.emir.minimaxwaker;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.text.SimpleDateFormat;
import java.util.Collections;
import java.util.Date;
import java.util.Locale;

// Status screen + one-time setup (notification permission, battery
// optimization exemption). The actual work happens in WakerService, which
// this starts and which keeps running after the screen is closed.
public class MainActivity extends Activity {

    private TextView status;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable refresher = new Runnable() {
        @Override
        public void run() {
            refresh();
            handler.postDelayed(this, 2000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        WakerService.start(this);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        root.setPadding(pad, pad, pad, pad);
        root.setBackgroundColor(Color.parseColor("#0f1115"));

        TextView title = new TextView(this);
        title.setText("MiniMax Uyandırıcı");
        title.setTextColor(Color.WHITE);
        title.setTextSize(22);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);

        status = new TextView(this);
        status.setTextColor(Color.parseColor("#c9ced6"));
        status.setTextSize(15);
        status.setLineSpacing(0, 1.25f);
        status.setPadding(0, dp(12), 0, dp(16));
        root.addView(status);

        Button test = button("PC'yi şimdi uyandır (test)");
        test.setOnClickListener(v -> new Thread(() -> {
            String result;
            try {
                MagicPacket.send();
                result = "Uyandırma sinyali gönderildi.";
            } catch (Exception e) {
                result = "Gönderilemedi: " + e.getMessage();
            }
            String msg = result;
            handler.post(() -> android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_SHORT).show());
        }).start());
        root.addView(test);

        Button battery = button("Pil kısıtlamasını kaldır");
        battery.setOnClickListener(v -> requestBatteryExemption());
        root.addView(battery);

        Button appSettings = button("Uygulama ayarları (otomatik başlatma)");
        appSettings.setOnClickListener(v -> startActivity(
            new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))));
        root.addView(appSettings);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.parseColor("#0f1115"));
        scroll.addView(root);
        setContentView(scroll);
    }

    @Override
    protected void onResume() {
        super.onResume();
        handler.post(refresher);
    }

    @Override
    protected void onPause() {
        handler.removeCallbacks(refresher);
        super.onPause();
    }

    private void refresh() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        boolean exempt = Build.VERSION.SDK_INT < 23 || pm.isIgnoringBatteryOptimizations(getPackageName());
        StringBuilder sb = new StringBuilder();
        sb.append(WakerService.running ? "● Çalışıyor — port " + WakerService.PORT : "○ Başlatılıyor…").append("\n");
        sb.append("Pil kısıtlaması: ").append(exempt ? "kaldırıldı ✓" : "AÇIK — aşağıdan kaldır").append("\n\n");
        sb.append("Adresler:\n").append(addresses()).append("\n");
        sb.append("PC: ").append(MagicPacket.PC_MAC).append("\n");
        if (WakerService.lastWakeAt > 0) {
            String when = new SimpleDateFormat("dd.MM HH:mm:ss", Locale.getDefault()).format(new Date(WakerService.lastWakeAt));
            sb.append("\nSon uyandırma: ").append(when).append(" (").append(WakerService.lastWakeFrom).append(")")
                .append("\nToplam: ").append(WakerService.wakeCount);
        } else {
            sb.append("\nHenüz uyandırma isteği gelmedi.");
        }
        status.setText(sb.toString());
    }

    // Wi-Fi (192.168.x) and Tailscale (100.x) addresses — handy for checking
    // the phone is on the home network and on the tailnet.
    private String addresses() {
        StringBuilder sb = new StringBuilder();
        try {
            for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                for (InetAddress addr : Collections.list(nif.getInetAddresses())) {
                    if (addr instanceof Inet4Address) {
                        sb.append("  ").append(nif.getName()).append(": ").append(addr.getHostAddress()).append("\n");
                    }
                }
            }
        } catch (Exception e) {
            sb.append("  (okunamadı)\n");
        }
        return sb.length() > 0 ? sb.toString() : "  (ağ yok)\n";
    }

    private void requestBatteryExemption() {
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()));
            startActivity(intent);
        } catch (Exception e) {
            startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }
    }

    private Button button(String text) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(8);
        b.setLayoutParams(lp);
        b.setGravity(Gravity.CENTER);
        return b;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
