package com.yangxia.app

import android.util.Log
import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.yangxia.app.audio.AndroidAudioEngine
import com.yangxia.app.player.QuickJsTimelineProvider
import com.yangxia.app.security.AuthCredentials
import com.yangxia.app.security.SecureTokenStore
import com.yangxia.app.storage.CachedCourseEntity
import com.yangxia.app.storage.CachedMotionEntity
import com.yangxia.app.storage.PendingSessionEntity
import com.yangxia.app.storage.YangXiaDatabase
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 阶段 5a 小米 Mi 6 (arm64-v8a) 真机实测验证：
 * 1. QuickJS arm64-v8a .so 兼容性、冷启动耗时与单课时间轴计算耗时（门槛 < 200ms）；
 * 2. Android Keystore (AES-256-GCM) 真机加解密闭环；
 * 3. Room 按 profileId 分区隔离、旧课强制作废、LRU 动图淘汰与 CLOCK_SKEW_FUTURE 队列；
 * 4. 离线 16 音效 + 27 词元音频包在真机解压与合成无异常。
 */
@RunWith(AndroidJUnit4::class)
class Mi6DeviceRuntimeTest {

    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun quickJsArm64WarmupAndSingleCoursePlanMeetMi6LatencyBudget() = runTest {
        val provider = QuickJsTimelineProvider(
            runtimeJsLoader = {
                context.assets.open("player-runtime.js").bufferedReader().use { it.readText() }
            },
        )
        try {
            val warmupMs = provider.warmup()
            val sampleCourse = """
                {
                  "schema":"yangxia.course/1",
                  "id":"mi6_bench_1",
                  "name":"Mi6 基准课",
                  "age":"a18",
                  "source":{"product":"18-39岁-居家版","templates":"v1.0.0","week":1,"day":"A"},
                  "blocks":[{"kind":"sets","items":[
                    {"exercise":"squat","name":"徒手深蹲","mode":"reps","sets":3,"reps":15,"tempo":{"start":"down","down":2,"up":1},"rest":90,"quote":["测试"]},
                    {"exercise":"pushup","name":"上斜俯卧撑","mode":"reps","sets":3,"reps":10,"tempo":{"start":"down","down":2,"up":1},"rest":90,"quote":["测试"]},
                    {"exercise":"plank","name":"平板支撑","mode":"timed","sets":3,"duration":30,"rest":60,"quote":["测试"]}
                  ]}]
                }
            """.trimIndent()

            // 分段测时：纯 JS 计算 vs JSON 序列化+正则 vs Kotlin 反序列化
            val profileRaw = provider.evalRawJson(
                """
                (function() {
                  var c = JSON.parse(${QuickJsTimelineProvider.lit(sampleCourse)});
                  var t0 = Date.now();
                  var p = globalThis.YangXiaPlayer.buildPlayerPlan(c, {});
                  var t1 = Date.now();
                  var s1 = JSON.stringify(p);
                  var t2 = Date.now();
                  var s2 = globalThis.__yxToJniSafeJson(p);
                  var t3 = Date.now();
                  return JSON.stringify({ jsBuildMs: t1 - t0, stringifyMs: t2 - t1, safeJsonMs: t3 - t2, bytes: s1.length, events: p.timeline.events.length });
                })()
                """.trimIndent(),
            )
            Log.i("Mi6Benchmark", "Breakdown: $profileRaw")

            val t0 = System.nanoTime()
            val coldPlan = provider.buildPlayerPlan(sampleCourse, "{}")
            val coldPlanMs = (System.nanoTime() - t0) / 1_000_000L

            // 取 3 次稳态中位数，消除单次调频/GC 偶发抖动，同时严守 < 200ms 预算
            val samples = LongArray(3)
            var plan = coldPlan
            for (k in samples.indices) {
                val ts = System.nanoTime()
                plan = provider.buildPlayerPlan(sampleCourse, "{}")
                samples[k] = (System.nanoTime() - ts) / 1_000_000L
            }
            samples.sort()
            val medianPlanMs = samples[1]

            Log.i("Mi6Benchmark", "QuickJS warmup=${warmupMs}ms, coldPlan=${coldPlanMs}ms, warmMedian=${medianPlanMs}ms (samples=${samples.joinToString(",")}), events=${plan.timeline.events.size}")
            assertEquals(coldPlan.timeline.events.size, plan.timeline.events.size)
            assertTrue("时间轴事件应非空", plan.timeline.events.size > 50)
            assertTrue("Mi 6 单课计算稳态中位耗时应 < 200ms，实测 cold=${coldPlanMs}ms, median=${medianPlanMs}ms", medianPlanMs < 200L)
        } finally {
            provider.close()
        }
    }

