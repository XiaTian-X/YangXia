package com.yangxia.app

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.yangxia.app.data.YangXiaRepository
import com.yangxia.app.deeplink.DeepLinkParseResult
import com.yangxia.app.deeplink.DeepLinkResolution
import com.yangxia.app.deeplink.DeepLinkRouter
import com.yangxia.app.deeplink.DeepLinkRuntimeContext
import com.yangxia.app.deeplink.DeepLinkTarget
import com.yangxia.app.service.WorkoutPhaseStatus
import com.yangxia.app.service.WorkoutPlaybackBus
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.time.Instant

/**
 * 真机端到端自动化测试（替代截图模拟点击）：
 * 当本机通过 `adb reverse tcp:8787 tcp:8787` 连接至运行中的 `@yangxia/server` 时，
 * 自动在小米 6 真机上全链路验证：
 * 登录 -> 拉取家庭档案与今日活跃课 -> 增量动图缓存 -> QuickJS 排程 + Android 15 前台服务跟练 ->
 * M8 Deep Link 全部边界裁决 -> 完课同步回服务端 -> 登出吊销并彻底清空本地缓存。
 * （若当前未启动本地 8787 服务端，自动 skip 不阻塞常规单测。）
 */
@RunWith(AndroidJUnit4::class)
class Mi6LiveServerE2eTest {

    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val baseUrl = "http://127.0.0.1:8787"

