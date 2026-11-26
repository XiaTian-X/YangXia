package com.yangxia.app

import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.text.TextLayoutResult
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.yangxia.app.player.CourseDto
import com.yangxia.app.player.LiveViewMath
import com.yangxia.app.player.MotionClipMetaDto
import com.yangxia.app.player.PlayerPlanResultDto
import com.yangxia.app.player.QuickJsTimelineProvider
import com.yangxia.app.service.WorkoutPhaseStatus
import com.yangxia.app.service.WorkoutSessionState
import com.yangxia.app.storage.CachedCourseEntity
import com.yangxia.app.storage.CachedProfileEntity
import com.yangxia.app.ui.screens.SummaryScreen
import com.yangxia.app.ui.screens.TodayScreen
import com.yangxia.app.ui.screens.WorkoutScreen
import com.yangxia.app.ui.theme.YangXiaTheme
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 小米 6 真机界面核对（不靠截图认）：在真机的实际窗口里渲染今天、跟练（竖屏、横屏）、练完三页，
 * 按语义树里各元素的实际位置核对——都在屏幕里、互不重叠、常驻声明不被截断且 16sp 以上；
 * 动作示意动图核对"已载入"状态，并比较两个时刻画出来的像素确实不一样（动图在动）。
 * 测得的窗口尺寸、各元素位置打到 logcat（标签 Mi6Ui）。
 */
