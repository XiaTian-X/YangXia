package com.yangxia.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// 复用阶段 8b 与网页端一致的暖白纸面 + 叶绿主色 + 深色跟练色板
object YangXiaColors {
    val Ground = Color(0xFFF6F3EC)
    val Surface = Color(0xFFFFFFFF)
    val Surface2 = Color(0xFFEFEBE2)
    val Line = Color(0xFFE2DDD2)
    val Ink = Color(0xFF1D2B24)
    val Ink2 = Color(0xFF4F5D55)
    val Accent = Color(0xFF2E7D5B)
    val AccentSoft = Color(0xFFDDEFE5)
    val AccentStrong = Color(0xFF1F5C42)

    val Inhale = Color(0xFF2F6FB0)
    val InhaleSoft = Color(0xFFDCE9F6)
    val Exhale = Color(0xFFB8641F)
    val ExhaleSoft = Color(0xFFF8E6D3)

    val Warn = Color(0xFF9A5B16)
    val WarnSoft = Color(0xFFFBF0DE)
    val Danger = Color(0xFFB23B2A)
    val DangerSoft = Color(0xFFFBE7E3)

    // 深色沉浸跟练页（Lottie 动图外层套 #F9FAFB 浅色圆角底卡）
    val WorkoutGround = Color(0xFF111916)
    val WorkoutSurface = Color(0xFF1C2722)
    val WorkoutInk = Color(0xFFF4F6F4)
    val WorkoutInkMuted = Color(0xFFAAB8B0)
    val MotionCardLight = Color(0xFFF9FAFB)
}

private val YangXiaLightScheme = lightColorScheme(
    primary = YangXiaColors.Accent,
    onPrimary = Color.White,
    primaryContainer = YangXiaColors.AccentSoft,
    onPrimaryContainer = YangXiaColors.AccentStrong,
    secondary = YangXiaColors.Inhale,
    onSecondary = Color.White,
    background = YangXiaColors.Ground,
    onBackground = YangXiaColors.Ink,
    surface = YangXiaColors.Surface,
    onSurface = YangXiaColors.Ink,
    surfaceVariant = YangXiaColors.Surface2,
    onSurfaceVariant = YangXiaColors.Ink2,
    outline = YangXiaColors.Line,
    error = YangXiaColors.Danger,
    onError = Color.White,
    errorContainer = YangXiaColors.DangerSoft,
    onErrorContainer = YangXiaColors.Danger,
)

private val YangXiaTypography = Typography(
    headlineSmall = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Bold),
    titleMedium = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.Bold),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 17.sp),
)

@Composable
fun YangXiaTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = YangXiaLightScheme,
        typography = YangXiaTypography,
        content = content,
    )
}
