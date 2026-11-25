package com.yangxia.app

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.core.view.WindowCompat
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.yangxia.app.service.WorkoutPlaybackBus
import com.yangxia.app.ui.AppScreen
import com.yangxia.app.ui.AppViewModel
import com.yangxia.app.ui.screens.ConnectScreen
import com.yangxia.app.ui.screens.SettingsScreen
import com.yangxia.app.ui.screens.SummaryScreen
import com.yangxia.app.ui.screens.TodayScreen
import com.yangxia.app.ui.screens.WorkoutScreen
import com.yangxia.app.ui.theme.YangXiaTheme

class MainActivity : ComponentActivity() {

    private val vm: AppViewModel by viewModels()
    private var pendingQrCallback: ((String) -> Unit)? = null

    private val qrLauncher = registerForActivityResult(ScanContract()) { result ->
        val text = result.contents
        if (!text.isNullOrBlank()) {
            pendingQrCallback?.invoke(text)
        }
        pendingQrCallback = null
    }

    private val notifPermLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Android 13+ 请求前台跟练语音播报通知权限
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notifPermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        // 仅在首次冷启动时消费 Deep Link，避免横竖屏切换重建重复触发
        if (savedInstanceState == null) {
            intent?.dataString?.let { raw ->
                intent?.data = null
                vm.handleDeepLink(raw)
            }
        }

