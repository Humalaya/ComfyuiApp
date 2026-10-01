package com.emir.minimaxcontrol;

import android.webkit.JavascriptInterface;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;

// Wakes the PC from sleep (or power-off, if its BIOS allows) with a
// Wake-on-LAN "magic packet". Called from offline.html — the page Capacitor
// shows when the PC (which serves this whole app) can't be reached — as
// window.WakeOnLan.wake(mac, broadcast).
//
// A plain addJavascriptInterface object rather than a Capacitor plugin on
// purpose: Capacitor serves that error page from its own internal origin
// (https://localhost/offline.html) and only injects its JS bridge into pages
// from the app's server URL, so a plugin is unreachable there. Interfaces
// added this way are visible to every page the WebView loads.
public class WakeOnLan {

    public static final String JS_NAME = "WakeOnLan";

    private static final int[] PORTS = {9, 7};
    // Wi-Fi drops the odd broadcast frame — a few repeats cost nothing.
    private static final int REPEATS = 3;

    // Runs on the WebView's JavaBridge thread (not the UI thread), so the
    // blocking network calls are fine. Returns "" on success, otherwise the
    // error message — JS interfaces can't throw into the page.
    @JavascriptInterface
    public String wake(String mac, String broadcast) {
        try {
            byte[] macBytes = parseMac(mac);
            // 6 × 0xFF, then the MAC 16 times.
            byte[] packet = new byte[6 + 16 * 6];
            for (int i = 0; i < 6; i++) packet[i] = (byte) 0xFF;
            for (int i = 6; i < packet.length; i += 6) System.arraycopy(macBytes, 0, packet, i, 6);

            String[] targets = {broadcast != null && !broadcast.isEmpty() ? broadcast : "255.255.255.255", "255.255.255.255"};
            try (DatagramSocket socket = new DatagramSocket()) {
                socket.setBroadcast(true);
                for (int r = 0; r < REPEATS; r++) {
                    for (String target : targets) {
                        InetAddress address = InetAddress.getByName(target);
                        for (int port : PORTS) socket.send(new DatagramPacket(packet, packet.length, address, port));
                    }
                    Thread.sleep(150);
                }
            }
            return "";
        } catch (Exception e) {
            return "Uyandırma sinyali gönderilemedi: " + e.getMessage();
        }
    }

    private static byte[] parseMac(String mac) {
        String[] parts = mac == null ? new String[0] : mac.split("[:-]");
        if (parts.length != 6) throw new IllegalArgumentException("Geçersiz MAC adresi: " + mac);
        byte[] out = new byte[6];
        for (int i = 0; i < 6; i++) out[i] = (byte) Integer.parseInt(parts[i], 16);
        return out;
    }
}
