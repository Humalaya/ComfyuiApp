package com.emir.minimaxcontrol;

import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import java.net.InetSocketAddress;
import java.net.Socket;

public class MainActivity extends BridgeActivity {

    // The app is served live from the PC (capacitor.config.ts server.url).
    // When the PC is asleep, the WebView's own load doesn't fail — it hangs
    // (over Tailscale especially, the connection attempt just gets no answer)
    // for a minute or more on a black screen before Capacitor's errorPath
    // page finally shows. So probe the server ourselves with a short
    // timeout and switch to the offline page (which has the wake button)
    // as soon as it's clearly unreachable.
    private static final int PROBE_TIMEOUT_MS = 2500;

    private boolean firstResume = true;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KeepAlivePlugin.class);
        registerPlugin(SaveMediaPlugin.class);
        super.onCreate(savedInstanceState);
        // For offline.html — see WakeOnLan.java for why this isn't a plugin.
        // Takes effect from the next page load, which is exactly when the
        // offline page appears (the WebView swaps to it after the PC fails).
        getBridge().getWebView().addJavascriptInterface(new WakeOnLan(), WakeOnLan.JS_NAME);
        probeServer(1);
    }

    @Override
    public void onResume() {
        super.onResume();
        // Coming back to an app page that was loaded while the PC was awake:
        // if it has since gone to sleep, show the wake page instead of a
        // page that can't load anything. Two tries, so a single dropped
        // packet on mobile data doesn't throw away the page.
        if (firstResume) firstResume = false;
        else probeServer(2);
    }

    private void probeServer(int attempts) {
        String serverUrl = getBridge().getServerUrl();
        String errorUrl = getBridge().getErrorUrl();
        if (serverUrl == null || errorUrl == null) return;
        Uri uri = Uri.parse(serverUrl);
        String host = uri.getHost();
        int port = uri.getPort() != -1 ? uri.getPort() : 80;

        new Thread(() -> {
            for (int i = 0; i < attempts; i++) {
                try (Socket socket = new Socket()) {
                    socket.connect(new InetSocketAddress(host, port), PROBE_TIMEOUT_MS);
                    return; // reachable — leave the WebView alone
                } catch (Exception ignored) {
                    // unreachable / timed out — try again or give up below
                }
            }
            runOnUiThread(() -> {
                WebView webView = getBridge().getWebView();
                if (errorUrl.equals(webView.getUrl())) return; // already showing it
                webView.stopLoading();
                webView.loadUrl(errorUrl);
            });
        }, "server-probe").start();
    }
}
