package com.yangxia.app.deeplink

import java.net.URI

/**
 * 需求 M8 Deep Link / 外部拉起解析与 6 种边界裁决引擎（纯 Kotlin，可直接在 JVM 单元测试全覆盖）：
 * 仅接受严格不透明 UUID，拒收任何携带健康/业务语义的查询参数，确保不泄露健康隐私：
 * - yangxia://today
 * - yangxia://profile/<uuid>
 * - yangxia://course/<uuid>
 */
sealed class DeepLinkTarget {
    data object Today : DeepLinkTarget()
    data class Profile(val profileId: String) : DeepLinkTarget()
    data class Course(val courseRecordId: String) : DeepLinkTarget()
}

sealed class DeepLinkParseResult {
    data class Valid(val target: DeepLinkTarget) : DeepLinkParseResult()
    data class Rejected(val reason: String) : DeepLinkParseResult()
}

data class DeepLinkRuntimeContext(
    val hasServerConfigured: Boolean,
    val isLoggedIn: Boolean,
    val isWorkoutInProgress: Boolean,
    val currentProfileId: String?,
    val knownProfileIds: Set<String>,
    val unsupportedWorkoutProfileIds: Set<String>,
    val activeCourseProfileById: Map<String, String>,
    val invalidatedCourseReasons: Map<String, String>,
)

sealed class DeepLinkResolution {
    /** 边界 ①：尚未配置服务器地址 -> 暂存路由，配置并登录后自动续跳 */
    data class DeferUntilServerSetup(val target: DeepLinkTarget) : DeepLinkResolution()

    /** 边界 ②：未登录或 Token 失效 -> 暂存路由，登录后自动续跳 */
    data class DeferUntilLogin(val target: DeepLinkTarget) : DeepLinkResolution()

    /** 边界 ③：目标档案与当前档案不同 -> 弹窗醒目展示代号二次确认后再切换 */
    data class RequireProfileSwitchConfirm(val targetProfileId: String, val target: DeepLinkTarget) : DeepLinkResolution()

    /** 边界 ④：正在跟练中 -> 拦截提示，绝不中断当前训练和已练组数 */
    data class BlockedDuringWorkout(val message: String) : DeepLinkResolution()

    /** 边界 ⑤：目标课程未同步或已被服务端作废 -> 拦截旧缓存课并提示下拉刷新 */
    data class CourseUnavailableOrInvalidated(val reason: String) : DeepLinkResolution()

    /** 边界 ⑥：目标为 6–12 岁无跟练课程档案 -> 提示前往网页端查看家长指导 */
    data class UnsupportedForMobileWorkout(val profileId: String, val message: String) : DeepLinkResolution()

    /** 无权访问或找不到目标档案 */
    data class AccessDenied(val message: String) : DeepLinkResolution()

    /** 安全校验全部通过，立即跳转 */
    data class NavigateNow(val target: DeepLinkTarget) : DeepLinkResolution()
}

object DeepLinkRouter {

    private val UUID_REGEX = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

