package com.emir.minimaxcontrol;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KeepAlivePlugin.class);
        registerPlugin(SaveMediaPlugin.class);
        super.onCreate(savedInstanceState);
        // For offline.html — see WakeOnLan.java for why this isn't a plugin.
        // Takes effect from the next page load, which is exactly when the
        // offline page appears (the WebView swaps to it after the PC fails).
        getBridge().getWebView().addJavascriptInterface(new WakeOnLan(), WakeOnLan.JS_NAME);
    }
}
