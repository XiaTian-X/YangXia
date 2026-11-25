package com.yangxia.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.yangxia.app.audio.AndroidAudioEngine
import com.yangxia.app.data.YangXiaRepository
import com.yangxia.app.deeplink.DeepLinkParseResult
import com.yangxia.app.deeplink.DeepLinkResolution
import com.yangxia.app.deeplink.DeepLinkRouter
import com.yangxia.app.deeplink.DeepLinkRuntimeContext
import com.yangxia.app.deeplink.DeepLinkTarget
import com.yangxia.app.player.CourseDto
import com.yangxia.app.player.MotionClipMetaDto
import com.yangxia.app.player.TimelineDto
import com.yangxia.app.security.AuthCredentials
import com.yangxia.app.service.WorkoutPhaseStatus
import com.yangxia.app.service.WorkoutPlaybackBus
import com.yangxia.app.storage.CachedCourseEntity
import com.yangxia.app.storage.CachedProfileEntity
import com.yangxia.app.storage.DevicePrefs
import com.yangxia.app.storage.PendingSessionEntity
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import java.time.Instant

enum class AppScreen { CONNECT, TODAY, WORKOUT, SUMMARY, SETTINGS }

data class DeepLinkDialogState(
    val title: String,
    val message: String,
    val confirmTargetProfileId: String? = null,
    val confirmTarget: DeepLinkTarget? = null,
)

@OptIn(ExperimentalCoroutinesApi::class)
class AppViewModel(application: Application) : AndroidViewModel(application) {
    val repo = YangXiaRepository(application)

    private val _screen = MutableStateFlow(AppScreen.CONNECT)
    val screen: StateFlow<AppScreen> = _screen.asStateFlow()

    private val _creds = MutableStateFlow<AuthCredentials?>(repo.tokenStore.loadCredentials())
    val creds: StateFlow<AuthCredentials?> = _creds.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val _deepLinkDialog = MutableStateFlow<DeepLinkDialogState?>(null)
    val deepLinkDialog: StateFlow<DeepLinkDialogState?> = _deepLinkDialog.asStateFlow()

    private val _deferredDeepLink = MutableStateFlow<DeepLinkTarget?>(null)

    private val _motionRawMap = MutableStateFlow<Map<String, String>>(emptyMap())
    val motionRawMap: StateFlow<Map<String, String>> = _motionRawMap.asStateFlow()

    private val _motionMetaMap = MutableStateFlow<Map<String, MotionClipMetaDto>>(emptyMap())
    val motionMetaMap: StateFlow<Map<String, MotionClipMetaDto>> = _motionMetaMap.asStateFlow()

    private val _summarySetsDone = MutableStateFlow<List<Int>>(emptyList())
    val summarySetsDone: StateFlow<List<Int>> = _summarySetsDone.asStateFlow()

    val devicePrefs: StateFlow<DevicePrefs> = repo.prefsStore.prefsFlow.stateIn(
        viewModelScope,
        SharingStarted.Eagerly,
        DevicePrefs(),
    )

    val profiles: StateFlow<List<CachedProfileEntity>> = repo.db.profileDao().observeAll().stateIn(
        viewModelScope,
        SharingStarted.Eagerly,
        emptyList(),
    )

