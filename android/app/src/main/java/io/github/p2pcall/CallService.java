package io.github.p2pcall;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Keeps the call alive while the app is not on screen: the "call in
 * progress" notification stops the system from putting the app (and with it
 * the call server and the microphone) to sleep.
 */
public class CallService extends Service {
    private static final String STOP = "io.github.p2pcall.STOP";
    private static final String CHANNEL = "call";
    static final String CAMERA = "camera";

    private PowerManager.WakeLock wake;
    private WifiManager.WifiLock wifi;

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Call", NotificationManager.IMPORTANCE_LOW);
        getSystemService(NotificationManager.class).createNotificationChannel(ch);

        wake = ((PowerManager) getSystemService(Context.POWER_SERVICE))
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "p2pcall:call");
        wake.acquire();
        wifi = ((WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE))
                .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "p2pcall:call");
        wifi.acquire();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) {
            end();
            return START_NOT_STICKY;
        }
        Notification n = notification();
        if (Build.VERSION.SDK_INT >= 30) {
            // While the camera is on, the call is declared as using it too:
            // otherwise the phone takes it away as soon as the app is left.
            boolean camera = intent != null && intent.getBooleanExtra(CAMERA, false)
                    && checkSelfPermission(android.Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED;
            try {
                startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                        | (camera ? ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA : 0));
            } catch (Exception e) {
                // The phone wouldn't have the camera part; the call itself must go on.
                try {
                    startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
                } catch (Exception ignored) {
                }
            }
        } else {
            startForeground(1, n);
        }
        return START_NOT_STICKY;
    }

    private Notification notification() {
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, CallService.class).setAction(STOP),
                PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_call)
                .setContentTitle("Call in progress")
                .setContentText("Tap to return to the call")
                .setOngoing(true)
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder((Icon) null, "End call", stop).build())
                .build();
    }

    private void end() {
        MainActivity.close();
        stopForeground(true);
        stopSelf();
    }

    /** Swiping the app away from the recent apps ends the call too. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        end();
    }

    @Override
    public void onDestroy() {
        if (wake.isHeld()) wake.release();
        if (wifi.isHeld()) wifi.release();
        MainActivity.stopServer();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
