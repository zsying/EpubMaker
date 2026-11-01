package com.wails.app;

import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.Locale;
import java.util.Set;

/**
 * 听书: speaks chapter text with the phone's own TTS engine.
 *
 * Why this exists at all: the Android WebView exposes the SpeechSynthesis API
 * but ships no voices, so the browser-side path that works on desktop is
 * silent here (see web/src/speech.ts). The only free, offline, unlimited
 * speech this device has is the system engine — 讯飞 / 华为 AI TTS on a
 * stock Chinese ROM — and reaching it means reaching it from Java.
 *
 * Shape of the contract with JS: the reader hands over ONE SENTENCE at a time
 * and keeps a lookahead window filled, so it stays in charge of paging and
 * highlighting. Progress comes back from the engine's own
 * UtteranceProgressListener, never from a JS timer — timers are throttled as
 * soon as the screen goes off, which is exactly when 听书 has to keep going.
 *
 * window.__epubTts({type, sid?, ...}) is the only event channel:
 *   ready  — the engine finished initialising, voices are now usable
 *   start  — sentence `sid` began speaking
 *   done   — sentence `sid` finished
 *   error  — sentence `sid` failed (code says why); `sid` is "" for init errors
 *   idle   — the engine ran out of queued speech (nothing left to read)
 */
public class TtsBridge {
    private static final String TAG = "EpubMakerTts";

    /** Utterance ids double as sentence ids, so the JS side can map a callback
     * back to an index without a second lookup table. */
    private final MainActivity activity;
    private final WebView webView;
    private final Handler main = new Handler(Looper.getMainLooper());

    /** Sentences parked while the engine is still initialising (~300ms).
     *
     * Bounded by characters, not by count: the reader hands the engine a whole
     * chapter at once, because the engine's queue is the only part of 听书 that
     * survives the screen going off (JS is throttled there). A 32-entry cap
     * silently dropped everything after the 32nd sentence, so the first listen
     * of a session read four minutes and then jumped to the next chapter. Half
     * a megabyte is a very long chapter of Chinese text, and nothing worth
     * worrying about in a 27 MB app. */
    private final ArrayDeque<String[]> pending = new ArrayDeque<>();
    private int pendingChars;
    private static final int PENDING_CHARS_MAX = 512 * 1024;

    private TextToSpeech tts;
    private boolean starting;
    private volatile boolean ready;
    /** Empty when the engine is fine; otherwise a stable code JS can explain. */
    private volatile String error = "";
    /** Utterances handed to the engine and not yet reported done/error. */
    private int inflight;
    private float rate = 1f;
    private String voiceName = "";
    private boolean focusHeld;
    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    /** The foreground service (and its notification) is up. */
    private boolean speakingSession;
    /** The reader still wants a session. It outlives a drained queue: between
     * the last sentence of one chapter and the first of the next the reader has
     * to fetch and render, and that gap must not be a window in which the app
     * drops focus and the service — which is exactly when the system would
     * decide the app is idle and freeze it. Only `clear()` (pause, exit, engine
     * switch) ends a session deliberately. */
    private boolean sessionActive;
    private PowerManager.WakeLock wakeLock;
    /** How long a session survives an empty queue before it is wound down on
     * its own, so a reader that died mid-chapter cannot strand a notification
     * and a wake lock. Long enough for a slow chapter fetch on a bad network. */
    private static final long DRAIN_GRACE_MS = 90_000;
    private final Runnable drainGrace = () -> {
        if (!sessionActive) return;
        sessionActive = false;
        abandonFocus();
        endSession();
    };
    /** The instance a notification button should reach. */
    private static volatile TtsBridge current;
    private final AudioManager.OnAudioFocusChangeListener focusListener = change -> {
        // A phone call or another player taking the stream: stop cleanly rather
        // than talk over it. JS sees `idle` and shows the bar as paused.
        if (change == AudioManager.AUDIOFOCUS_LOSS
                || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
            stopInternal("focus_lost");
        }
    };

    public TtsBridge(MainActivity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        this.audioManager = (AudioManager) activity.getSystemService(android.content.Context.AUDIO_SERVICE);
        current = this;
    }