    val courses: StateFlow<List<CachedCourseEntity>> = devicePrefs.flatMapLatest { p ->
        val pid = p.activeProfileId.ifBlank { _creds.value?.boundProfileId.orEmpty() }
        if (pid.isBlank()) flowOf(emptyList()) else repo.db.courseDao().observeByProfile(pid)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    val pendingSessions: StateFlow<List<PendingSessionEntity>> = devicePrefs.flatMapLatest { p ->
        val pid = p.activeProfileId.ifBlank { _creds.value?.boundProfileId.orEmpty() }
        if (pid.isBlank()) flowOf(emptyList()) else repo.db.pendingSessionDao().observeByProfile(pid)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    val clockSkewAlert: StateFlow<PendingSessionEntity?> = devicePrefs.flatMapLatest { p ->
        val pid = p.activeProfileId.ifBlank { _creds.value?.boundProfileId.orEmpty() }
        if (pid.isBlank()) flowOf(null) else repo.db.pendingSessionDao().observeClockSkewAlert(pid)
    }.stateIn(
        viewModelScope,
        SharingStarted.Eagerly,
        null,
    )

    val workoutState = WorkoutPlaybackBus.state

    /** 试听专用纯离线音频引擎（复用单实例、不绑定 TTS，onCleared 统一释放，避免反复点击泄漏线程/服务）。 */
    private val sampleAudioEngine by lazy { AndroidAudioEngine(getApplication(), enableTts = false) }
    private var sampleEngineInitialized = false

    init {
        if (_creds.value != null) {
            _screen.value = AppScreen.TODAY
            refreshAll()
        }
        viewModelScope.launch {
            workoutState.collect { st ->
                if (st.status == WorkoutPhaseStatus.COMPLETED && _screen.value == AppScreen.WORKOUT) {
                    prepareSummaryAndShow()
                }
            }
        }
    }

    fun clearBanner() {
        _error.value = null
        _message.value = null
    }

    fun openSettings() {
        clearBanner()
        _screen.value = AppScreen.SETTINGS
    }

    fun backToToday() {
        clearBanner()
        _screen.value = if (_creds.value != null) AppScreen.TODAY else AppScreen.CONNECT
    }

    fun setAllowTailscale(allow: Boolean) {
        repo.tokenStore.setAllowTailscaleCleartext(allow)
    }

    fun loginWithPassword(serverUrl: String, username: String, password: String) {
        viewModelScope.launch {
            _busy.value = true
            clearBanner()
            runCatching {
                repo.loginWithPassword(serverUrl, username, password)
            }.onSuccess { c ->
                _creds.value = c
                _screen.value = AppScreen.TODAY
                _message.value = "登录成功，已同步今日课程"
                resumeDeferredDeepLinkIfAny()
            }.onFailure { e ->
                _error.value = e.message ?: "登录失败，请检查服务器地址与账密"
            }
            _busy.value = false
        }
    }

    fun loginWithPairCode(serverUrl: String, pairCode: String) {
        viewModelScope.launch {
            _busy.value = true
            clearBanner()
            runCatching {
                repo.loginWithPairCode(serverUrl, pairCode)
            }.onSuccess { c ->
                _creds.value = c
                _screen.value = AppScreen.TODAY
                _message.value = "已扫码绑定档案「${c.boundProfileCode ?: ""}」"
                resumeDeferredDeepLinkIfAny()
            }.onFailure { e ->
                _error.value = e.message ?: "绑定失败，请核对 5 分钟绑定码与局域网地址"
            }
            _busy.value = false
        }
    }

    fun logout() {
        viewModelScope.launch {
            WorkoutPlaybackBus.abortAndStop(getApplication())
            _deferredDeepLink.value = null
            _deepLinkDialog.value = null
            _motionRawMap.value = emptyMap()
            _motionMetaMap.value = emptyMap()
            _summarySetsDone.value = emptyList()
            repo.logout()
            _creds.value = null
            _screen.value = AppScreen.CONNECT
            _message.value = "已退出当前账号并清理本机缓存"
        }
    }

    fun switchProfile(profileId: String) {
        viewModelScope.launch {
            repo.prefsStore.setActiveProfileId(profileId)
            refreshAll()
        }
    }

    fun refreshAll() {
        viewModelScope.launch {
            _busy.value = true
            _error.value = null
            runCatching {
                repo.refreshAllProfilesAndToday()
                val report = repo.flushPendingSessions()
                if (report.syncedCount > 0) {
                    _message.value = "已自动补传 ${report.syncedCount} 条离线练习记录"
                }
            }.onFailure { e ->
                _error.value = e.message ?: "刷新失败（离线状态下仍可练已缓存课程）"
            }
            _busy.value = false
        }
    }

    fun syncPendingNow() {
        viewModelScope.launch {
            _busy.value = true
            clearBanner()
            runCatching {
                val report = repo.flushPendingSessions()
                if (report.clockSkewBlocked) {
                    _error.value = "检测到手机系统时间比服务端超前，请先校准手机系统时间后再重试同步"
                } else if (report.syncedCount > 0) {
                    _message.value = "已成功同步 ${report.syncedCount} 条练习记录"
                } else if (report.lastError != null) {
                    _error.value = report.lastError
                } else {
                    _message.value = "没有待同步的离线记录"
                }
            }.onFailure { e ->
                _error.value = e.message ?: "同步失败"
            }
            _busy.value = false
        }
    }

    fun startCourse(courseEntity: CachedCourseEntity) {
        if (courseEntity.status != "active") {
            _error.value = "该课程已作废（${courseEntity.invalidatedReason ?: "规则变更"}），禁止开练，请刷新获取新课"
            return
        }
        viewModelScope.launch {
            _busy.value = true
            clearBanner()
            runCatching {
                val prof = repo.db.profileDao().getById(courseEntity.profileId)
                val prefs = devicePrefs.value
                val (envelope, rawCourseJson, plan) = repo.buildPlanForCachedCourse(courseEntity, prefs, prof?.playbackJson)
                val clipIds = envelope.course.allItems().mapNotNull { it.figure }.distinct()
                val (rawMap, metaMap) = repo.loadMotionClips(clipIds)
                _motionRawMap.value = rawMap
                _motionMetaMap.value = metaMap

                WorkoutPlaybackBus.startWorkout(
                    getApplication(),
                    WorkoutPlaybackBus.StartPayload(
                        profileId = courseEntity.profileId,
                        profileCode = prof?.code ?: envelope.profileCode,
                        courseRecordId = courseEntity.courseRecordId,
                        courseSnapshotHash = courseEntity.snapshotHash,
                        course = envelope.course,
                        courseJson = rawCourseJson,
                        plan = plan,
                        deviceVoiceVol = prefs.voiceVol,
                        deviceCueVol = prefs.cueVol,
                        deviceBreathVol = prefs.breathVol,
                        deviceSoundStyle = prefs.soundStyle,
                        forceOfflineVoice = prefs.forceOfflineVoice,
                        vibrate = prefs.vibrate,
                    ),
                )
                _screen.value = AppScreen.WORKOUT
            }.onFailure { e ->
                _error.value = e.message ?: "无法启动跟练引擎"
            }
            _busy.value = false
        }
    }

    fun finishWorkoutEarly() {
        WorkoutPlaybackBus.stopAndFinish(getApplication())
    }

    private suspend fun prepareSummaryAndShow() {
        val st = workoutState.value
        val course = st.course ?: return
        val tl = st.plan?.timeline ?: return
        val sets = runCatching {
            val cJson = st.courseJson.ifBlank { repo.json.encodeToString(CourseDto.serializer(), course) }
            val tJson = repo.json.encodeToString(TimelineDto.serializer(), tl)
            repo.quickJsProvider.computeSetsDone(cJson, tJson, st.playedEventIndices)
        }.getOrElse { course.allItems().map { 0 } }
        _summarySetsDone.value = sets
        _screen.value = AppScreen.SUMMARY
    }

    /** 练完保存：完成组数照实际播放过的算（不手改）；perItem 是每个动作的感受、还能做几下、当场退回。 */
    fun submitSummary(symptoms: List<String>, feel: String, note: String, perItem: Map<Int, com.yangxia.app.ui.screens.ItemNote>) {
        viewModelScope.launch {
            _busy.value = true
            clearBanner()
            val st = workoutState.value
            val course = st.course
            val tl = st.plan?.timeline
            if (course == null || tl == null) {
                _screen.value = AppScreen.TODAY
                _busy.value = false
                return@launch
            }
            runCatching {
                val cJson = st.courseJson.ifBlank { repo.json.encodeToString(CourseDto.serializer(), course) }
                val tJson = repo.json.encodeToString(TimelineDto.serializer(), tl)
                val report = repo.enqueueAndSyncSession(
                    profileId = st.profileId,
                    courseRecordId = st.courseRecordId,
                    courseSnapshotHash = st.courseSnapshotHash,
                    courseJson = cJson,
                    timelineJson = tJson,
                    playedIndices = st.playedEventIndices,
                    startedAtIso = st.startedAtIso.ifBlank { Instant.now().toString() },
                    endedAtIso = Instant.now().toString(),
                    symptoms = symptoms,
                    feel = feel,
                    note = note,
                    perItemJson = com.yangxia.app.ui.screens.perItemToJson(perItem),
                )
                WorkoutPlaybackBus.resetToIdle()
                _screen.value = AppScreen.TODAY
                _message.value = when {
                    report.syncedCount > 0 -> "练习记录已保存并同步至服务端"
                    report.clockSkewBlocked -> "记录已离线保存，但手机时间超前导致同步被拒，请先校准系统时间"
                    else -> "记录已离线保存，待联网后自动补传"
                }
                runCatching { repo.refreshTodayForProfile(st.profileId) }
            }.onFailure { e ->
                _error.value = e.message ?: "保存练习记录失败"
            }
            _busy.value = false
        }
    }

    fun updateDevicePrefs(transform: (DevicePrefs) -> DevicePrefs) {
        viewModelScope.launch {
            repo.prefsStore.update(transform)
        }
    }

    fun updateProfilePlayback(breathLead: JsonElement?, breathAfter: String?, countTiming: String?) {
        val pid = devicePrefs.value.activeProfileId.ifBlank { _creds.value?.boundProfileId.orEmpty() }
        if (pid.isBlank()) return
        viewModelScope.launch {
            _busy.value = true
            clearBanner()
            runCatching {
                repo.updateProfilePlayback(pid, breathLead, breathAfter, countTiming)
                _message.value = "已同步档案级播放偏好至服务端"
            }.onFailure { e ->
                _error.value = e.message ?: "同步偏好失败"
            }
            _busy.value = false
        }
    }

    fun testOfflineVoiceSample() {
        viewModelScope.launch {
            runCatching {
                sampleEngineInitialized = true
                sampleAudioEngine.speakOfflineTokens(listOf("3", "2", "1", "开始"), 60, devicePrefs.value.voiceVol.coerceAtLeast(50))
            }
        }
    }

    /** M8 Deep Link / 外部拉起统一入口（覆盖全部 6 种安全边界）。 */
    fun handleDeepLink(rawUri: String?) {
        when (val parsed = DeepLinkRouter.parse(rawUri)) {
            is DeepLinkParseResult.Rejected -> {
                _deepLinkDialog.value = DeepLinkDialogState("无效的外部拉起链接", parsed.reason)
            }
            is DeepLinkParseResult.Valid -> {
                applyDeepLinkTarget(parsed.target)
            }
        }
    }

    private fun applyDeepLinkTarget(target: DeepLinkTarget) {
        viewModelScope.launch {
            // 直接挂起查询 Room，避免冷启动时 StateFlow 初始空列表导致误判无权限/找不到课程
            val profs = repo.db.profileDao().listAll()
            val allCourses = profs.flatMap { repo.db.courseDao().listByProfile(it.profileId) }
            val currentPid = devicePrefs.value.activeProfileId.ifBlank { _creds.value?.boundProfileId }
            val ctx = DeepLinkRuntimeContext(
                hasServerConfigured = repo.tokenStore.getServerUrl().isNotBlank(),
                isLoggedIn = _creds.value != null,
                isWorkoutInProgress = WorkoutPlaybackBus.isActiveWorkout(),
                currentProfileId = currentPid,
                knownProfileIds = profs.map { it.profileId }.toSet(),
                unsupportedWorkoutProfileIds = profs.filter { !it.supportedForWorkout }.map { it.profileId }.toSet(),
                activeCourseProfileById = allCourses.filter { it.status == "active" }.associate { it.courseRecordId to it.profileId },
                invalidatedCourseReasons = allCourses.filter { it.status != "active" }
                    .associate { it.courseRecordId to (it.invalidatedReason ?: "已作废") },
            )
            when (val res = DeepLinkRouter.resolve(target, ctx)) {
                is DeepLinkResolution.DeferUntilServerSetup -> {
                    _deferredDeepLink.value = res.target
                    _screen.value = AppScreen.CONNECT
                    _message.value = "请先配置服务端地址并登录，完成后将自动跳转"
                }
                is DeepLinkResolution.DeferUntilLogin -> {
                    _deferredDeepLink.value = res.target
                    _screen.value = AppScreen.CONNECT
                    _message.value = "请先登录账号或扫码绑定，完成后将自动跳转"
                }
                is DeepLinkResolution.BlockedDuringWorkout -> {
                    _deepLinkDialog.value = DeepLinkDialogState("正在跟练中", res.message)
                }
                is DeepLinkResolution.CourseUnavailableOrInvalidated -> {
                    _deepLinkDialog.value = DeepLinkDialogState("课程不可用", res.reason)
                }
                is DeepLinkResolution.UnsupportedForMobileWorkout -> {
                    _deepLinkDialog.value = DeepLinkDialogState("该档案无手机跟练课程", res.message)
                }
                is DeepLinkResolution.AccessDenied -> {
                    _deepLinkDialog.value = DeepLinkDialogState("无法访问目标档案", res.message)
                }
                is DeepLinkResolution.RequireProfileSwitchConfirm -> {
                    val targetCode = profs.firstOrNull { it.profileId == res.targetProfileId }?.code ?: res.targetProfileId.take(8)
                    _deepLinkDialog.value = DeepLinkDialogState(
                        title = "确认切换训练档案",
                        message = "外部链接请求切换到档案「$targetCode」，请核对是否为本人，避免误练他人处方。",
                        confirmTargetProfileId = res.targetProfileId,
                        confirmTarget = res.target,
                    )
                }
                is DeepLinkResolution.NavigateNow -> {
                    executeDeepLinkNow(res.target)
                }
            }
        }
    }

    fun confirmDeepLinkSwitch() {
        val dlg = _deepLinkDialog.value ?: return
        _deepLinkDialog.value = null
        val targetPid = dlg.confirmTargetProfileId
        val target = dlg.confirmTarget ?: return
        viewModelScope.launch {
            if (!targetPid.isNullOrBlank()) {
                repo.prefsStore.setActiveProfileId(targetPid)
                runCatching { repo.refreshTodayForProfile(targetPid) }
            }
            executeDeepLinkNow(target)
        }
    }

    fun dismissDeepLinkDialog() {
        _deepLinkDialog.value = null
    }

    private suspend fun executeDeepLinkNow(target: DeepLinkTarget) {
        when (target) {
            is DeepLinkTarget.Today -> _screen.value = AppScreen.TODAY
            is DeepLinkTarget.Profile -> {
                repo.prefsStore.setActiveProfileId(target.profileId)
                _screen.value = AppScreen.TODAY
            }
            is DeepLinkTarget.Course -> {
                val c = repo.db.courseDao().getByRecordId(target.courseRecordId)
                if (c != null && c.status == "active") {
                    repo.prefsStore.setActiveProfileId(c.profileId)
                    startCourse(c)
                } else {
                    _deepLinkDialog.value = DeepLinkDialogState("课程不可用", "该课程已过期或尚未同步，请下拉刷新。")
                }
            }
        }
    }

    private fun resumeDeferredDeepLinkIfAny() {
        val deferred = _deferredDeepLink.value ?: return
        _deferredDeepLink.value = null
        applyDeepLinkTarget(deferred)
    }

    override fun onCleared() {
        if (sampleEngineInitialized) runCatching { sampleAudioEngine.close() }
        repo.quickJsProvider.close()
        super.onCleared()
    }
}