    fun parse(rawUri: String?): DeepLinkParseResult {
        if (rawUri.isNullOrBlank()) return DeepLinkParseResult.Rejected("空链接")
        val uri = runCatching { URI(rawUri.trim()) }.getOrNull()
            ?: return DeepLinkParseResult.Rejected("链接格式无效")
        if (!uri.scheme.equals("yangxia", ignoreCase = true)) {
            return DeepLinkParseResult.Rejected("不支持的协议：${uri.scheme}")
        }
        // 安全约束：严禁通过 query/fragment/userInfo/port 传入任何健康参数或隐蔽字段
        if (uri.rawQuery != null || uri.rawFragment != null || uri.rawUserInfo != null || uri.port != -1) {
            return DeepLinkParseResult.Rejected("出于隐私安全，外部拉起链接不允许附带查询参数、锚点、用户信息或端口")
        }
        val host = uri.host?.lowercase() ?: return DeepLinkParseResult.Rejected("缺少目标路径")
        val segments = (uri.path ?: "").split("/").filter { it.isNotBlank() }

        return when (host) {
            "today" -> {
                if (segments.isNotEmpty()) DeepLinkParseResult.Rejected("yangxia://today 不接受多余路径")
                else DeepLinkParseResult.Valid(DeepLinkTarget.Today)
            }
            "profile" -> {
                if (segments.size != 1 || !UUID_REGEX.matches(segments[0])) {
                    DeepLinkParseResult.Rejected("档案标识必须为合法的不透明 UUID")
                } else {
                    DeepLinkParseResult.Valid(DeepLinkTarget.Profile(segments[0].lowercase()))
                }
            }
            "course" -> {
                if (segments.size != 1 || !UUID_REGEX.matches(segments[0])) {
                    DeepLinkParseResult.Rejected("课程标识必须为合法的不透明 UUID")
                } else {
                    DeepLinkParseResult.Valid(DeepLinkTarget.Course(segments[0].lowercase()))
                }
            }
            else -> DeepLinkParseResult.Rejected("未知的外部拉起路由：$host")
        }
    }

    /** 完整裁决架构 6.6 的全部 6 种边界情况。 */
    fun resolve(target: DeepLinkTarget, ctx: DeepLinkRuntimeContext): DeepLinkResolution {
        // 边界 ④ 优先级最高：绝不中断正在进行的跟练与已练组数
        if (ctx.isWorkoutInProgress) {
            return DeepLinkResolution.BlockedDuringWorkout("当前正在跟练中，已拦截外部跳转，避免中断训练与已练组数。")
        }
        // 边界 ①：尚未配置服务器地址
        if (!ctx.hasServerConfigured) {
            return DeepLinkResolution.DeferUntilServerSetup(target)
        }
        // 边界 ②：尚未登录或会话失效
        if (!ctx.isLoggedIn) {
            return DeepLinkResolution.DeferUntilLogin(target)
        }

        return when (target) {
            is DeepLinkTarget.Today -> DeepLinkResolution.NavigateNow(target)

            is DeepLinkTarget.Profile -> {
                if (target.profileId !in ctx.knownProfileIds) {
                    return DeepLinkResolution.AccessDenied("找不到对应档案或当前账号无权访问，请先在首页下拉刷新。")
                }
                if (target.profileId in ctx.unsupportedWorkoutProfileIds) {
                    return DeepLinkResolution.UnsupportedForMobileWorkout(
                        target.profileId,
                        "该档案为 6–12 岁家长版，手机端不导出跟练课程，请前往网页端查看指导文档。",
                    )
                }
                if (ctx.currentProfileId != null && ctx.currentProfileId != target.profileId) {
                    DeepLinkResolution.RequireProfileSwitchConfirm(target.profileId, target)
                } else {
                    DeepLinkResolution.NavigateNow(target)
                }
            }

            is DeepLinkTarget.Course -> {
                val invReason = ctx.invalidatedCourseReasons[target.courseRecordId]
                if (invReason != null) {
                    return DeepLinkResolution.CourseUnavailableOrInvalidated("该课程已被作废（$invReason），无法继续跟练，请下拉刷新获取最新课程。")
                }
                val ownerProfileId = ctx.activeCourseProfileById[target.courseRecordId]
                    ?: return DeepLinkResolution.CourseUnavailableOrInvalidated("本地尚未同步到该课程，请在「今天的课」下拉刷新后重试。")
                if (ownerProfileId in ctx.unsupportedWorkoutProfileIds) {
                    return DeepLinkResolution.UnsupportedForMobileWorkout(
                        ownerProfileId,
                        "6–12 岁家长版不支持手机跟练，请前往网页端查看。",
                    )
                }
                if (ctx.currentProfileId != null && ctx.currentProfileId != ownerProfileId) {
                    DeepLinkResolution.RequireProfileSwitchConfirm(ownerProfileId, target)
                } else {
                    DeepLinkResolution.NavigateNow(target)
                }
            }
        }
    }
}