@RunWith(AndroidJUnit4::class)
class Mi6UiLayoutTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val json = Json { ignoreUnknownKeys = true }
    private val testAssets = InstrumentationRegistry.getInstrumentation().context.assets
    private val appContext = InstrumentationRegistry.getInstrumentation().targetContext

    @After
    fun restoreOrientation() {
        rule.activityRule.scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED }
    }

    // ---------- 样例：带动作示意动图的黄金课程，用真机上的 QuickJS 排时间轴 ----------

    private class Fixture(val plan: PlayerPlanResultDto, val rawMap: Map<String, String>, val metaMap: Map<String, MotionClipMetaDto>)

    private fun fixture(): Fixture = runBlocking {
        val golden = json.parseToJsonElement(testAssets.open("golden-player.json").bufferedReader().use { it.readText() }).jsonObject
        val case = golden["cases"]!!.jsonArray.map { it.jsonObject }.first { it["id"]!!.jsonPrimitive.content == "motions-wrap-hold-loop-perside" }
        val provider = QuickJsTimelineProvider({ appContext.assets.open("player-runtime.js").bufferedReader().use { it.readText() } })
        val plan = try {
            provider.buildPlayerPlan(case["course"]!!.toString(), case["devicePrefs"]?.toString() ?: "{}", case["userPatch"]?.toString())
        } finally {
            provider.close()
        }
        val clips = json.parseToJsonElement(testAssets.open("data/motions.json").bufferedReader().use { it.readText() }).jsonObject["clips"]!!.jsonObject
        val raw = mutableMapOf<String, String>()
        val meta = mutableMapOf<String, MotionClipMetaDto>()
        // 和 YangXiaRepository.loadMotionClips 同一种拆法
        for ((id, el) in clips) {
            val obj = el.jsonObject
            val lottie = obj["lottie"]!!.jsonObject
            raw[id] = lottie.toString()
            meta[id] = MotionClipMetaDto(
                exercises = obj["exercises"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),
                frames = obj["frames"]?.jsonPrimitive?.intOrNull ?: 24,
                dur = obj["dur"]?.jsonPrimitive?.doubleOrNull ?: 2.0,
                w = obj["w"]?.jsonPrimitive?.intOrNull ?: 200,
                h = obj["h"]?.jsonPrimitive?.intOrNull ?: 200,
                phases = obj["phases"]?.jsonObject?.mapValues { (_, v) -> v.jsonArray.mapNotNull { it.jsonPrimitive.doubleOrNull } },
                hold = obj["hold"]?.jsonPrimitive?.doubleOrNull,
                loop = obj["loop"]?.jsonPrimitive?.booleanOrNull ?: false,
                lottieIp = lottie["ip"]?.jsonPrimitive?.doubleOrNull ?: 0.0,
                lottieOp = lottie["op"]?.jsonPrimitive?.doubleOrNull,
            )
        }
        Fixture(plan, raw, meta)
    }

    /** 时间轴上有动图、在做动作的两个时刻（动图进度相差够大）。 */
    private fun motionTimes(f: Fixture): Pair<Double, Double> {
        val tl = f.plan.timeline
        val samples = (0 until (tl.totalDuration * 10).toInt()).map { it / 10.0 }
            .mapNotNull { t -> LiveViewMath.motionAt(tl, f.plan.course, f.metaMap, t)?.let { t to it } }
            .filter { (_, m) -> m.note == "doing" }
        assertTrue("样例课程里要有在做动作、带动图的时刻", samples.isNotEmpty())
        val (t1, m1) = samples.first()
        val t2 = samples.first { (_, m) -> m.clip == m1.clip && kotlin.math.abs(m.lottieProgress - m1.lottieProgress) > 0.2f }.first
        return t1 to t2
    }

    private fun workoutState(f: Fixture, t: Double) = WorkoutSessionState(
        status = WorkoutPhaseStatus.PLAYING,
        profileCode = "小夏",
        course = f.plan.course,
        plan = f.plan,
        elapsedSec = t,
    )

    // ---------- 位置核对 ----------

    private fun bounds(tag: String): Rect = rule.onNodeWithTag(tag, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot

    /** 和 MainActivity 一样：内容放在避开状态栏、导航栏的安全区里。 */
    private fun safe(content: @Composable () -> Unit) {
        rule.setContent { YangXiaTheme { Box(Modifier.fillMaxSize().safeDrawingPadding().testTag("safe-area")) { content() } } }
    }

    private fun rootRect(): Rect = rule.onNodeWithTag("safe-area").fetchSemanticsNode().boundsInRoot

    private fun dp(px: Float) = px / appContext.resources.displayMetrics.density

    private fun describe(name: String, r: Rect) = "$name=[${dp(r.left).toInt()},${dp(r.top).toInt()} ${dp(r.width).toInt()}×${dp(r.height).toInt()}dp]"

    private fun assertLayout(screen: String, tags: List<String>) {
        val root = rootRect()
        val window = rule.onRoot().fetchSemanticsNode().boundsInRoot
        val rects = tags.associateWith { bounds(it) }
        Log.i("Mi6Ui", "$screen 窗口 ${dp(window.width).toInt()}×${dp(window.height).toInt()}dp、可用 ${describe("安全区", root)}；" + rects.entries.joinToString("；") { describe(it.key, it.value) })
        for ((tag, r) in rects) {
            assertTrue("$screen：$tag 没有显示出来（${describe(tag, r)}）", r.width > 1f && r.height > 1f)
            val tol = 1f
            assertTrue(
                "$screen：$tag 超出屏幕（${describe(tag, r)}，窗口 ${dp(root.width).toInt()}×${dp(root.height).toInt()}dp）",
                r.left >= root.left - tol && r.top >= root.top - tol && r.right <= root.right + tol && r.bottom <= root.bottom + tol,
            )
        }
        val list = rects.entries.toList()
        for (i in list.indices) for (j in i + 1 until list.size) {
            val (a, ra) = list[i]
            val (b, rb) = list[j]
            val inter = ra.intersect(rb)
            assertFalse("$screen：$a 和 $b 重叠（${describe(a, ra)}、${describe(b, rb)}）", inter.width > 1f && inter.height > 1f)
        }
    }

    private fun textLayout(tag: String): TextLayoutResult {
        val node = rule.onNodeWithTag(tag, useUnmergedTree = true).fetchSemanticsNode()
        val out = mutableListOf<TextLayoutResult>()
        node.config.getOrNull(SemanticsActions.GetTextLayoutResult)?.action?.invoke(out)
        assertTrue("$tag 取不到文字排版", out.isNotEmpty())
        return out.first()
    }

    private fun assertSafetyNote(screen: String) {
        val layout = textLayout("workout-safety")
        val text = layout.layoutInput.text.text
        assertEquals("$screen：常驻声明全文", "未经专业审核，不是医学建议，不能替代医生的判断。疼、头晕、胸闷马上停下。", text)
        assertFalse("$screen：常驻声明被截断", layout.hasVisualOverflow)
        assertFalse("$screen：常驻声明有省略号", (0 until layout.lineCount).any { layout.isLineEllipsized(it) })
        assertTrue("$screen：常驻声明字号 ${layout.layoutInput.style.fontSize}", layout.layoutInput.style.fontSize.value >= 16f)
        Log.i("Mi6Ui", "$screen 常驻声明 ${layout.lineCount} 行、${layout.layoutInput.style.fontSize}")
    }

    private fun setOrientation(landscape: Boolean) {
        rule.activityRule.scenario.onActivity {
            it.requestedOrientation = if (landscape) ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE else ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        }
        val want = if (landscape) Configuration.ORIENTATION_LANDSCAPE else Configuration.ORIENTATION_PORTRAIT
        rule.waitUntil(10_000) {
            var ok = false
            rule.activityRule.scenario.onActivity { ok = it.resources.configuration.orientation == want && it.window.decorView.width > 0 }
            ok
        }
    }

    private val workoutTags = listOf(
        "workout-title", "workout-left", "workout-end", "workout-segments", "workout-motion", "workout-ring",
        "workout-phase", "workout-pause", "workout-stage-上一段", "workout-stage-下一段", "workout-safety",
    )

    // ---------- 跟练：竖屏、横屏 ----------

    @Test
    fun workoutPortraitFitsMi6() {
        val f = fixture()
        setOrientation(landscape = false)
        val (t1, _) = motionTimes(f)
        safe { WorkoutScreen(workoutState(f, t1), f.rawMap, f.metaMap, {}, {}, {}, {}) }
        rule.waitForIdle()
        assertLayout("跟练竖屏", workoutTags + "workout-next-card")
        assertSafetyNote("跟练竖屏")
    }

    @Test
    fun workoutLandscapeFitsMi6() {
        val f = fixture()
        setOrientation(landscape = true)
        val (t1, _) = motionTimes(f)
        safe { WorkoutScreen(workoutState(f, t1), f.rawMap, f.metaMap, {}, {}, {}, {}) }
        rule.waitForIdle()
        val root = rootRect()
        assertTrue("横屏：窗口要宽大于高", root.width > root.height)
        assertLayout("跟练横屏", workoutTags + "workout-next-card")
        assertSafetyNote("跟练横屏")
        // 横屏三栏：示意图在左、次数在中、按钮在右
        val motion = bounds("workout-motion")
        val ring = bounds("workout-ring")
        val pause = bounds("workout-pause")
        assertTrue("横屏：示意图在次数左边", motion.right <= ring.left)
        assertTrue("横屏：暂停在次数右边", pause.left >= ring.right)
    }

    // ---------- 动作示意动图：载入、在动 ----------

    @Test
    fun motionLottieLoadsAndAnimatesOnMi6() {
        val f = fixture()
        setOrientation(landscape = false)
        val (t1, t2) = motionTimes(f)
        var elapsed by mutableDoubleStateOf(t1)
        safe { WorkoutScreen(workoutState(f, elapsed), f.rawMap, f.metaMap, {}, {}, {}, {}) }
        rule.waitUntil(10_000) {
            rule.onNodeWithTag("workout-motion-lottie", useUnmergedTree = true).fetchSemanticsNode()
                .config.getOrNull(SemanticsProperties.StateDescription)?.startsWith("动图已载入") == true
        }
        val state1 = rule.onNodeWithTag("workout-motion-lottie", useUnmergedTree = true).fetchSemanticsNode().config[SemanticsProperties.StateDescription]
        val img1 = rule.onNodeWithTag("workout-motion-lottie", useUnmergedTree = true).captureToImage().asAndroidBitmap()
        elapsed = t2
        rule.waitForIdle()
        val state2 = rule.onNodeWithTag("workout-motion-lottie", useUnmergedTree = true).fetchSemanticsNode().config[SemanticsProperties.StateDescription]
        val img2 = rule.onNodeWithTag("workout-motion-lottie", useUnmergedTree = true).captureToImage().asAndroidBitmap()
        Log.i("Mi6Ui", "动图 t=$t1 → $state1；t=$t2 → $state2；画面 ${img1.width}×${img1.height}px")
        assertTrue("动图画出了东西（不是一片底色）", distinctColors(img1) > 2)
        val changed = changedPixelRatio(img1, img2)
        Log.i("Mi6Ui", "两个时刻画面变化的像素占 ${"%.1f".format(changed * 100)}%")
        assertTrue("两个时刻的动图画面要不一样（实际变化 ${"%.2f".format(changed * 100)}%）", changed > 0.005)
    }

    private fun distinctColors(b: Bitmap): Int {
        val set = HashSet<Int>()
        for (y in 0 until b.height step 4) for (x in 0 until b.width step 4) set.add(b.getPixel(x, y))
        return set.size
    }

    private fun changedPixelRatio(a: Bitmap, b: Bitmap): Double {
        assertEquals(a.width, b.width)
        assertEquals(a.height, b.height)
        var changed = 0
        var total = 0
        for (y in 0 until a.height step 2) for (x in 0 until a.width step 2) {
            total++
            if (a.getPixel(x, y) != b.getPixel(x, y)) changed++
        }
        return changed.toDouble() / total
    }

    /** 像用户一样把可滚动的那一页一直往上滑，滑到底。 */
    private fun scrollToEnd() {
        repeat(12) { rule.onNode(hasScrollAction()).performTouchInput { swipeUp() } }
        rule.waitForIdle()
    }

    // ---------- 今天：练前确认、底部开始按钮不压内容 ----------

    private val seniorEnvelope = """
        {"schema":"yangxia.delivery/1","declaration":"未经专业审核，不是医学建议，不能替代医生的判断",
         "course":{"id":"a65-w1-A","name":"第 1 周 · A 日","age":"a65",
          "source":{"product":"65岁以上-椅子辅助版","week":1,"day":"A","segment":1,"phase":"起始"},
          "blocks":[{"kind":"sets","items":[
           {"exercise":"a65-sit","name":"坐站起","sets":1,"reps":8,"rest":60,"tempo":{"start":"up","up":2,"down":2},"quote":["坐在椅子前半，双脚踩稳"]},
           {"exercise":"a65-calf","name":"扶椅踮脚","sets":1,"reps":10,"rest":60,"tempo":{"start":"up","up":1,"top":1,"down":2}},
           {"exercise":"a65-side","name":"扶椅侧抬腿","sets":1,"reps":8,"perSide":true,"rest":60,"tempo":{"start":"up","up":2,"down":2}},
           {"exercise":"a65-wall","name":"扶墙俯卧撑","sets":1,"reps":8,"rest":60,"tempo":{"start":"down","down":2,"up":1}},
           {"exercise":"a65-row","name":"坐姿夹背划船","sets":1,"reps":10,"rest":60,"tempo":{"start":"up","up":1,"top":2,"down":2}}]}]},
         "follow":[{"name":"扶椅前后脚站","reason":"平衡动作照计划单上的原文做"}],
         "notes":["本周不做：脚跟脚尖走"],
         "checks":[{"kind":"fall","ask":"上次练完以后，有没有摔倒、差点摔倒、头晕","stop":"今天先不跟练：告诉家人，先问医生。"},
                   {"kind":"condition","condition":"家里没有别人","ask":"训练的时候，是不是家里只有你一个人","recorded":false,"conservative":true,
                    "hint":"和档案记的不一样时，照成品原文换做法（扶台面侧向走那一项）","stop":"今天和档案记的不一样，这节课是照档案排的：先在网页上改训练条件、重新发课，再来练"}],
         "minutes":8}
    """.trimIndent()

    @Test
    fun todayChecksAndStartBarOnMi6() {
        setOrientation(landscape = false)
        val profile = CachedProfileEntity("p65", "夏老", "a65", "65岁以上-椅子辅助版", true, false, null, null, "2026-11-02T00:00:00Z")
        val course = CachedCourseEntity("c65", "p65", "a65-w1-A", "第 1 周 · A 日", 1, 1, "A", false, "h", seniorEnvelope, null, "active", null, "2026-11-02T00:00:00Z")
        var started = 0
        safe {
            TodayScreen(
                profiles = listOf(profile), activeProfile = profile, isMobileBound = true, courses = listOf(course),
                pendingSessions = emptyList(), clockSkewAlert = null, busy = false, error = null, message = null,
                onSelectProfile = {}, onRefresh = {}, onSyncPending = {}, onStartCourse = { started++ }, onOpenSettings = {},
            )
        }
        rule.waitForIdle()
        assertLayout("今天（首屏）", listOf("today-checks", "today-startbar"))
        val start = rule.onNodeWithText("先回答上面的练前确认")
        start.assertIsNotEnabled()
        // 摔倒答"有"：不开练
        rule.onNodeWithText("有", useUnmergedTree = true).performClick()
        rule.onNodeWithText("今天先不跟练：告诉家人，先问医生。").assertExists()
        rule.onNodeWithText("今天先不跟练").assertIsNotEnabled()
        // 改成"没有"；家里只有自己（档案记的是有人在）：不开练
        rule.onNodeWithText("没有", useUnmergedTree = true).performClick()
        rule.onNodeWithText("是", useUnmergedTree = true).performClick()
        rule.onNodeWithText("这节课是照档案排的", substring = true).assertExists()
        rule.onNodeWithText("今天先不跟练").assertIsNotEnabled()
        // 和档案一样（有人在）：可以开练
        rule.onNodeWithText("不是", useUnmergedTree = true).performClick()
        rule.onNodeWithText("开始跟练", substring = true).assertIsEnabled().performClick()
        assertEquals(1, started)
        // 滚到最底下：声明在开始按钮上面，不被压住
        scrollToEnd()
        val disclaimer = bounds("today-disclaimer")
        val bar = bounds("today-startbar")
        Log.i("Mi6Ui", "今天（滚到底）" + describe("today-disclaimer", disclaimer) + "；" + describe("today-startbar", bar))
        assertTrue("今天：滚到底以后声明被底部按钮压住", disclaimer.bottom <= bar.top + 1f)
    }

    // ---------- 练完：最后一项能滚到底部按钮上面 ----------

    @Test
    fun summaryScrollsClearOfBottomBarOnMi6() {
        val f = fixture()
        setOrientation(landscape = false)
        val course: CourseDto = f.plan.course
        safe {
            SummaryScreen(profileCode = "小夏", course = course, initialSetsDone = course.allItems().map { 1 }, busy = false, elapsedSec = 485.0,
                onSubmit = { _, _, _, _ -> }, onDiscard = {})
        }
        rule.waitForIdle()
        scrollToEnd()
        val note = bounds("summary-note")
        val bottom = bounds("summary-bottom")
        Log.i("Mi6Ui", "练完（滚到底）" + describe("summary-note", note) + "；" + describe("summary-bottom", bottom))
        assertTrue("练完：备注滚到底以后被底部按钮压住", note.bottom <= bottom.top + 1f)
        assertLayout("练完（底部）", listOf("summary-bottom"))
        assertNotNull(rule.onNodeWithText("先选整体感受").fetchSemanticsNode())
    }
}
