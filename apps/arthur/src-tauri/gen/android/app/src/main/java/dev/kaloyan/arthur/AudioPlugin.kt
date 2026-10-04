package dev.kaloyan.arthur

import android.Manifest
import android.app.Activity
import android.media.MediaRecorder
import android.os.Build
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class StartRecordingArgs {
    lateinit var path: String
}

/**
 * Minimal microphone recorder driven by the Rust `AndroidRecorder`.
 *
 * - Records AAC/m4a (16 kHz mono) to a file the Rust side chose inside the app cache directory.
 * - Asks for RECORD_AUDIO only when recording is started.
 * - Never records in the background: if the activity pauses, the recording is discarded.
 * - Rejects with the codes in packages/contracts/capture.ts (VOICE_CAPTURE_ERROR_CODES).
 *
 * Audio is transient. Deleting the file after transcription is the Rust side's job;
 * this class only deletes audio it discards itself.
 */
@TauriPlugin(
    permissions = [Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone")]
)
class AudioPlugin(private val activity: Activity) : Plugin(activity) {
    private val lock = Any()
    private var recorder: MediaRecorder? = null
    private var file: File? = null
    private var interrupted = false

    @Command
    fun startRecording(invoke: Invoke) {
        if (getPermissionState(MICROPHONE) == PermissionState.GRANTED) {
            begin(invoke)
        } else {
            requestPermissionForAlias(MICROPHONE, invoke, "onMicrophonePermissionResult")
        }
    }

    @PermissionCallback
    fun onMicrophonePermissionResult(invoke: Invoke) {
        if (getPermissionState(MICROPHONE) == PermissionState.GRANTED) {
            begin(invoke)
        } else {
            invoke.reject("Microphone permission denied", "microphone_permission_denied")
        }
    }

    @Command
    fun stopRecording(invoke: Invoke) {
        synchronized(lock) {
            val active = recorder
            if (active == null) {
                if (interrupted) {
                    interrupted = false
                    invoke.reject("Recording was interrupted", "recording_interrupted")
                } else {
                    invoke.reject("Not recording", "not_recording")
                }
                return
            }
            try {
                active.stop()
                release()
                invoke.resolve()
            } catch (e: RuntimeException) {
                // Thrown when no valid audio was captured (for example an immediate stop).
                discard()
                invoke.reject("Recording failed", "recording_failed", e)
            }
        }
    }

    @Command
    fun cancelRecording(invoke: Invoke) {
        synchronized(lock) {
            interrupted = false
            discard()
        }
        invoke.resolve()
    }

    /** No background recording: leaving the foreground discards the recording. */
    override fun onPause() {
        synchronized(lock) {
            if (recorder != null) {
                discard()
                interrupted = true
            }
        }
    }

    override fun onDestroy() {
        synchronized(lock) { discard() }
    }

    private fun begin(invoke: Invoke) {
        synchronized(lock) {
            if (recorder != null) {
                invoke.reject("Already recording", "already_recording")
                return
            }
            try {
                val target = resolveInsideCache(invoke.parseArgs(StartRecordingArgs::class.java).path)
                val active = newRecorder()
                active.setAudioSource(MediaRecorder.AudioSource.MIC)
                active.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                active.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                active.setAudioChannels(1)
                active.setAudioSamplingRate(SAMPLE_RATE_HZ)
                active.setAudioEncodingBitRate(BIT_RATE)
                active.setMaxDuration(MAX_DURATION_MS)
                active.setOutputFile(target.path)
                // Assign before prepare/start so a failure below releases it.
                recorder = active
                file = target
                interrupted = false
                active.prepare()
                active.start()
                invoke.resolve()
            } catch (e: Exception) {
                discard()
                invoke.reject("Recording failed", "recording_failed", e)
            }
        }
    }

    /** The recording path must stay inside the app's private cache directory. */
    private fun resolveInsideCache(path: String): File {
        val cacheRoot = activity.cacheDir.canonicalFile
        val target = File(path).canonicalFile
        require(target.path.startsWith(cacheRoot.path + File.separator)) { "path is outside the cache directory" }
        return target
    }

    @Suppress("DEPRECATION")
    private fun newRecorder(): MediaRecorder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(activity) else MediaRecorder()

    private fun release() {
        try {
            recorder?.release()
        } catch (_: RuntimeException) {
        }
        recorder = null
        file = null
    }

    /** Stops without keeping anything: releases the recorder and deletes its file. */
    private fun discard() {
        val active = recorder
        val target = file
        if (active != null) {
            try {
                active.stop()
            } catch (_: RuntimeException) {
            }
        }
        release()
        target?.delete()
    }

    private companion object {
        const val MICROPHONE = "microphone"
        const val SAMPLE_RATE_HZ = 16_000
        const val BIT_RATE = 64_000
        /** Matches the 120 s cap of the existing cloud STT provider. */
        const val MAX_DURATION_MS = 120_000
    }
}