    /** A control on the media notification / lock screen / headset was pressed.
     * The reader owns the session, so all this does is hand the button over. */
    static void dispatchCommand(String command) {
        TtsBridge self = current;
        if (self == null) return;
        self.main.post(() -> {
            WebView view = self.webView;
            if (view == null) return;
            try {
                view.evaluateJavascript(
                        "window.__epubListen&&window.__epubListen(" + JSONObject.quote(command) + ");",
                        null);
            } catch (Exception e) {
                Log.w(TAG, "dispatch " + command + " failed", e);
            }
        });
    }

    /** Engine state as JSON. Safe to call before init: reports what is known. */
    @JavascriptInterface
    public String status() {
        JSONObject o = new JSONObject();
        try {
            o.put("ready", ready);
            o.put("error", error);
            o.put("rate", rate);
            o.put("voice", voiceName);
        } catch (Exception ignored) {
        }
        return o.toString();
    }

    /** Starts the engine ahead of the first sentence, so the delay is not
     * charged to the reader's first tap. Safe to call repeatedly. */
    @JavascriptInterface
    public void prepare() {
        main.post(this::ensureEngine);
    }

    /**
     * Queues one sentence. `rate` is applied to the whole engine (the platform
     * has no per-utterance rate), which is fine because JS speaks at one rate.
     */
    @JavascriptInterface
    public void speak(final String sid, final String text, final float rate) {
        if (text == null || text.trim().isEmpty()) return;
        final String id = sid == null || sid.isEmpty() ? "u" + System.nanoTime() : sid;
        main.post(() -> {
            this.rate = rate > 0 ? rate : 1f;
            // Asking for speech is also asking for a session: it cancels a
            // grace that was running out between two chapters.
            sessionActive = true;
            main.removeCallbacks(drainGrace);
            if (!ready) {
                if (pendingChars + text.length() <= PENDING_CHARS_MAX) {
                    pending.add(new String[] { id, text });
                    pendingChars += text.length();
                }
                ensureEngine();
                return;
            }
            speakNow(id, text);
        });
    }

    /** What the media notification should show: `{active, playing, title,
     * artist, canPrev, canNext}`.
     *
     * This is also what owns the session, which is why it does more than paint
     * a notification. The phone's own engine and the online voice reach audio
     * by completely different roads — the first queues inside Android, the
     * second plays an <audio> element in the WebView — and only one of them
     * passes through this class. A session that existed only because `speak()`
     * had been called therefore did not exist at all for the online voice:
     * no foreground service, no wake lock, no media session, and with the
     * screen off that reader was an ordinary background app, which is exactly
     * the one thing a phone is allowed to freeze. The reader says "a session is
     * running" and both engines now get the same protection. */
    @JavascriptInterface
    public void setNowPlaying(final String json) {
        main.post(() -> {
            boolean active = true;
            try {
                active = new JSONObject(json).optBoolean("active", true);
            } catch (Exception ignored) {
            }
            main.removeCallbacks(drainGrace);
            sessionActive = active;
            if (active) {
                startSession();
            } else {
                endSession();
            }
            WailsForegroundService.postNowPlaying(activity, json);
        });
    }

    /** Stops everything and drops what is queued. Called on pause/exit. */
    @JavascriptInterface
    public void clear() {
        main.post(() -> stopInternal("clear"));
    }

    /** Voices the engine exposes, for a 音色 picker. Empty until initialised. */
    @JavascriptInterface
    public String voices() {
        JSONArray out = new JSONArray();
        if (!ready || tts == null) return out.toString();
        try {
            Set<Voice> vs = tts.getVoices();
            if (vs == null) return out.toString();
            for (Voice v : vs) {
                // Only Chinese voices: this reader speaks Chinese books, and the
                // list is otherwise dozens of unusable English/other locales.
                String tag = v.getLocale() == null ? "" : v.getLocale().toLanguageTag();
                if (!tag.toLowerCase(Locale.ROOT).startsWith("zh")) continue;
                JSONObject o = new JSONObject();
                o.put("name", v.getName());
                o.put("label", v.getName());
                o.put("locale", tag);
                o.put("quality", v.getQuality());
                o.put("latency", v.getLatency());
                out.put(o);
            }
        } catch (Exception e) {
            Log.w(TAG, "voices failed", e);
        }
        return out.toString();
    }

    /** Picks a voice by name ('' restores the engine default for zh-CN). */
    @JavascriptInterface
    public void setVoice(String name) {
        main.post(() -> {
            voiceName = name == null ? "" : name;
            if (!ready || tts == null) return;
            applyVoice();
        });
    }

