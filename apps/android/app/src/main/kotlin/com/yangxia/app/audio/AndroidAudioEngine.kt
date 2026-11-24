package com.yangxia.app.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.Closeable
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors
import java.util.zip.GZIPInputStream
import kotlin.math.max
import kotlin.math.min

@Serializable
private data class AudioManifestEntry(
    val offsetSamples: Int,
    val lengthSamples: Int,
    val category: String,
)

@Serializable
private data class AudioManifest(
    val sampleRate: Int = 22050,
    val entries: Map<String, AudioManifestEntry> = emptyMap(),
)

/**
 * 架构 6.4 音频焦点防抖管理器：
 * - 申请 AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK 压低外部音乐；
 * - 带有 350ms 释放防抖尾窗，杜绝 1 秒一次报数节拍导致外部音乐反复抽搐。
 */
class AudioFocusHelper(context: Context) {
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val handler = Handler(Looper.getMainLooper())
    private var holdingFocus = false
    private val focusRequest: AudioFocusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
        )
        .setAcceptsDelayedFocusGain(false)
        .setOnAudioFocusChangeListener { }
        .build()

    private val releaseRunnable = Runnable {
        if (holdingFocus) {
            runCatching { audioManager.abandonAudioFocusRequest(focusRequest) }
            holdingFocus = false
        }
    }

    fun requestDuckFor(durationMs: Long) {
        handler.removeCallbacks(releaseRunnable)
        if (!holdingFocus) {
            val res = runCatching { audioManager.requestAudioFocus(focusRequest) }.getOrDefault(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
            holdingFocus = (res == AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
        }
        // 350ms 防抖尾窗：连续节拍期间维持压低状态不反复释放
        handler.postDelayed(releaseRunnable, max(200L, durationMs) + 350L)
    }

    fun abandonNow() {
        handler.removeCallbacks(releaseRunnable)
        if (holdingFocus) {
            runCatching { audioManager.abandonAudioFocusRequest(focusRequest) }
            holdingFocus = false
        }
    }
}

/**
 * 架构 6.4 离线音效 + 27 词元兜底语音 + 系统中文 TTS 融合播报引擎：
 * - 启动一次解压 assets/audio/audio_pcm.gz 到内存 ShortArray（约 613 KB），播报零磁盘 I/O；
 * - 离线兜底采用 12ms 余弦交叉淡化拼接与高 BPM 采样率倍率加速，新语音到达立即打断旧语音防叠音；
 * - 系统 TTS 播报前强制 `text.replace("，", "")`，自动检测中文发音人并支持错误/超时降级与手动切换离线兜底。
 */
class AndroidAudioEngine(context: Context) : Closeable {

    private val appContext = context.applicationContext
    private val focusHelper = AudioFocusHelper(appContext)
    private val voiceExecutor = Executors.newSingleThreadExecutor { r -> Thread(r, "yangxia-voice").apply { isDaemon = true } }
    private val cueExecutor = Executors.newSingleThreadExecutor { r -> Thread(r, "yangxia-cue").apply { isDaemon = true } }

    @Volatile private var sampleRate = OfflineAudioMixer.DEFAULT_SAMPLE_RATE
    @Volatile private var clips: Map<String, ShortArray> = emptyMap()
    @Volatile private var activeVoiceTrack: AudioTrack? = null

    val loadedClipCount: Int get() = clips.size

    @Volatile private var tts: TextToSpeech? = null
    @Volatile var ttsChineseAvailable: Boolean = false
        private set

    private val vibrator: Vibrator? = runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (appContext.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            appContext.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }.getOrNull()

    init {
        loadAudioAssets()
        initTts()
    }

    private fun loadAudioAssets() {
        runCatching {
            val json = Json { ignoreUnknownKeys = true }
            val manifestText = appContext.assets.open("audio/audio_manifest.json").bufferedReader().use { it.readText() }
            val manifest = json.decodeFromString(AudioManifest.serializer(), manifestText)
            // Android aapt2 会自动将 assets 中的 .gz 解压并去掉后缀（assets/audio/audio_pcm）；同时兼容保留 .gz 的环境
            val assetBytes = runCatching {
                appContext.assets.open("audio/audio_pcm").use { it.readBytes() }
            }.getOrElse {
                appContext.assets.open("audio/audio_pcm.gz").use { it.readBytes() }
            }
            val rawBytes = if (assetBytes.size >= 2 && assetBytes[0] == 0x1f.toByte() && assetBytes[1] == 0x8b.toByte()) {
                GZIPInputStream(assetBytes.inputStream()).use { it.readBytes() }
            } else {
                assetBytes
            }
            val decoded = HashMap<String, ShortArray>(manifest.entries.size)
            for ((id, entry) in manifest.entries) {
                decoded[id] = OfflineAudioMixer.decodeLittleEndianPcm16(rawBytes, entry.offsetSamples, entry.lengthSamples)
            }
            sampleRate = manifest.sampleRate
            clips = decoded
        }
    }

    private fun initTts() {
        runCatching {
            tts = TextToSpeech(appContext) { status ->
                if (status == TextToSpeech.SUCCESS) {
                    val engine = tts ?: return@TextToSpeech
                    val res = engine.setLanguage(Locale.SIMPLIFIED_CHINESE)
                    ttsChineseAvailable = res != TextToSpeech.LANG_MISSING_DATA && res != TextToSpeech.LANG_NOT_SUPPORTED
                    engine.setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build(),
                    )
                } else {
                    ttsChineseAvailable = false
                }
            }
        }
    }

    fun playCue(
        cueType: String,
        soundStyle: String,
        isLastThree: Boolean,
        isSetFinalRep: Boolean,
        volumePct: Int,
    ) {
        if (volumePct <= 0 || cueType == "none") return
        val key = when (cueType) {
            "intro-cue", "side-switch" -> "cue_intro"
            "count-321" -> "cue_count_321"
            "count-go" -> "cue_count_go"
            "up" -> when (soundStyle) {
                "marimba" -> "cue_up_marimba"
                "perc" -> "cue_up_perc"
                else -> "cue_up_bell"
            }
            "hold" -> "cue_hold"
            "sub" -> "cue_sub"
            "rep" -> when {
                isSetFinalRep -> "cue_rep_final"
                isLastThree -> "cue_rep_last3"
                else -> "cue_rep"
            }
            "rest-tick" -> "cue_rest_tick"
            else -> return
        }
        val pcm = clips[key] ?: return
        playShortPcmAsync(cueExecutor, pcm, sampleRate, volumePct / 100f, interruptVoice = false)
    }

    fun playBreathPluck(direction: String, isRestPhase: Boolean, volumePct: Int) {
        if (volumePct <= 0) return
        val key = when {
            isRestPhase && direction == "inhale" -> "breath_rest_inhale"
            isRestPhase -> "breath_rest_exhale"
            direction == "inhale" -> "breath_action_inhale"
            else -> "breath_action_exhale"
        }
        val pcm = clips[key] ?: return
        playShortPcmAsync(cueExecutor, pcm, sampleRate, (volumePct / 100f).coerceIn(0f, 1f), interruptVoice = false)
    }

    fun speak(
        text: String?,
        tokens: List<String>?,
        bpm: Int,
        volumePct: Int,
        forceOffline: Boolean,
    ) {
        if (volumePct <= 0) return
        val cleanText = text?.replace("，", "")?.trim().orEmpty()
        val useOffline = forceOffline || !ttsChineseAvailable
        if (!useOffline && cleanText.isNotEmpty()) {
            val engine = tts
            if (engine != null) {
                val utteranceId = UUID.randomUUID().toString()
                engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(id: String?) {}
                    override fun onDone(id: String?) {}
                    @Deprecated("Deprecated in Android API")
                    override fun onError(id: String?) {
                        if (!tokens.isNullOrEmpty()) speakOfflineTokens(tokens, bpm, volumePct)
                    }
                    override fun onError(id: String?, errorCode: Int) {
                        if (!tokens.isNullOrEmpty()) speakOfflineTokens(tokens, bpm, volumePct)
                    }
                })
                val rate = (1.0 / OfflineAudioMixer.tempoScaleForBpm(bpm)).toFloat().coerceIn(0.95f, 1.35f)
                engine.setSpeechRate(rate)
                focusHelper.requestDuckFor(max(450L, cleanText.length * 160L))
                val bundle = android.os.Bundle().apply {
                    putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, (volumePct / 100f).coerceIn(0f, 1f))
                }
                val r = engine.speak(cleanText, TextToSpeech.QUEUE_FLUSH, bundle, utteranceId)
                if (r == TextToSpeech.SUCCESS) return
            }
        }
        if (!tokens.isNullOrEmpty()) {
            speakOfflineTokens(tokens, bpm, volumePct)
        }
    }

    fun speakOfflineTokens(tokens: List<String>, bpm: Int, volumePct: Int) {
        if (volumePct <= 0 || tokens.isEmpty()) return
        val segments = tokens.mapNotNull { clips["tok:$it"] }
        if (segments.isEmpty()) return
        val pcm = OfflineAudioMixer.crossfadeConcat(segments, sampleRate, OfflineAudioMixer.DEFAULT_OVERLAP_MS)
        val playSr = OfflineAudioMixer.playbackSampleRateForBpm(sampleRate, bpm)
        playShortPcmAsync(voiceExecutor, pcm, playSr, (volumePct / 100f).coerceIn(0f, 1f), interruptVoice = true)
    }

    fun vibrateTick(strong: Boolean = false) {
        val v = vibrator ?: return
        runCatching {
            val ms = if (strong) 45L else 20L
            val amp = if (strong) 180 else 110
            v.vibrate(VibrationEffect.createOneShot(ms, amp))
        }
    }

    fun stopAllPlayback() {
        runCatching { tts?.stop() }
        runCatching {
            activeVoiceTrack?.let {
                if (it.playState == AudioTrack.PLAYSTATE_PLAYING) it.stop()
                it.release()
            }
            activeVoiceTrack = null
        }
        focusHelper.abandonNow()
    }

    private fun playShortPcmAsync(
        executor: java.util.concurrent.ExecutorService,
        pcm: ShortArray,
        playSampleRate: Int,
        gain: Float,
        interruptVoice: Boolean,
    ) {
        if (pcm.isEmpty()) return
        val durationMs = ((pcm.size.toDouble() / playSampleRate.toDouble()) * 1000.0).toLong()
        focusHelper.requestDuckFor(durationMs)
        executor.execute {
            runCatching {
                if (interruptVoice) {
                    activeVoiceTrack?.let { prev ->
                        runCatching {
                            if (prev.playState == AudioTrack.PLAYSTATE_PLAYING) prev.stop()
                            prev.release()
                        }
                    }
                    activeVoiceTrack = null
                }
                val byteSize = pcm.size * 2
                val minBuf = AudioTrack.getMinBufferSize(
                    playSampleRate,
                    AudioFormat.CHANNEL_OUT_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                )
                val track = AudioTrack.Builder()
                    .setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                            .setContentType(if (interruptVoice) AudioAttributes.CONTENT_TYPE_SPEECH else AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build(),
                    )
                    .setAudioFormat(
                        AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(playSampleRate)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                            .build(),
                    )
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .setBufferSizeInBytes(max(byteSize, minBuf))
                    .build()
                if (interruptVoice) activeVoiceTrack = track
                track.setVolume(min(1f, max(0f, gain)))
                track.write(pcm, 0, pcm.size)
                track.play()
                // MODE_STATIC 播完后回收，避免占用 AudioFlinger Track 槽位
                Thread.sleep(durationMs + 40L)
                if (!interruptVoice || activeVoiceTrack === track) {
                    runCatching {
                        if (track.playState == AudioTrack.PLAYSTATE_PLAYING) track.stop()
                        track.release()
                    }
                    if (activeVoiceTrack === track) activeVoiceTrack = null
                }
            }
        }
    }

    override fun close() {
        stopAllPlayback()
        runCatching { tts?.shutdown() }
        voiceExecutor.shutdownNow()
        cueExecutor.shutdownNow()
    }
}
