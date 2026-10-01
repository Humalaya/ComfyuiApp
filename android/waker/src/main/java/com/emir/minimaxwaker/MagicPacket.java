package com.emir.minimaxwaker;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;

// Wake-on-LAN "magic packet" — same format as the main app's WakeOnLan.java.
final class MagicPacket {

    // The PC's wired network card (enp6s0) and the home LAN's broadcast
    // address. If either changes, update these and rebuild this APK.
    static final String PC_MAC = "30:56:0f:5e:8e:52";
    static final String LAN_BROADCAST = "192.168.1.255";

    private static final int[] PORTS = {9, 7};
    // Wi-Fi drops the odd broadcast frame — a few repeats cost nothing.
    private static final int REPEATS = 3;

    private MagicPacket() {}

    static void send() throws Exception {
        byte[] mac = parseMac(PC_MAC);
        // 6 × 0xFF, then the MAC 16 times.
        byte[] packet = new byte[6 + 16 * 6];
        for (int i = 0; i < 6; i++) packet[i] = (byte) 0xFF;
        for (int i = 6; i < packet.length; i += 6) System.arraycopy(mac, 0, packet, i, 6);

        String[] targets = {LAN_BROADCAST, "255.255.255.255"};
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
    }

    private static byte[] parseMac(String mac) {
        String[] parts = mac.split("[:-]");
        byte[] out = new byte[6];
        for (int i = 0; i < 6; i++) out[i] = (byte) Integer.parseInt(parts[i], 16);
        return out;
    }
}
