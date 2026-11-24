package com.yangxia.app.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.yangxia.app.MainActivity
import com.yangxia.app.R
import com.yangxia.app.audio.AndroidAudioEngine
import com.yangxia.app.player.CourseDto
import com.yangxia.app.player.LiveViewMath
import com.yangxia.app.player.PlaybackSettingsDto
import com.yangxia.app.player.PlayerPlanResultDto
import com.yangxia.app.player.TimelineEventDto
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.time.Instant
import kotlin.math.roundToInt

enum class WorkoutPhaseStatus { IDLE, PLAYING, PAUSED, COMPLETED }

data class WorkoutSessionState(
    val status: WorkoutPhaseStatus = WorkoutPhaseStatus.IDLE,
    val profileId: String = "",
    val profileCode: String = "",
    val courseRecordId: String = "",
    val courseSnapshotHash: String = "",
    val course: CourseDto? = null,
    val courseJson: String = "",
    val plan: PlayerPlanResultDto? = null,
    val settings: PlaybackSettingsDto? = null,
    val startedAtIso: String = "",
    val elapsedSec: Double = 0.0,
    val lastEventIndex: Int = -1,
    val playedEventIndices: List<Int> = emptyList(),
    val ttsChineseAvailable: Boolean = false,
)

object WorkoutPlaybackBus {
    private val _state = MutableStateFlow(WorkoutSessionState())
    val state: StateFlow<WorkoutSessionState> = _state.asStateFlow()

    @Volatile internal var pendingStartPayload: StartPayload? = null

    data class StartPayload(
        val profileId: String,
        val profileCode: String,
        val courseRecordId: String,
        val courseSnapshotHash: String,
        val course: CourseDto,
        val courseJson: String,
        val plan: PlayerPlanResultDto,
        val deviceVoiceVol: Int = 92,
        val deviceCueVol: Int = 70,
        val deviceBreathVol: Int = 65,
        val deviceSoundStyle: String = "woodblock",
        val forceOfflineVoice: Boolean,
        val vibrate: Boolean,
    )

    internal fun update(transform: (WorkoutSessionState) -> WorkoutSessionState) {
        _state.value = transform(_state.value)
    }

    fun isActiveWorkout(): Boolean {
        val st = _state.value.status
        return st == WorkoutPhaseStatus.PLAYING || st == WorkoutPhaseStatus.PAUSED
    }

    fun startWorkout(context: Context, payload: StartPayload) {
        pendingStartPayload = payload
        val intent = Intent(context, WorkoutPlaybackService::class.java).apply { action = ACTION_START }
        context.startForegroundService(intent)
    }

    fun togglePause(context: Context) {
        val intent = Intent(context, WorkoutPlaybackService::class.java).apply { action = ACTION_TOGGLE_PAUSE }
        context.startService(intent)
    }

    fun seekBy(context: Context, deltaSec: Double) {
        val intent = Intent(context, WorkoutPlaybackService::class.java).apply {
            action = ACTION_SEEK_DELTA
            putExtra(EXTRA_DELTA_SEC, deltaSec)
        }
        context.startService(intent)
    }

    fun stopAndFinish(context: Context) {
        val intent = Intent(context, WorkoutPlaybackService::class.java).apply { action = ACTION_FINISH }
        context.startService(intent)
    }

    fun abortAndStop(context: Context) {
        pendingStartPayload = null
        resetToIdle()
        runCatching { context.stopService(Intent(context, WorkoutPlaybackService::class.java)) }
    }

    fun resetToIdle() {
        _state.value = WorkoutSessionState()
    }

    const val ACTION_START = "com.yangxia.app.action.START"
    const val ACTION_TOGGLE_PAUSE = "com.yangxia.app.action.TOGGLE_PAUSE"
    const val ACTION_SEEK_DELTA = "com.yangxia.app.action.SEEK_DELTA"
    const val ACTION_FINISH = "com.yangxia.app.action.FINISH"
    const val EXTRA_DELTA_SEC = "delta_sec"
}

