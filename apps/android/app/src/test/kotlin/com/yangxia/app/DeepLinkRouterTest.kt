package com.yangxia.app

import com.yangxia.app.deeplink.DeepLinkParseResult
import com.yangxia.app.deeplink.DeepLinkResolution
import com.yangxia.app.deeplink.DeepLinkRouter
import com.yangxia.app.deeplink.DeepLinkRuntimeContext
import com.yangxia.app.deeplink.DeepLinkTarget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DeepLinkRouterTest {

    private val pidA = "11111111-1111-4111-8111-111111111111"
    private val pidB = "22222222-2222-4222-8222-222222222222"
    private val pidChild = "33333333-3333-4333-8333-333333333333"
    private val cidOk = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private val cidInvalid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

    private fun baseCtx() = DeepLinkRuntimeContext(
        hasServerConfigured = true,
        isLoggedIn = true,
        isWorkoutInProgress = false,
        currentProfileId = pidA,
        knownProfileIds = setOf(pidA, pidB, pidChild),
        unsupportedWorkoutProfileIds = setOf(pidChild),
        activeCourseProfileById = mapOf(cidOk to pidA),
        invalidatedCourseReasons = mapOf(cidInvalid to "档案降级已作废"),
    )

    @Test
    fun parserAcceptsOpaqueUuidsAndRejectsQueryOrSensitiveParams() {
        assertEquals(DeepLinkParseResult.Valid(DeepLinkTarget.Today), DeepLinkRouter.parse("yangxia://today"))
        assertEquals(DeepLinkParseResult.Valid(DeepLinkTarget.Profile(pidA)), DeepLinkRouter.parse("yangxia://profile/$pidA"))
        assertEquals(DeepLinkParseResult.Valid(DeepLinkTarget.Course(cidOk)), DeepLinkRouter.parse("yangxia://course/$cidOk"))

        // 拒绝任何携带查询参数、非 UUID 代号、或错误协议的链接
        assertTrue(DeepLinkRouter.parse("yangxia://today?weight=75") is DeepLinkParseResult.Rejected)
        assertTrue(DeepLinkRouter.parse("yangxia://profile/小夏") is DeepLinkParseResult.Rejected)
        assertTrue(DeepLinkRouter.parse("yangxia://course/not-a-uuid") is DeepLinkParseResult.Rejected)
        assertTrue(DeepLinkRouter.parse("https://yangxia.local/today") is DeepLinkParseResult.Rejected)
    }

    @Test
    fun resolvesAllSixSafetyBoundaryCasesProperly() {
        // 边界 ①：尚未配置服务器地址 -> 暂存路由
        val r1 = DeepLinkRouter.resolve(DeepLinkTarget.Today, baseCtx().copy(hasServerConfigured = false, isLoggedIn = false))
        assertTrue(r1 is DeepLinkResolution.DeferUntilServerSetup)

        // 边界 ②：未登录/Token 失效 -> 暂存路由
        val r2 = DeepLinkRouter.resolve(DeepLinkTarget.Profile(pidA), baseCtx().copy(isLoggedIn = false))
        assertTrue(r2 is DeepLinkResolution.DeferUntilLogin)

        // 边界 ③：目标档案与当前档案不同 -> 弹窗二次确认防误练
        val r3 = DeepLinkRouter.resolve(DeepLinkTarget.Profile(pidB), baseCtx())
        assertTrue(r3 is DeepLinkResolution.RequireProfileSwitchConfirm)
        assertEquals(pidB, (r3 as DeepLinkResolution.RequireProfileSwitchConfirm).targetProfileId)

        // 边界 ④：正在跟练中 -> 最高优先级拦截，绝不中断当前训练
        val r4 = DeepLinkRouter.resolve(DeepLinkTarget.Today, baseCtx().copy(isWorkoutInProgress = true))
        assertTrue(r4 is DeepLinkResolution.BlockedDuringWorkout)

        // 边界 ⑤：目标课程已被服务端作废或尚未同步 -> 拦截旧缓存课
        val r5a = DeepLinkRouter.resolve(DeepLinkTarget.Course(cidInvalid), baseCtx())
        assertTrue(r5a is DeepLinkResolution.CourseUnavailableOrInvalidated)
        val r5b = DeepLinkRouter.resolve(DeepLinkTarget.Course("cccccccc-cccc-4ccc-8ccc-cccccccccccc"), baseCtx())
        assertTrue(r5b is DeepLinkResolution.CourseUnavailableOrInvalidated)

        // 边界 ⑥：目标为 6–12 岁家长版无跟练课程档案 -> 提示前往网页端
        val r6 = DeepLinkRouter.resolve(DeepLinkTarget.Profile(pidChild), baseCtx())
        assertTrue(r6 is DeepLinkResolution.UnsupportedForMobileWorkout)

        // 正常同档案活跃课程 -> 直接跳转
        val rOk = DeepLinkRouter.resolve(DeepLinkTarget.Course(cidOk), baseCtx())
        assertEquals(DeepLinkResolution.NavigateNow(DeepLinkTarget.Course(cidOk)), rOk)
    }
}