    /** Releases the engine. The activity is going away. */
    @JavascriptInterface
    public void shutdown() {
        main.post(() -> {
            stopInternal("shutdown");
            if (tts != null) {
                tts.shutdown();
                tts = null;
            }
            ready = false;
            // A dead bridge must not answer a notification button.
            if (current == this) current = null;
        });
    }

    /* ------------------------------ internals ------------------------------ */

    private void ensureEngine() {
        if (ready || starting) return;
        starting = true;
        try {
            tts = new TextToSpeech(activity.getApplicationContext(), status -> main.post(() -> {
                starting = false;
                if (status != TextToSpeech.SUCCESS) {
                    error = "init_failed";
                    emit("error", "", error, null);
                    return;
                }
                int lang = tts.setLanguage(Locale.SIMPLIFIED_CHINESE);
                if (lang == TextToSpeech.LANG_MISSING_DATA
                        || lang == TextToSpeech.LANG_NOT_SUPPORTED) {
                    // Some engines only offer the device locale; try that before
                    // concluding the phone cannot read Chinese at all.
                    lang = tts.setLanguage(Locale.getDefault());
                }
                if (lang == TextToSpeech.LANG_MISSING_DATA
                        || lang == TextToSpeech.LANG_NOT_SUPPORTED) {
                    // Some ROMs ship the engine but no zh-CN data pack; say so
                    // instead of playing silence.
                    error = "no_zh_voice";
                    emit("error", "", error, null);
                    return;
                }
                tts.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build());
                tts.setOnUtteranceProgressListener(listener);
                if (!voiceName.isEmpty()) applyVoice();
                tts.setSpeechRate(rate);
                ready = true;
                error = "";
                emit("ready", "", null, null);
                drainPending();
            }));
        } catch (Exception e) {
            starting = false;
            error = "init_failed";
            Log.e(TAG, "TextToSpeech init failed", e);
            emit("error", "", error, null);
        }
    }

    private void applyVoice() {
        try {
            for (Voice v : tts.getVoices()) {
                if (v.getName().equals(voiceName)) {
                    tts.setVoice(v);
                    return;
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "setVoice failed", e);
        }
    }

    private void drainPending() {
        while (ready && !pending.isEmpty()) {
            String[] item = pending.poll();
            pendingChars -= item[1].length();
            speakNow(item[0], item[1]);
        }
        if (pendingChars < 0) pendingChars = 0;
    }

    private void speakNow(String id, String text) {
        if (tts == null) return;
        acquireFocus();
        startSession();
        tts.setSpeechRate(rate);
        Bundle params = new Bundle();
        int rc = tts.speak(text, TextToSpeech.QUEUE_ADD, params, id);
        if (rc == TextToSpeech.ERROR) {
            emit("error", id, "speak_failed", null);
            return;
        }
        inflight++;
    }

    private void stopInternal(String reason) {
        pending.clear();
        pendingChars = 0;
        inflight = 0;
        sessionActive = false;
        main.removeCallbacks(drainGrace);
        if (tts != null) {
            try {
                tts.stop();
            } catch (Exception e) {
                Log.w(TAG, "stop failed", e);
            }
        }
        abandonFocus();
        endSession();
        emit("idle", "", reason, null);
    }

    private final UtteranceProgressListener listener = new UtteranceProgressListener() {
        @Override
        public void onStart(String utteranceId) {
            // Every sentence refreshes the wake lock: it is held with a timeout
            // so a session that dies without a `clear` cannot strand it, and a
            // sentence starting is the one moment that proves we still need it.
            holdWakeLock();
            emit("start", utteranceId, null, null);
        }

        @Override
        public void onDone(String utteranceId) {
            finished(utteranceId, null);
        }

        @Override
        public void onError(String utteranceId) {
            finished(utteranceId, "engine_error");
        }

        // API 23+: also fires for a stop(), so `finished` must tolerate the
        // duplicate report an onDone + onStop pair can produce.
        @Override
        public void onStop(String utteranceId, boolean interrupted) {
            if (interrupted) return;
        }
    };

    private void finished(String utteranceId, String err) {
        if (err != null) {
            emit("error", utteranceId, err, null);
        } else {
            emit("done", utteranceId, null, null);
        }
        if (inflight > 0) inflight--;
        if (inflight == 0 && pending.isEmpty()) {
            // The queue ran dry, but the reader has not asked to stop: what
            // comes next is a chapter fetch and a re-render, and the process has
            // to stay awake and foreground through it. Dropping focus and the
            // service here (the old behaviour) meant the system could freeze us
            // in exactly the gap the next chapter had to be loaded in.
            if (sessionActive) main.postDelayed(drainGrace, DRAIN_GRACE_MS);
            emit("idle", "", "drained", null);
        }
    }

    /* --------------------------- audio focus / FGS -------------------------- */

    private void acquireFocus() {
        if (focusHeld || audioManager == null) return;
        int r;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focusRequest == null) {
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_MEDIA)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                .build())
                        .setOnAudioFocusChangeListener(focusListener)
                        .build();
            }
            r = audioManager.requestAudioFocus(focusRequest);
        } else {
            r = audioManager.requestAudioFocus(focusListener,
                    AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }
        focusHeld = r == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }

    private void abandonFocus() {
        if (!focusHeld || audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusRequest != null) {
            audioManager.abandonAudioFocusRequest(focusRequest);
        } else {
            audioManager.abandonAudioFocus(focusListener);
        }
        focusHeld = false;
    }

    /** Keeps the process alive (and the notification honest) while reading
     * continues with the screen off. Reused WailsForegroundService, which now
     * also carries the media session and the notification's buttons. */
    private void startSession() {
        holdWakeLock();
        if (speakingSession) return;
        speakingSession = true;
        askForNotificationPermission();
        try {
            Intent i = new Intent(activity, WailsForegroundService.class);
            i.setAction(WailsForegroundService.ACTION_START);
            i.putExtra("title", "听书");
            i.putExtra("text", "正在朗读，返回应用可继续");
            i.putExtra("fgType", "media");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                activity.startForegroundService(i);
            } else {
                activity.startService(i);
            }
        } catch (Exception e) {
            Log.w(TAG, "start FGS failed", e);
        }
    }

    /**
     * Holds the CPU awake for the session.
     *
     * The engine's own playback keeps the device from deep sleep while a
     * sentence is sounding, but 听书 also has to survive the silences — between
     * sentences while the next chapter is fetched, and across a chapter
     * boundary, which is a zip read, an HTML render and a re-measure. Those are
     * exactly the moments a suspended CPU turns "reading" into "stopped".
     *
     * Timeout, not an open-ended acquire: it is refreshed on every sentence
     * start, so a session that ends without a clean `clear` (a ROM killing the
     * page, a crash) cannot leave a wake lock behind.
     */
    private void holdWakeLock() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) activity.getSystemService(android.content.Context.POWER_SERVICE);
                if (pm == null) return;
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "epubmaker:listen");
                wakeLock.setReferenceCounted(false);
            }
            // Refreshing an already-held lock is cheap and extends the timeout.
            wakeLock.acquire(10 * 60 * 1000L);
        } catch (Exception e) {
            Log.w(TAG, "wake lock failed", e);
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception e) {
            Log.w(TAG, "wake lock release failed", e);
        }
    }

    /** Android 13+: without it the media notification may never be shown, and
     * an invisible foreground service is one a ROM is free to trim. */
    private void askForNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return;
        try {
            if (activity.checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                activity.requestPermissions(
                        new String[] { "android.permission.POST_NOTIFICATIONS" }, 7020);
            }
        } catch (Exception e) {
            Log.w(TAG, "notification permission request failed", e);
        }
    }

    private void endSession() {
        main.removeCallbacks(drainGrace);
        releaseWakeLock();
        if (!speakingSession) return;
        speakingSession = false;
        try {
            activity.stopService(new Intent(activity, WailsForegroundService.class));
        } catch (Exception e) {
            Log.w(TAG, "stop FGS failed", e);
        }
    }

    /* --------------------------------- events -------------------------------- */

    private void emit(String type, String sid, String code, JSONObject extra) {
        if (webView == null) return;
        try {
            JSONObject o = new JSONObject();
            o.put("type", type);
            if (sid != null) o.put("sid", sid);
            if (code != null) o.put("code", code);
            if (extra != null) o.put("extra", extra);
            final String js = "window.__epubTts&&window.__epubTts(" + o + ");";
            main.post(() -> {
                try {
                    webView.evaluateJavascript(js, null);
                } catch (Exception ignored) {
                }
            });
        } catch (Exception e) {
            Log.w(TAG, "emit failed", e);
        }
    }
}