    @Test
    fun fullLiveServerWorkoutSyncAndDeepLinkFlowOnMi6() = runBlocking {
        val repo = YangXiaRepository(context)
        // 服务端在不在：健康检查只回 ok；有没有初始化看 /api/setup/status
        val serverReachable = runCatching { repo.api.health(baseUrl).ok }.getOrDefault(false)
        assumeTrue("未检测到运行在 127.0.0.1:8787 的本地测试服务端（需 adb reverse tcp:8787 tcp:8787），跳过联调 E2E", serverReachable)
        val initialized = runCatching { !repo.api.setupStatus(baseUrl).needsSetup }.getOrDefault(false)
        assertTrue(
            "服务端还没初始化：先用启动日志（或数据目录 setup-code.txt）里的一次性初始化口令在网页上建管理员 admin，再建成人档案「小夏」、儿童档案「小宝」并发第 1 周 A 日的课",
            initialized,
        )

        try {
            repo.logout()

            // 1. 真实账密登录（走 PrivateNetworkGuard 127.0.0.1 回环放行 + Keystore 加密落盘）
            val creds = repo.loginWithPassword(baseUrl, "admin", "YangXia2026!")
            assertEquals("mobile_account", creds.sessionKind)
            assertNotNull(repo.tokenStore.loadCredentials())

            // 2. 验证多档案拉取与 6–12 岁不支持标记
            val profiles = repo.db.profileDao().listAll()
            val adult = profiles.firstOrNull { it.code == "小夏" }
            val child = profiles.firstOrNull { it.code == "小宝" }
            assertNotNull("应同步到成人档案「小夏」", adult)
            assertNotNull("应同步到儿童档案「小宝」", child)
            assertTrue("成人档案应支持手机跟练", adult!!.supportedForWorkout)
            assertFalse("6–12 岁家长版不得支持手机跟练", child!!.supportedForWorkout)

            // 3. 验证活跃课程拉取、原始信封保留与增量动图缓存
            repo.refreshTodayForProfile(adult.profileId)
            val courses = repo.db.courseDao().listByProfile(adult.profileId)
            val active = courses.firstOrNull { it.status == "active" }
            assertNotNull("应同步到第 1 周 A 日活跃课程", active)
            assertTrue("原始信封应保留 schema", active!!.envelopeJson.contains("yangxia.delivery/1"))

            val prefs = repo.prefsStore.prefsFlow.first()
            val (env, rawCourseJson, plan) = repo.buildPlanForCachedCourse(active, prefs, adult.playbackJson)
            assertTrue("QuickJS 时间轴事件应非空", plan.timeline.events.size > 30)

            val clipIds = env.course.allItems().mapNotNull { it.figure }.distinct()
            val (rawClips, metaClips) = repo.loadMotionClips(clipIds)
            Log.i("Mi6LiveE2E", "Synced profile=${adult.code}, course=${active.courseName}, events=${plan.timeline.events.size}, motions=${rawClips.size}/${clipIds.size}")
            if (clipIds.isNotEmpty()) {
                assertTrue("应成功解包服务端增量 Lottie 动图", rawClips.isNotEmpty() && metaClips.isNotEmpty())
            }

            // 4. 启动真实 Android 15 mediaPlayback 前台服务跟练 + 验证推进与 M8 跟练中拦截
            val startedAt = Instant.now().minusSeconds(65).toString()
            WorkoutPlaybackBus.startWorkout(
                context,
                WorkoutPlaybackBus.StartPayload(
                    profileId = adult.profileId,
                    profileCode = adult.code,
                    courseRecordId = active.courseRecordId,
                    courseSnapshotHash = active.snapshotHash,
                    course = env.course,
                    courseJson = rawCourseJson,
                    plan = plan,
                    deviceVoiceVol = 0, // 联调测试静音防打扰
                    deviceCueVol = 0,
                    deviceBreathVol = 0,
                    forceOfflineVoice = true,
                    vibrate = false,
                ),
            )
            delay(800L)
            val playingState = WorkoutPlaybackBus.state.value
            assertEquals("前台服务应进入 PLAYING 状态", WorkoutPhaseStatus.PLAYING, playingState.status)
            assertTrue("单调时钟应推进", playingState.elapsedSec > 0.2)

            // M8 Deep Link：跟练中收到外部跳转必须拦截不中断训练
            val dlCtxPlaying = DeepLinkRuntimeContext(
                hasServerConfigured = true,
                isLoggedIn = true,
                isWorkoutInProgress = WorkoutPlaybackBus.isActiveWorkout(),
                currentProfileId = adult.profileId,
                knownProfileIds = profiles.map { it.profileId }.toSet(),
                unsupportedWorkoutProfileIds = profiles.filter { !it.supportedForWorkout }.map { it.profileId }.toSet(),
                activeCourseProfileById = mapOf(active.courseRecordId to adult.profileId),
                invalidatedCourseReasons = emptyMap(),
            )
            assertTrue(
                DeepLinkRouter.resolve(DeepLinkTarget.Today, dlCtxPlaying) is DeepLinkResolution.BlockedDuringWorkout,
            )

            // 结束跟练并验证服务退出 COMPLETED
            WorkoutPlaybackBus.stopAndFinish(context)
            delay(500L)
            assertEquals(WorkoutPhaseStatus.COMPLETED, WorkoutPlaybackBus.state.value.status)

            // M8 Deep Link：非跟练态拉起 6–12 岁档案应提示无手机跟练；带敏感参数应直接拒收
            assertTrue(DeepLinkRouter.parse("yangxia://today?weight=75") is DeepLinkParseResult.Rejected)
            assertTrue(
                DeepLinkRouter.resolve(
                    DeepLinkTarget.Profile(child.profileId),
                    dlCtxPlaying.copy(isWorkoutInProgress = false),
                ) is DeepLinkResolution.UnsupportedForMobileWorkout,
            )

            // 5. 完课生成 yangxia.session/1 并同步回真实服务端（验证服务端校验通过且队列清空）
            val tlJson = repo.json.encodeToString(com.yangxia.app.player.TimelineDto.serializer(), plan.timeline)
            val syncReport = repo.enqueueAndSyncSession(
                profileId = adult.profileId,
                courseRecordId = active.courseRecordId,
                courseSnapshotHash = active.snapshotHash,
                courseJson = rawCourseJson,
                timelineJson = tlJson,
                playedIndices = WorkoutPlaybackBus.state.value.playedEventIndices,
                startedAtIso = startedAt,
                endedAtIso = Instant.now().toString(),
                setsDoneOverride = env.course.allItems().map { 1 },
                symptoms = emptyList(),
                feel = "正好",
                note = "Mi6 真机自动化联调完成",
            )
            Log.i("Mi6LiveE2E", "Session sync report: synced=${syncReport.syncedCount}, skew=${syncReport.clockSkewBlocked}, err=${syncReport.lastError}")
            assertEquals("练习记录应成功同步至服务端（err=${syncReport.lastError}）", 1, syncReport.syncedCount)
            assertFalse(syncReport.clockSkewBlocked)
            assertTrue("同步成功后本地待传队列应清空", repo.db.pendingSessionDao().listAll().isEmpty())

            // 6. 登出应吊销服务端会话并彻底清空本地缓存（含 pending_sessions、profiles、courses、Keystore token）
            repo.logout()
            assertNull("登出后本地 Keystore 凭据应清空", repo.tokenStore.loadCredentials())
            assertTrue("登出后本地档案缓存应清空", repo.db.profileDao().listAll().isEmpty())
            assertTrue("登出后本地课程缓存应清空", repo.db.courseDao().listByProfile(adult.profileId).isEmpty())
            assertTrue("登出后待传队列应清空", repo.db.pendingSessionDao().listAll().isEmpty())
        } finally {
            WorkoutPlaybackBus.abortAndStop(context)
            repo.quickJsProvider.close()
        }
    }
}