/**
 * 架构 6.4 targetSdk = 35 合规前台跟练语音播报服务：
 * - foregroundServiceType="mediaPlayback"；
 * - 播放态持有带 90 分钟安全上限的 PARTIAL_WAKE_LOCK（暂停/完成/销毁立即释放），保障小米 6 锁屏息屏 15 分钟持续纯语音不休眠；
 * - 课程时钟强制使用单调时钟 SystemClock.elapsedRealtime()，免疫系统校时跳变与后台漂移。
 */
class WorkoutPlaybackService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var tickerJob: Job? = null
    private lateinit var audioEngine: AndroidAudioEngine
    private var wakeLock: PowerManager.WakeLock? = null

    private var forceOfflineVoice: Boolean = false
    private var vibrateEnabled: Boolean = true
    private var baseElapsedRealtimeMs: Long = 0L
    private var accumulatedSec: Double = 0.0
    private var nextEventIdx: Int = 0
    private val playedIndices = linkedSetOf<Int>()

    override fun onCreate() {
        super.onCreate()
        audioEngine = AndroidAudioEngine(this)
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "YangXia:WorkoutPlaybackWakeLock").apply {
            setReferenceCounted(false)
        }
        ensureChannel()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            WorkoutPlaybackBus.ACTION_START -> {
                val payload = WorkoutPlaybackBus.pendingStartPayload
                if (payload == null) {
                    // Android 12–15 经 startForegroundService 拉起后必须先进入前台再停止，防 ForegroundServiceDidNotStartInTimeException
                    ServiceCompat.startForeground(
                        this,
                        NOTIFICATION_ID,
                        buildNotification("养夏跟练", "正在准备结束"),
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
                    )
                    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
                    stopSelf()
                    return START_NOT_STICKY
                }
                WorkoutPlaybackBus.pendingStartPayload = null
                startSession(payload)
            }
            WorkoutPlaybackBus.ACTION_TOGGLE_PAUSE -> togglePause()
            WorkoutPlaybackBus.ACTION_SEEK_DELTA -> {
                val delta = intent.getDoubleExtra(WorkoutPlaybackBus.EXTRA_DELTA_SEC, 0.0)
                seekBy(delta)
            }
            WorkoutPlaybackBus.ACTION_FINISH -> finishSession()
        }
        return START_NOT_STICKY
    }

    private fun startSession(payload: WorkoutPlaybackBus.StartPayload) {
        tickerJob?.cancel()
        audioEngine.stopAllPlayback()
        forceOfflineVoice = payload.forceOfflineVoice
        vibrateEnabled = payload.vibrate
        playedIndices.clear()

        // 融合本机设备音量与音色偏好，再经安全下限硬覆盖（floor == "pluck" 时 breathVolume 恒 >= 15）
        val mergedSettings = payload.plan.effectiveSettings.copy(
            sound = payload.deviceSoundStyle.ifBlank { payload.plan.effectiveSettings.sound },
            voiceVolume = payload.deviceVoiceVol.coerceIn(0, 100),
            soundVolume = payload.deviceCueVol.coerceIn(0, 100),
            breathVolume = payload.deviceBreathVol.coerceIn(0, 100),
        )
        val enforcedSettings = LiveViewMath.enforceSafetyFloor(mergedSettings, payload.plan.floor)
        accumulatedSec = 0.0
        baseElapsedRealtimeMs = SystemClock.elapsedRealtime()
        nextEventIdx = 0

        WorkoutPlaybackBus.update {
            WorkoutSessionState(
                status = WorkoutPhaseStatus.PLAYING,
                profileId = payload.profileId,
                profileCode = payload.profileCode,
                courseRecordId = payload.courseRecordId,
                courseSnapshotHash = payload.courseSnapshotHash,
                course = payload.course,
                courseJson = payload.courseJson,
                plan = payload.plan,
                settings = enforcedSettings,
                startedAtIso = Instant.now().toString(),
                elapsedSec = 0.0,
                lastEventIndex = -1,
                playedEventIndices = emptyList(),
                ttsChineseAvailable = audioEngine.ttsChineseAvailable,
            )
        }

        val notification = buildNotification(
            title = "${payload.profileCode} · ${payload.course.name}",
            text = "正在跟练（息屏持续语音播报中）",
        )
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
        )
        acquireWakeLock()
        startTicker()
    }

    private fun togglePause() {
        val st = WorkoutPlaybackBus.state.value
        if (st.status == WorkoutPhaseStatus.PLAYING) {
            accumulatedSec = currentElapsedSec()
            tickerJob?.cancel()
            audioEngine.stopAllPlayback()
            releaseWakeLock()
            WorkoutPlaybackBus.update {
                it.copy(status = WorkoutPhaseStatus.PAUSED, elapsedSec = accumulatedSec, playedEventIndices = playedIndices.toList())
            }
            updateNotification("已暂停 · ${st.course?.name.orEmpty()}", "点击返回继续跟练")
        } else if (st.status == WorkoutPhaseStatus.PAUSED) {
            baseElapsedRealtimeMs = SystemClock.elapsedRealtime()
            WorkoutPlaybackBus.update { it.copy(status = WorkoutPhaseStatus.PLAYING) }
            acquireWakeLock()
            startTicker()
            updateNotification("${st.profileCode} · ${st.course?.name.orEmpty()}", "正在跟练（息屏持续语音播报中）")
        }
    }

    private fun seekBy(deltaSec: Double) {
        val st = WorkoutPlaybackBus.state.value
        val tl = st.plan?.timeline ?: return
        val cur = if (st.status == WorkoutPhaseStatus.PLAYING) currentElapsedSec() else accumulatedSec
        val target = (cur + deltaSec).coerceIn(0.0, tl.totalDuration)
        accumulatedSec = target
        baseElapsedRealtimeMs = SystemClock.elapsedRealtime()
        nextEventIdx = tl.events.indexOfFirst { it.time >= target }.let { if (it < 0) tl.events.size else it }
        audioEngine.stopAllPlayback()
        WorkoutPlaybackBus.update { it.copy(elapsedSec = target) }
    }

    private fun finishSession() {
        val st = WorkoutPlaybackBus.state.value
        val finalElapsed = if (st.status == WorkoutPhaseStatus.PLAYING) currentElapsedSec() else st.elapsedSec
        tickerJob?.cancel()
        audioEngine.stopAllPlayback()
        releaseWakeLock()
        WorkoutPlaybackBus.update {
            it.copy(
                status = WorkoutPhaseStatus.COMPLETED,
                elapsedSec = finalElapsed,
                playedEventIndices = playedIndices.toList(),
            )
        }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun currentElapsedSec(): Double {
        val deltaMs = SystemClock.elapsedRealtime() - baseElapsedRealtimeMs
        return accumulatedSec + (deltaMs.coerceAtLeast(0L) / 1000.0)
    }

    private fun startTicker() {
        tickerJob?.cancel()
        tickerJob = scope.launch {
            try {
                while (isActive) {
                    val st = WorkoutPlaybackBus.state.value
                    val plan = st.plan ?: break
                    val settings = st.settings ?: plan.effectiveSettings
                    val tl = plan.timeline
                    val nowSec = currentElapsedSec()

                    while (nextEventIdx < tl.events.size && tl.events[nextEventIdx].time <= nowSec) {
                        val ev = tl.events[nextEventIdx]
                        playedIndices.add(nextEventIdx)
                        dispatchEventAudio(ev, settings)
                        nextEventIdx++
                    }

                    if (nowSec >= tl.totalDuration) {
                        accumulatedSec = tl.totalDuration
                        WorkoutPlaybackBus.update {
                            it.copy(
                                status = WorkoutPhaseStatus.COMPLETED,
                                elapsedSec = tl.totalDuration,
                                lastEventIndex = tl.events.lastIndex,
                                playedEventIndices = playedIndices.toList(),
                            )
                        }
                        releaseWakeLock()
                        ServiceCompat.stopForeground(this@WorkoutPlaybackService, ServiceCompat.STOP_FOREGROUND_REMOVE)
                        stopSelf()
                        break
                    }

                    WorkoutPlaybackBus.update {
                        it.copy(
                            elapsedSec = nowSec,
                            lastEventIndex = (nextEventIdx - 1).coerceAtLeast(-1),
                            playedEventIndices = playedIndices.toList(),
                            ttsChineseAvailable = audioEngine.ttsChineseAvailable,
                        )
                    }
                    delay(33L)
                }
            } finally {
                if (WorkoutPlaybackBus.state.value.status != WorkoutPhaseStatus.PLAYING) {
                    releaseWakeLock()
                }
            }
        }
    }

    private fun dispatchEventAudio(ev: TimelineEventDto, settings: PlaybackSettingsDto) {
        if (ev.cueType != "none") {
            audioEngine.playCue(
                cueType = ev.cueType,
                soundStyle = ev.style.ifBlank { settings.sound },
                isLastThree = ev.isLastThree,
                isSetFinalRep = ev.isSetFinalRep,
                volumePct = settings.soundVolume,
            )
            if (vibrateEnabled && (ev.cueType == "rep" || ev.cueType == "count-go" || ev.isSetFinalRep)) {
                audioEngine.vibrateTick(strong = ev.isSetFinalRep)
            }
        }
        val bp = ev.breathPluck
        if (bp != null) {
            audioEngine.playBreathPluck(
                direction = bp.direction,
                isRestPhase = bp.isRestPhase,
                volumePct = settings.breathVolume,
            )
        }
        if (!ev.voice.isNullOrBlank() || !ev.voiceTokens.isNullOrEmpty()) {
            val vol = (settings.voiceVolume * ev.voiceVolScale).roundToInt().coerceIn(0, 100)
            audioEngine.speak(
                text = ev.voice,
                tokens = ev.voiceTokens,
                bpm = if (ev.bpm > 0) ev.bpm else settings.bpm,
                volumePct = vol,
                forceOffline = forceOfflineVoice || settings.voiceEngine == "embedded",
            )
        }
    }

    private fun acquireWakeLock() {
        runCatching {
            val wl = wakeLock ?: return
            if (!wl.isHeld) wl.acquire(90 * 60 * 1000L)
        }
    }

    private fun releaseWakeLock() {
        runCatching {
            val wl = wakeLock ?: return
            if (wl.isHeld) wl.release()
        }
    }

    private fun ensureChannel() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val ch = NotificationChannel(CHANNEL_ID, "跟练语音播报", NotificationManager.IMPORTANCE_LOW).apply {
            description = "锁屏及后台持续播报跟练报数与呼吸提示"
            setSound(null, null)
        }
        nm.createNotificationChannel(ch)
    }

    private fun buildNotification(title: String, text: String): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply { flags = Intent.FLAG_ACTIVITY_SINGLE_TOP },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val pauseIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, WorkoutPlaybackService::class.java).apply { action = WorkoutPlaybackBus.ACTION_TOGGLE_PAUSE },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val publicVersion = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("养夏跟练")
            .setContentText("正在语音播报中")
            .setOngoing(true)
            .build()
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(openIntent)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion)
            .setOngoing(true)
            .addAction(0, "暂停 / 继续", pauseIntent)
            .build()
    }

    private fun updateNotification(title: String, text: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, buildNotification(title, text))
    }

    override fun onDestroy() {
        tickerJob?.cancel()
        releaseWakeLock()
        audioEngine.close()
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ID = "yangxia_workout_playback"
        private const val NOTIFICATION_ID = 4201
    }
}
