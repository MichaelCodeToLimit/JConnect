package app.jconnect.android;

import android.app.UiModeManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.provider.Settings;
import android.webkit.WebSettings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONObject;

// What the web client can't do by itself: find out whether this device is a TV, hear which JConnect computers are
// announcing themselves on the local network, and update the app from JConnect's website.
@CapacitorPlugin(name = "JConnectDevice")
public class DevicePlugin extends Plugin {

    private static final int DISCOVERY_PORT = 47802;
    private static final int MAX_MESSAGES = 64;

    // Updates only ever come from here. The web client can't point them anywhere else.
    private static final String UPDATE_BASE = "https://jconnect-1dsx.onrender.com/download/";
    private static final String UPDATE_FILE = "JConnect-Android.apk";
    private static final long MIN_UPDATE_SIZE = 1024L * 1024;
    private static final long MAX_UPDATE_SIZE = 512L * 1024 * 1024;

    private boolean television;
    private JSObject update; // the newer version the website describes: version, sha256, size
    private File updateApk; // that version, downloaded and checked

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

    // ---------- updates ----------

    // Reads <apk>.json from the website (written by scripts/update-info.js) and compares its versionCode with this app's.
    @PluginMethod
    public void checkUpdate(PluginCall call) {
        new Thread(() -> {
            try {
                JSONObject info = new JSONObject(fetchText(UPDATE_BASE + UPDATE_FILE + ".json", 64 * 1024));
                String version = info.optString("version");
                String sha256 = info.optString("sha256");
                long size = info.optLong("size", -1);
                long versionCode = info.optLong("versionCode", -1);
                boolean usable =
                    "jconnect".equals(info.optString("app")) &&
                    UPDATE_FILE.equals(info.optString("file")) &&
                    version.matches("\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?") &&
                    sha256.matches("[0-9a-f]{64}") &&
                    size >= MIN_UPDATE_SIZE &&
                    size <= MAX_UPDATE_SIZE &&
                    versionCode > 0;
                if (!usable) {
                    call.reject("The update description is unusable");
                    return;
                }
                PackageInfo installed = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
                long currentCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? installed.getLongVersionCode() : installed.versionCode;
                boolean newer = versionCode > currentCode;
                synchronized (this) {
                    if (!newer) {
                        update = null;
                        updateApk = null;
                    } else if (update == null || !sha256.equals(update.getString("sha256"))) {
                        update = new JSObject();
                        update.put("version", version);
                        update.put("sha256", sha256);
                        update.put("size", size);
                        updateApk = null;
                    }
                }
                JSObject result = new JSObject();
                result.put("current", installed.versionName);
                result.put("available", newer);
                result.put("version", version);
                result.put("size", size);
                call.resolve(result);
            } catch (Exception err) {
                call.reject("Couldn't check for updates: " + err.getMessage());
            }
        }).start();
    }

    // Downloads the APK from the last check. It's only kept with exactly the published size and SHA-256.
    @PluginMethod
    public void downloadUpdate(PluginCall call) {
        final JSObject next;
        synchronized (this) {
            next = update;
        }
        if (next == null) {
            call.reject("No update to download");
            return;
        }
        new Thread(() -> {
            File dir = new File(getContext().getCacheDir(), "updates");
            File part = new File(dir, UPDATE_FILE + ".part");
            File apk = new File(dir, UPDATE_FILE);
            try {
                long size = next.getLong("size");
                String sha256 = next.getString("sha256");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("no folder for the download");
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long received = 0;
                int reported = -1;
                HttpURLConnection connection = open(UPDATE_BASE + UPDATE_FILE);
                try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                    byte[] buffer = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buffer)) != -1) {
                        received += n;
                        if (received > size) throw new Exception("the download is larger than announced");
                        digest.update(buffer, 0, n);
                        out.write(buffer, 0, n);
                        int percent = (int) (received * 100 / size);
                        if (percent != reported) {
                            reported = percent;
                            JSObject progress = new JSObject();
                            progress.put("progress", received / (double) size);
                            notifyListeners("updateProgress", progress);
                        }
                    }
                } finally {
                    connection.disconnect();
                }
                if (received != size || !sha256.equals(hex(digest.digest()))) {
                    part.delete();
                    call.reject("The download doesn't match the update's SHA-256");
                    return;
                }
                if (apk.exists() && !apk.delete()) throw new Exception("couldn't replace an earlier download");
                if (!part.renameTo(apk)) throw new Exception("couldn't keep the download");
                synchronized (this) {
                    if (update == next) updateApk = apk;
                }
                call.resolve();
            } catch (Exception err) {
                part.delete();
                call.reject("Couldn't download the update: " + err.getMessage());
            }
        }).start();
    }

    // Hands the downloaded APK to Android's installer. The first time, Android asks to allow JConnect to install apps.
    @PluginMethod
    public void installUpdate(PluginCall call) {
        File apk;
        synchronized (this) {
            apk = updateApk;
        }
        if (apk == null || !apk.isFile()) {
            call.reject("No downloaded update");
            return;
        }
        Context context = getContext();
        JSObject result = new JSObject();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.getPackageManager().canRequestPackageInstalls()) {
                Intent allow = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName()));
                allow.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(allow);
                result.put("needsPermission", true);
                call.resolve(result);
                return;
            }
            Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", apk);
            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(uri, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(install);
            result.put("started", true);
            call.resolve(result);
        } catch (Exception err) {
            call.reject("Couldn't open the installer: " + err.getMessage());
        }
    }

    private static HttpURLConnection open(String url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        connection.setUseCaches(false);
        int status = connection.getResponseCode();
        if (status != 200) {
            connection.disconnect();
            throw new Exception("HTTP " + status);
        }
        return connection;
    }

    private static String fetchText(String url, int maxBytes) throws Exception {
        HttpURLConnection connection = open(url);
        try (InputStream in = connection.getInputStream()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int n;
            while ((n = in.read(buffer)) != -1) {
                out.write(buffer, 0, n);
                if (out.size() > maxBytes) throw new Exception("the update description is too large");
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            connection.disconnect();
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(String.format("%02x", b));
        return out.toString();
    }
}
