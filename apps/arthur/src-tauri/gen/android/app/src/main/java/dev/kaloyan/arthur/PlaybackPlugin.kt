package dev.kaloyan.arthur

import android.app.Activity
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class PlayFileArgs {
    lateinit var path: String
}

/**
 * Plays ONE transient speech file at a time for the Rust `AndroidPlayer`. It knows nothing about text, providers or credentials.
 *
 * - `startPlayback` prepares the file, takes transient audio focus and starts; it resolves when audio is audible.
 * - `awaitPlayback` resolves when playback ends: `cancelled:false` when it finished, `cancelled:true` when it was stopped.
 * - `stopPlayback` stops, releases the player and abandons audio focus. It is safe to call when nothing is playing.
 * - Losing audio focus (a call, another app's media) or leaving the foreground stops playback; Arthur never keeps talking behind
 *   the user's back, and it never holds focus or a MediaPlayer after the audio ends.
 * - Only files inside the app cache directory are played.
 *
 * Reachable from Rust only (these are not Tauri commands), so the webview cannot make the device play arbitrary files.
 */
@TauriPlugin
class PlaybackPlugin(private val activity: Activity) : Plugin(activity) {
    private val main = Handler(Looper.getMainLooper())
    private val lock = Any()
    private var player: MediaPlayer? = null
    private var waiter: Invoke? = null
    private var started = false
    /** How playback ended before anyone was waiting: null = still playing, else (cancelled, failed). */
    private var ended: Pair<Boolean, Boolean>? = null
    private var focus: AudioFocusRequest? = null

    private val audio get() = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    @Command
    fun startPlayback(invoke: Invoke) {
        val args = invoke.parseArgs(PlayFileArgs::class.java)
        main.post {
            end(cancelled = true, failed = false)
            val file = File(args.path)
            if (!insideCache(file)) {
                invoke.reject("playback_failed", "playback_failed")
                return@post
            }
            val began = SystemClock.elapsedRealtime()
            val created = MediaPlayer()
            synchronized(lock) {
                player = created
                started = false
                ended = null
            }
            try {
                created.setAudioAttributes(
                    AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
                )
                created.setDataSource(file.absolutePath)
                created.setOnCompletionListener { end(cancelled = false, failed = false) }
                created.setOnErrorListener { _, _, _ ->
                    val wasStarted = synchronized(lock) { started }
                    end(cancelled = false, failed = true)
                    if (!wasStarted) invoke.reject("playback_failed", "playback_failed")
                    true
                }
                created.setOnPreparedListener { prepared ->
                    if (!takeFocus()) {
                        end(cancelled = true, failed = false)
                        invoke.reject("playback_failed", "playback_failed")
                        return@setOnPreparedListener
                    }
                    synchronized(lock) { if (player !== prepared) return@setOnPreparedListener }
                    prepared.start()
                    synchronized(lock) { started = true }
                    val result = JSObject()
                    result.put("prepareMs", SystemClock.elapsedRealtime() - began)
                    invoke.resolve(result)
                }
                created.prepareAsync()
            } catch (e: Exception) {
                end(cancelled = false, failed = true)
                invoke.reject("playback_failed", "playback_failed")
            }
        }
    }

    @Command
    fun awaitPlayback(invoke: Invoke) {
        synchronized(lock) {
            val done = ended
            when {
                done != null -> {
                    ended = null
                    settle(invoke, done.first, done.second)
                }
                player == null -> settle(invoke, cancelled = true, failed = false)
                else -> waiter = invoke
            }
        }
    }

    @Command
    fun stopPlayback(invoke: Invoke) {
        main.post {
            end(cancelled = true, failed = false)
            invoke.resolve(JSObject())
        }
    }

    /** No background speech: leaving the foreground stops it. */
    override fun onPause() {
        main.post { end(cancelled = true, failed = false) }
    }

    override fun onDestroy() {
        main.post { end(cancelled = true, failed = false) }
    }

    private fun takeFocus(): Boolean {
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setOnAudioFocusChangeListener { change ->
                if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) {
                    main.post { end(cancelled = true, failed = false) }
                }
            }
            .build()
        focus = request
        return audio.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    /** Stops and releases everything, gives up focus, and tells whoever is waiting how it ended. Idempotent. */
    private fun end(cancelled: Boolean, failed: Boolean) {
        val toSettle: Invoke?
        synchronized(lock) {
            val current = player ?: return
            player = null
            try {
                if (current.isPlaying) current.stop()
            } catch (_: Exception) {
            }
            current.release()
            focus?.let { audio.abandonAudioFocusRequest(it) }
            focus = null
            toSettle = waiter
            waiter = null
            if (toSettle == null) ended = Pair(cancelled, failed)
        }
        toSettle?.let { settle(it, cancelled, failed) }
    }

    private fun settle(invoke: Invoke, cancelled: Boolean, failed: Boolean) {
        if (failed) {
            invoke.reject("playback_failed", "playback_failed")
        } else {
            val result = JSObject()
            result.put("cancelled", cancelled)
            invoke.resolve(result)
        }
    }

    private fun insideCache(file: File): Boolean = try {
        file.canonicalPath.startsWith(activity.cacheDir.canonicalPath + File.separator)
    } catch (e: Exception) {
        false
    }
}
