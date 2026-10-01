package com.emir.minimaxwaker;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

// Restarts the relay after a reboot (power cut, system update) or an app
// update — it's meant to run unattended for weeks.
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        WakerService.start(context);
    }
}