    @Test
    fun keystoreTokenStoreRoundTripWorksOnMi6() {
        val store = SecureTokenStore(context)
        val creds = AuthCredentials(
            serverUrl = "http://192.168.1.50:3000",
            token = "mi6-test-token-1234567890",
            sessionKind = "mobile_bound",
            boundProfileId = "11111111-1111-4111-8111-111111111111",
            boundProfileCode = "测试甲",
            username = null,
        )
        store.saveCredentials(creds)
        val loaded = store.loadCredentials()
        assertNotNull(loaded)
        assertEquals(creds.token, loaded!!.token)
        assertEquals(creds.boundProfileId, loaded.boundProfileId)
        store.clearToken()
    }

    @Test
    fun roomProfileIsolationInvalidationAndClockSkewQueueWork() = runTest {
        val db = Room.inMemoryDatabaseBuilder(context, YangXiaDatabase::class.java).build()
        try {
            db.courseDao().upsertAll(
                listOf(
                    CachedCourseEntity("c1", "pA", "cid1", "A的课", 1, 1, "A", false, "h1", "{}", null, "active", null, "2026-11-02"),
                    CachedCourseEntity("c2", "pB", "cid2", "B的课", 1, 1, "A", false, "h2", "{}", null, "active", null, "2026-11-02"),
                ),
            )
            assertEquals(1, db.courseDao().listByProfile("pA").size)
            assertEquals("A的课", db.courseDao().listByProfile("pA").first().courseName)

            // 强制作废旧缓存课
            db.courseDao().markInvalidated("c1", "档案已降级", "2026-11-03")
            val c1 = db.courseDao().getByRecordId("c1")!!
            assertEquals("invalidated", c1.status)
            assertEquals("档案已降级", c1.invalidatedReason)

            // 动图 LRU 裁剪
            db.motionDao().upsertAll(
                listOf(
                    CachedMotionEntity("m1", "h1", "{}", 100L),
                    CachedMotionEntity("m2", "h2", "{}", 200L),
                    CachedMotionEntity("m3", "h3", "{}", 300L),
                ),
            )
            db.motionDao().pruneLru(2)
            assertEquals(2, db.motionDao().listHashes().size)

            // 幂等补传队列去重 + CLOCK_SKEW_FUTURE 按 profileId 分区隔离告警
            val item = PendingSessionEntity("idem-1", "pA", "c1", "cid1", "h1", "2026-11-02T03:00:00Z", "{}", null, null, 0, 1L)
            assertTrue(db.pendingSessionDao().insertIgnore(item) > 0)
            assertEquals(-1L, db.pendingSessionDao().insertIgnore(item))
            db.pendingSessionDao().recordError("idem-1", "CLOCK_SKEW_FUTURE", "手机时间超前 10 分钟")
            val alertA = db.pendingSessionDao().observeClockSkewAlert("pA").first()
            val alertB = db.pendingSessionDao().observeClockSkewAlert("pB").first()
            assertNotNull(alertA)
            assertEquals("CLOCK_SKEW_FUTURE", alertA!!.lastErrorCode)
            assertEquals(null, alertB)
        } finally {
            db.close()
        }
    }

    @Test
    fun offlineAudioEngineDecodesAssetsAndSpeaksWithoutError() {
        val engine = AndroidAudioEngine(context)
        try {
            Log.i("Mi6Benchmark", "OfflineAudio loadedClipCount=${engine.loadedClipCount}, ttsChinese=${engine.ttsChineseAvailable}")
            assertEquals("应完整加载 16 音效 + 27 词元 = 43 条离线音频", 43, engine.loadedClipCount)
            engine.speakOfflineTokens(listOf("3", "2", "1", "开始"), 60, 0)
        } finally {
            engine.close()
        }
    }
}
