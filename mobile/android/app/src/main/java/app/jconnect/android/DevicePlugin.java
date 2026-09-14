package app.jconnect.android;

import android.app.UiModeManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.net.wifi.WifiManager;
import android.webkit.WebSettings;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;

// What the web client can't find out by itself: whether this device is a TV, and which JConnect computers are
// announcing themselves on the local network.
@CapacitorPlugin(name = "JConnectDevice")
public class DevicePlugin extends Plugin {

    private static final int DISCOVERY_PORT = 47802;
    private static final int MAX_MESSAGES = 64;

    private boolean television;

    @Override
    public void load() {
        Context context = getContext();
        PackageManager packages = context.getPackageManager();
        UiModeManager uiMode = (UiModeManager) context.getSystemService(Context.UI_MODE_SERVICE);
        // Some TV boxes don't report TV mode, but none of them has a touchscreen.
        television =
            (uiMode != null && uiMode.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION) ||
            packages.hasSystemFeature(PackageManager.FEATURE_LEANBACK) ||
            !packages.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN);
        // Plugins load before the page, so the web client can see this before it draws anything.
        if (television) {
            WebSettings settings = getBridge().getWebView().getSettings();
            settings.setUserAgentString(settings.getUserAgentString() + " JConnectTV");
        }
    }

    @PluginMethod
    public void info(PluginCall call) {
        JSObject result = new JSObject();
        result.put("television", television);
        result.put("camera", getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY));
        call.resolve(result);
    }

    // Listens for JConnect announcements for a few seconds. Each comes back with the address it came from; the web
    // client checks them, because anything on the network can send one.
    @PluginMethod
    public void listen(PluginCall call) {
        final int ms = Math.max(500, Math.min(call.getInt("ms", 4500), 10000));
        new Thread(() -> {
            WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            WifiManager.MulticastLock lock = null;
            try {
                // Many devices drop broadcast packets on Wi-Fi unless an app holds this lock.
                if (wifi != null) {
                    lock = wifi.createMulticastLock("jconnect-discovery");
                    lock.setReferenceCounted(false);
                    lock.acquire();
                }
                JSArray messages = new JSArray();
                try (DatagramSocket socket = new DatagramSocket(null)) {
                    socket.setReuseAddress(true);
                    socket.setBroadcast(true);
                    socket.bind(new InetSocketAddress(DISCOVERY_PORT));
                    byte[] buffer = new byte[4096];
                    long end = System.currentTimeMillis() + ms;
                    while (messages.length() < MAX_MESSAGES) {
                        long left = end - System.currentTimeMillis();
                        if (left <= 0) break;
                        socket.setSoTimeout((int) left);
                        DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                        try {
                            socket.receive(packet);
                        } catch (SocketTimeoutException timedOut) {
                            break;
                        }
                        JSObject message = new JSObject();
                        message.put("address", packet.getAddress().getHostAddress());
                        message.put("text", new String(packet.getData(), packet.getOffset(), packet.getLength(), StandardCharsets.UTF_8));
                        messages.put(message);
                    }
                }
                JSObject result = new JSObject();
                result.put("messages", messages);
                call.resolve(result);
            } catch (Exception err) {
                call.reject("Couldn't listen on the network: " + err.getMessage());
            } finally {
                if (lock != null && lock.isHeld()) lock.release();
            }
        }).start();
    }
}