        setContent {
            YangXiaTheme {
                val screen by vm.screen.collectAsState()
                val creds by vm.creds.collectAsState()
                val profiles by vm.profiles.collectAsState()
                val courses by vm.courses.collectAsState()
                val pendingSessions by vm.pendingSessions.collectAsState()
                val clockSkew by vm.clockSkewAlert.collectAsState()
                val devicePrefs by vm.devicePrefs.collectAsState()
                val workoutState by vm.workoutState.collectAsState()
                val motionRawMap by vm.motionRawMap.collectAsState()
                val motionMetaMap by vm.motionMetaMap.collectAsState()
                val summarySets by vm.summarySetsDone.collectAsState()
                val busy by vm.busy.collectAsState()
                val error by vm.error.collectAsState()
                val message by vm.message.collectAsState()
                val dlDialog by vm.deepLinkDialog.collectAsState()

                // 跟练界面保持屏幕常亮并切深色状态栏图标，离开后恢复浅色暖纸状态栏图标
                LaunchedEffect(screen) {
                    val controller = WindowCompat.getInsetsController(window, window.decorView)
                    if (screen == AppScreen.WORKOUT) {
                        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                        controller.isAppearanceLightStatusBars = false
                    } else {
                        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                        controller.isAppearanceLightStatusBars = true
                    }
                }

                val activeProfile = profiles.firstOrNull {
                    it.profileId == devicePrefs.activeProfileId.ifBlank { creds?.boundProfileId.orEmpty() }
                } ?: profiles.firstOrNull()

                Box(modifier = Modifier.fillMaxSize().safeDrawingPadding()) {
                    when (screen) {
                        AppScreen.CONNECT -> ConnectScreen(
                            initialServerUrl = vm.repo.tokenStore.getServerUrl(),
                            initialAllowTailscale = vm.repo.tokenStore.isAllowTailscaleCleartext(),
                            busy = busy,
                            error = error,
                            message = message,
                            onToggleTailscale = { vm.setAllowTailscale(it) },
                            onLoginPassword = { url, user, pw -> vm.loginWithPassword(url, user, pw) },
                            onLoginPairCode = { url, code -> vm.loginWithPairCode(url, code) },
                            onRequestQrScan = { cb ->
                                pendingQrCallback = cb
                                qrLauncher.launch(
                                    ScanOptions().apply {
                                        setCaptureActivity(PortraitCaptureActivity::class.java)
                                        setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                                        setPrompt("请竖屏对准网页端 5 分钟配对二维码")
                                        setBeepEnabled(true)
                                        setOrientationLocked(true)
                                    },
                                )
                            },
                        )

                        AppScreen.TODAY -> TodayScreen(
                            profiles = profiles,
                            activeProfile = activeProfile,
                            isMobileBound = creds?.sessionKind == "mobile_bound",
                            courses = courses,
                            pendingSessions = pendingSessions,
                            clockSkewAlert = clockSkew,
                            busy = busy,
                            error = error,
                            message = message,
                            onSelectProfile = { vm.switchProfile(it) },
                            onRefresh = { vm.refreshAll() },
                            onSyncPending = { vm.syncPendingNow() },
                            onStartCourse = { vm.startCourse(it) },
                            onOpenSettings = { vm.openSettings() },
                        )

                        AppScreen.WORKOUT -> WorkoutScreen(
                            state = workoutState,
                            motionRawMap = motionRawMap,
                            motionMetaMap = motionMetaMap,
                            onTogglePause = { WorkoutPlaybackBus.togglePause(this@MainActivity) },
                            onPrevStage = { WorkoutPlaybackBus.jumpStage(this@MainActivity, -1) },
                            onNextStage = { WorkoutPlaybackBus.jumpStage(this@MainActivity, +1) },
                            onFinish = { vm.finishWorkoutEarly() },
                        )

                        AppScreen.SUMMARY -> {
                            val c = workoutState.course
                            if (c != null) {
                                SummaryScreen(
                                    profileCode = workoutState.profileCode,
                                    course = c,
                                    initialSetsDone = summarySets,
                                    busy = busy,
                                    onSubmit = { syms, feel, note, perItem -> vm.submitSummary(syms, feel, note, perItem) },
                                    onDiscard = {
                                        WorkoutPlaybackBus.resetToIdle()
                                        vm.backToToday()
                                    },
                                )
                            } else {
                                vm.backToToday()
                            }
                        }

                        AppScreen.SETTINGS -> SettingsScreen(
                            serverUrl = vm.repo.tokenStore.getServerUrl(),
                            profileCode = activeProfile?.code,
                            profilePlaybackJson = activeProfile?.playbackJson,
                            pendingSessionCount = pendingSessions.size,
                            allowTailscale = vm.repo.tokenStore.isAllowTailscaleCleartext(),
                            devicePrefs = devicePrefs,
                            busy = busy,
                            message = message,
                            error = error,
                            onBack = { vm.backToToday() },
                            onToggleTailscale = { vm.setAllowTailscale(it) },
                            onUpdateDevicePrefs = { vm.updateDevicePrefs(it) },
                            onSyncProfilePlayback = { lead, after, timing -> vm.updateProfilePlayback(lead, after, timing) },
                            onTestOfflineVoice = { vm.testOfflineVoiceSample() },
                            onOpenBatterySettings = {
                                runCatching { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
                            },
                            onLogout = { vm.logout() },
                        )
                    }
                }

                // M8 Deep Link 弹窗（防误练他人档案二次确认 / 正在跟练拦截 / 无效链接提示）
                dlDialog?.let { dlg ->
                    AlertDialog(
                        onDismissRequest = { vm.dismissDeepLinkDialog() },
                        title = { Text(dlg.title) },
                        text = { Text(dlg.message) },
                        confirmButton = {
                            if (dlg.confirmTarget != null) {
                                TextButton(onClick = { vm.confirmDeepLinkSwitch() }) {
                                    Text("确认切换")
                                }
                            } else {
                                TextButton(onClick = { vm.dismissDeepLinkDialog() }) {
                                    Text("知道了")
                                }
                            }
                        },
                        dismissButton = if (dlg.confirmTarget != null) {
                            {
                                TextButton(onClick = { vm.dismissDeepLinkDialog() }) {
                                    Text("取消")
                                }
                            }
                        } else null,
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val raw = intent.dataString
        intent.data = null
        setIntent(intent)
        if (!raw.isNullOrBlank()) {
            vm.handleDeepLink(raw)
        }
    }
}
