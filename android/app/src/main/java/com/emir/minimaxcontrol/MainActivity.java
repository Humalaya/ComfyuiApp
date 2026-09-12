package com.emir.minimaxcontrol;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KeepAlivePlugin.class);
        registerPlugin(SaveMediaPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
