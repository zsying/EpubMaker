package com.wails.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.Nullable;

import org.json.JSONObject;

import java.lang.ref.WeakReference;

/**
 * A minimal started foreground service. It does no work of its own — its purpose
 * is to keep the app's process alive (with the required ongoing notification) so
 * the developer's Go goroutines keep running while the app is backgrounded,
 * which Android would otherwise be free to kill. Start it from
 * {@link WailsBridge#startForegroundService(String)} and stop it with
 * {@link WailsBridge#stopForegroundService()}.
 *
 * 听书 uses the same service, with {@code fgType=media}: it then also owns a
 * {@link MediaSession} and a MediaStyle notification, which together are what
 * turn this from "an app with a notification" into a media app — the shade, the
 * lock screen and a headset all get 上一句 / 播放 / 下一句, and the system stops
 * treating a long listening session as a background app to be trimmed.
 *
 * The buttons are not handled here: the reader owns the session (it knows which
 * sentence is being read and what "next" means), so a button press is forwarded
 * to it as {@code window.__epubListen('toggle')} and the answer comes back as a
 * now-playing record painted into the notification.
 */
public class WailsForegroundService extends android.app.Service {
    private static final String TAG = "EpubMakerFgs";

    public static final String ACTION_START = "com.wails.app.FGS_START";
    /** A media notification button was pressed. */
    public static final String ACTION_TOGGLE = "com.wails.app.LISTEN_TOGGLE";
    public static final String ACTION_PREV = "com.wails.app.LISTEN_PREV";
    public static final String ACTION_NEXT = "com.wails.app.LISTEN_NEXT";
    public static final String ACTION_CLOSE = "com.wails.app.LISTEN_CLOSE";

    private static final String CHANNEL_ID = "wails_foreground";
    private static final int NOTIFICATION_ID = 0x57A1; // "WAI"

    /** The live instance, so a now-playing record can reach the notification
     * without a startService round trip. */
    private static WeakReference<WailsForegroundService> live = new WeakReference<>(null);
    /** The last record the reader sent. Kept statically because the reader
     * publishes the first one in the same tick it asks for the service — before
     * this service exists — and that record is the one that names the chapter. */
    private static volatile String lastRecord;

    private final Handler main = new Handler(Looper.getMainLooper());
    private NotificationManager nm;
    private MediaSession session;
    /** True when this instance is the 听书 one (mediaPlayback + widget). */
    private boolean mediaMode;
    private boolean foreground;

    // What the last now-playing record said. Also what a re-delivered intent
    // (START_STICKY after a kill) would rebuild the notification from.
    private String title = "听书";
    private String text = "正在朗读，返回应用可继续";
    private boolean playing;
    private boolean canPrev = true;
    private boolean canNext = true;

    /* ------------------------------ lifecycle ------------------------------ */

    @Override
    public void onCreate() {
        super.onCreate();
        live = new WeakReference<>(this);
        nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_TOGGLE.equals(action) || ACTION_PREV.equals(action)
                || ACTION_NEXT.equals(action) || ACTION_CLOSE.equals(action)) {
            // A button press. The session stays exactly as it is until the
            // reader answers with a new record; nothing is guessed here.
            TtsBridge.dispatchCommand(
                    ACTION_TOGGLE.equals(action) ? "toggle"
                            : ACTION_PREV.equals(action) ? "prev"
                            : ACTION_NEXT.equals(action) ? "next" : "stop");
            return START_NOT_STICKY;
        }

        String fgType = null;
        if (intent != null) {
            if (intent.getStringExtra("title") != null) title = intent.getStringExtra("title");
            if (intent.getStringExtra("text") != null) text = intent.getStringExtra("text");
            fgType = intent.getStringExtra("fgType");
        }
        // A re-delivered intent (system restart) carries no extras: keep
        // whatever this instance already knew rather than resetting the widget.
        if (fgType != null) mediaMode = "media".equals(fgType);

        ensureChannel();
        if (mediaMode) ensureSession();

