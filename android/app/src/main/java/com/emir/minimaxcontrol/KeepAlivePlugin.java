package com.emir.minimaxcontrol;

import android.content.Intent;
import android.os.Build;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

// JS-facing bridge for KeepAliveService — called from the web app right
// before a generation is queued, and again once it's done/cancelled/errored,
// so the foreground service (and its notification) only exists while
// there's actually something worth surviving a screen lock for.
@CapacitorPlugin(
    name = "KeepAlive",
    permissions = { @Permission(strings = { android.Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") }
)
public class KeepAlivePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "startAfterPermission");
            return;
        }
        startServiceInternal(call);
    }

    @PermissionCallback
    private void startAfterPermission(PluginCall call) {
        // Proceed either way — without POST_NOTIFICATIONS the foreground
        // service still runs (and still keeps the app alive), it just can't
        // show its notification.
        startServiceInternal(call);
    }

    private void startServiceInternal(PluginCall call) {
        Intent intent = new Intent(getContext(), KeepAliveService.class);
        // Optional — present once the queued prompt's id is known, so the
        // service can poll ComfyUI's /history directly and notify on its
        // own even if the WebView's JS gets frozen while backgrounded.
        String comfyBaseUrl = call.getString("comfyBaseUrl");
        String promptId = call.getString("promptId");
        String videoNodeId = call.getString("videoNodeId");
        if (comfyBaseUrl != null) intent.putExtra("comfyBaseUrl", comfyBaseUrl);
        if (promptId != null) intent.putExtra("promptId", promptId);
        if (videoNodeId != null) intent.putExtra("videoNodeId", videoNodeId);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), KeepAliveService.class));
        call.resolve();
    }
}