        Notification n = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // 听书 asks for mediaPlayback, which is the type Android uses to
            // decide an app may keep an audio stream alive; everything else
            // keeps the dataSync it shipped with.
            int type = mediaMode
                    ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                    : ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
            startForeground(NOTIFICATION_ID, n, type);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
        foreground = true;
        // The record the reader sent while this service was still starting.
        if (mediaMode && lastRecord != null) applyNowPlaying(lastRecord);
        // A media session that is killed with the process must not be restarted
        // empty: the reader that owns it is gone, so there is nothing to resume
        // and a stale notification would sit in the shade for ever.
        if (mediaMode) return START_NOT_STICKY;
        // Restart if the OS kills us while still wanted.
        return START_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        foreground = false;
        releaseSession();
        if (live.get() == this) live = new WeakReference<>(null);
        super.onDestroy();
    }

    /* --------------------------- now playing ------------------------------- */

    /** Called by {@link TtsBridge#setNowPlaying(String)} on the main thread.
     * `active:false` means the reader ended the session; the service is stopped
     * by the bridge itself, so there is nothing to paint. */
    static void postNowPlaying(Context context, String json) {
        if (json == null) return;
        lastRecord = json;
        WailsForegroundService self = live.get();
        if (self == null) return;
        self.main.post(() -> self.applyNowPlaying(json));
    }

    private void applyNowPlaying(String json) {
        try {
            JSONObject o = new JSONObject(json);
            if (!o.optBoolean("active", false)) {
                // The reader ended the session; the bridge stops the service.
                lastRecord = null;
                return;
            }
            title = o.optString("title", title);
            text = o.optString("artist", text);
            playing = o.optBoolean("playing", playing);
            canPrev = o.optBoolean("canPrev", true);
            canNext = o.optBoolean("canNext", true);
        } catch (Exception e) {
            Log.w(TAG, "bad now-playing record", e);
            return;
        }
        if (!mediaMode || !foreground) return;
        updateSessionState();
        try {
            nm.notify(NOTIFICATION_ID, buildNotification());
        } catch (Exception e) {
            Log.w(TAG, "notification update failed", e);
        }
    }

    /* ----------------------------- media session --------------------------- */

    private void ensureSession() {
        if (session != null || Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return;
        try {
            session = new MediaSession(this, "EpubMakerListen");
            session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS
                    | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
            session.setCallback(new MediaSession.Callback() {
                @Override public void onPlay() { TtsBridge.dispatchCommand("toggle"); }
                @Override public void onPause() { TtsBridge.dispatchCommand("toggle"); }
                @Override public void onStop() { TtsBridge.dispatchCommand("stop"); }
                @Override public void onSkipToNext() { TtsBridge.dispatchCommand("next"); }
                @Override public void onSkipToPrevious() { TtsBridge.dispatchCommand("prev"); }
            });
            session.setActive(true);
            updateSessionState();
        } catch (Exception e) {
            Log.w(TAG, "media session failed", e);
            session = null;
        }
    }

    private void updateSessionState() {
        if (session == null) return;
        try {
            long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
                    | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_STOP
                    | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                    | PlaybackState.ACTION_PLAY_FROM_MEDIA_ID;
            session.setPlaybackState(new PlaybackState.Builder()
                    .setActions(actions)
                    .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                            PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f)
                    .build());
            session.setMetadata(new MediaMetadata.Builder()
                    .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                    .putString(MediaMetadata.METADATA_KEY_ARTIST, text)
                    .putString(MediaMetadata.METADATA_KEY_ALBUM, text)
                    // 听书 has no track length: a chapter is a variable number of
                    // sentences and the reader is not counting them for us.
                    .putLong(MediaMetadata.METADATA_KEY_DURATION, -1)
                    .build());
        } catch (Exception e) {
            Log.w(TAG, "session state failed", e);
        }
    }

    private void releaseSession() {
        if (session == null) return;
        try {
            session.setActive(false);
            session.release();
        } catch (Exception e) {
            Log.w(TAG, "session release failed", e);
        }
        session = null;
    }

    /* ------------------------------ notification --------------------------- */

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || nm == null) return;
        NotificationChannel ch = nm.getNotificationChannel(CHANNEL_ID);
        if (ch == null) {
            ch = new NotificationChannel(CHANNEL_ID, "听书与后台任务",
                    NotificationManager.IMPORTANCE_LOW);
            // The widget is a control surface, not an alert.
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
    }

    private PendingIntent openApp() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) return null;
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        // A singleTask activity: this brings the running app forward instead of
        // building a second instance.
        return PendingIntent.getActivity(this, 0, launch, flags);
    }

    private PendingIntent button(String action) {
        Intent i = new Intent(this, WailsForegroundService.class);
        i.setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getService(this, action.hashCode(), i, flags);
    }

    @SuppressWarnings("deprecation")
    private Notification.Action action(int icon, String label, String action) {
        // Resource-based icons are what API 21/22 understand; Icon arrived in
        // 23. minSdk is 21, so both paths have to exist.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            return new Notification.Action.Builder(
                    Icon.createWithResource(this, icon), label, button(action)).build();
        }
        return new Notification.Action.Builder(icon, label, button(action)).build();
    }

    @SuppressWarnings("deprecation")
    private Notification buildNotification() {
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            b = new Notification.Builder(this, CHANNEL_ID);
        } else {
            b = new Notification.Builder(this);
        }
        b.setSmallIcon(R.drawable.ic_listen)
                .setContentTitle(title)
                .setContentText(text)
                .setContentIntent(openApp())
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOnlyAlertOnce(true)
                // A paused session can be swiped away; a playing one cannot be
                // dismissed while it is still talking.
                .setOngoing(playing && mediaMode);

        if (mediaMode && session != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            // Order matters: the first three are what the collapsed (compact)
            // view shows. 退出 is only reachable when the shade is expanded.
            b.addAction(action(android.R.drawable.ic_media_previous, "上一句", ACTION_PREV));
            b.addAction(action(
                    playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                    playing ? "暂停" : "继续", ACTION_TOGGLE));
            b.addAction(action(android.R.drawable.ic_media_next, "下一句", ACTION_NEXT));
            b.addAction(action(android.R.drawable.ic_menu_close_clear_cancel, "退出听书", ACTION_CLOSE));
            b.setStyle(new Notification.MediaStyle()
                    .setMediaSession(session.getSessionToken())
                    .setShowActionsInCompactView(0, 1, 2));
        }
        return b.build();
    }
}
