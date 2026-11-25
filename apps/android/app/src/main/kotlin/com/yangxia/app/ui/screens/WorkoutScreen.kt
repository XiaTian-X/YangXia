package com.yangxia.app.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.delay
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.airbnb.lottie.compose.LottieAnimation
import com.airbnb.lottie.compose.LottieCompositionSpec
import com.airbnb.lottie.compose.rememberLottieComposition
import com.yangxia.app.player.FigureFrame
import com.yangxia.app.player.LiveFrame
import com.yangxia.app.player.LiveViewMath
import com.yangxia.app.player.MotionClipMetaDto
import com.yangxia.app.service.WorkoutPhaseStatus
import com.yangxia.app.service.WorkoutSessionState
import com.yangxia.app.ui.theme.YangXiaColors
import kotlin.math.ceil

/** 跟练页常驻的安全声明全文（v1 审查定的必须项：含"疼、头晕、胸闷马上停下"）。 */
const val WORKOUT_SAFETY_TEXT = "未经专业审核，不是医学建议，不能替代医生的判断。疼、头晕、胸闷马上停下。"

@Composable
fun WorkoutSafetyNote(modifier: Modifier = Modifier) {
    Text(
        text = WORKOUT_SAFETY_TEXT,
        color = YangXiaColors.WorkoutInkMuted,
        fontSize = 16.sp,
        lineHeight = 21.sp,
        modifier = modifier.fillMaxWidth(),
    )
}

private fun formatClock(sec: Double): String {
    val s = ceil(sec.coerceAtLeast(0.0)).toInt()
    return "%02d:%02d".format(s / 60, s % 60)
}

@Composable
fun WorkoutScreen(
    state: WorkoutSessionState,
    motionRawMap: Map<String, String>,
    motionMetaMap: Map<String, MotionClipMetaDto>,
    onTogglePause: () -> Unit,
    onPrevStage: () -> Unit,
    onNextStage: () -> Unit,
    onFinish: () -> Unit,
) {
    val course = state.course
    val timeline = state.plan?.timeline
    val frame: LiveFrame? = remember(timeline, course, state.elapsedSec) {
        if (timeline != null && course != null) {
            val idx = LiveViewMath.eventIndexAt(timeline.events, state.elapsedSec)
            LiveViewMath.liveFrame(course, timeline, idx, state.elapsedSec)
        } else null
    }
    val figure: FigureFrame? = remember(timeline, course, motionMetaMap, state.elapsedSec) {
        if (timeline != null && course != null) LiveViewMath.motionAt(timeline, course, motionMetaMap, state.elapsedSec) else null
    }

    val isPaused = state.status == WorkoutPhaseStatus.PAUSED
    val totalDur = timeline?.totalDuration ?: 1.0
    val progressFrac = (state.elapsedSec / totalDur.coerceAtLeast(0.1)).toFloat().coerceIn(0f, 1f)
    val curStageIdx = remember(timeline, state.elapsedSec) {
        if (timeline != null) LiveViewMath.stageIndexAt(timeline, state.elapsedSec) else 0
    }
    val canNextStage = timeline != null && curStageIdx < timeline.stages.lastIndex

    BoxWithConstraints(
        modifier = Modifier
            .fillMaxSize()
            .background(YangXiaColors.WorkoutGround)
            .padding(horizontal = 14.dp, vertical = 10.dp),
    ) {
        val availHeight = maxHeight
        val isLandscape = maxWidth > maxHeight
        val isCompactPortrait = !isLandscape && availHeight < 610.dp

        if (isLandscape) {
            Row(
                modifier = Modifier.fillMaxSize(),
                horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Column(
                    modifier = Modifier.weight(1f).fillMaxHeight(),
                    verticalArrangement = Arrangement.SpaceBetween,
                ) {
                    WorkoutTopBar(
                        profileCode = state.profileCode,
                        courseName = course?.name ?: "跟练中",
                        leftText = formatClock(frame?.left ?: 0.0),
                        onFinish = onFinish,
                    )
                    MotionLottieCard(
                        figure = figure,
                        rawJson = figure?.let { motionRawMap[it.clip] },
                        fallbackNote = frame?.phase ?: "",
                        height = (availHeight - 160.dp).coerceIn(100.dp, 220.dp),
                    )
                    WorkoutSafetyNote()
                }
                Column(
                    modifier = Modifier.weight(1f).fillMaxHeight(),
                    verticalArrangement = Arrangement.SpaceBetween,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    LinearProgressIndicator(
                        progress = { progressFrac },
                        modifier = Modifier.fillMaxWidth().height(6.dp),
                        color = YangXiaColors.Accent,
                        trackColor = YangXiaColors.WorkoutSurface,
                    )
                    CounterAndBreathBlock(frame = frame, ringSize = 112.dp, bigFontSp = 40)
                    WorkoutControlsBar(
                        isPaused = isPaused,
                        canNext = canNextStage,
                        onTogglePause = onTogglePause,
                        onPrevStage = onPrevStage,
                        onNextStage = onNextStage,
                    )
                }
            }
        } else {
            Column(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.SpaceBetween,
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    WorkoutTopBar(
                        profileCode = state.profileCode,
                        courseName = course?.name ?: "跟练中",
                        leftText = formatClock(frame?.left ?: 0.0),
                        onFinish = onFinish,
                    )
                    LinearProgressIndicator(
                        progress = { progressFrac },
                        modifier = Modifier.fillMaxWidth().height(5.dp),
                        color = YangXiaColors.Accent,
                        trackColor = YangXiaColors.WorkoutSurface,
                    )
                }

                MotionLottieCard(
                    figure = figure,
                    rawJson = figure?.let { motionRawMap[it.clip] },
                    fallbackNote = frame?.phase ?: "",
                    height = if (isCompactPortrait) 120.dp else 196.dp,
                )

                CounterAndBreathBlock(
                    frame = frame,
                    ringSize = if (isCompactPortrait) 110.dp else 138.dp,
                    bigFontSp = if (isCompactPortrait) 40 else 52,
                )

                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    WorkoutControlsBar(
                        isPaused = isPaused,
                        canNext = canNextStage,
                        onTogglePause = onTogglePause,
                        onPrevStage = onPrevStage,
                        onNextStage = onNextStage,
                    )
                    WorkoutSafetyNote()
                }
            }
        }
    }
}

@Composable
private fun WorkoutTopBar(
    profileCode: String,
    courseName: String,
    leftText: String,
    onFinish: () -> Unit,
) {
    // 防做动作时误碰：结束需在 3 秒内再点一次确认（与 v1 编排器一致）
    var armEnd by remember { mutableStateOf(false) }
    LaunchedEffect(armEnd) {
        if (armEnd) {
            delay(3000L)
            armEnd = false
        }
    }
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = "$profileCode · $courseName",
                color = YangXiaColors.WorkoutInk,
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = "剩余 $leftText · 息屏仍持续语音报数",
                color = YangXiaColors.WorkoutInkMuted,
                fontSize = 12.sp,
                maxLines = 1,
            )
        }
        OutlinedButton(
            onClick = {
                if (armEnd) onFinish() else armEnd = true
            },
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 0.dp),
            colors = ButtonDefaults.outlinedButtonColors(
                contentColor = if (armEnd) YangXiaColors.Warn else YangXiaColors.WorkoutInk,
            ),
        ) {
            Text(if (armEnd) "再点结束" else "结束", fontSize = 13.sp, maxLines = 1, softWrap = false)
        }
    }
}

@Composable
private fun MotionLottieCard(
    figure: FigureFrame?,
    rawJson: String?,
    fallbackNote: String,
    height: Dp,
) {
    Card(
        modifier = Modifier.fillMaxWidth().height(height),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = YangXiaColors.MotionCardLight),
    ) {
        Box(modifier = Modifier.fillMaxSize().padding(8.dp), contentAlignment = Alignment.Center) {
            if (!rawJson.isNullOrBlank() && figure != null) {
                val composition by rememberLottieComposition(
                    LottieCompositionSpec.JsonString(rawJson),
                    cacheKey = figure.clip,
                )
                LottieAnimation(
                    composition = composition,
                    progress = { figure.lottieProgress },
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                Text(
                    text = fallbackNote.ifBlank { "跟随语音与呼吸节拍平稳完成动作" },
                    color = YangXiaColors.Ink2,
                    fontSize = 14.sp,
                )
            }
            if (figure?.perSide == true) {
                Text(
                    text = "单侧动作",
                    color = YangXiaColors.Inhale,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.align(Alignment.TopEnd).padding(4.dp),
                )
            }
        }
    }
}

@Composable
private fun CounterAndBreathBlock(
    frame: LiveFrame?,
    ringSize: Dp,
    bigFontSp: Int,
) {
    val ringColor = when (frame?.breath) {
        "inhale" -> YangXiaColors.Inhale
        "exhale" -> YangXiaColors.Exhale
        else -> YangXiaColors.Accent
    }
    val sweep = ((frame?.ring ?: 0.0) * 360.0).toFloat()

    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            text = frame?.title?.ifBlank { "准备开始" } ?: "准备开始",
            color = YangXiaColors.WorkoutInk,
            fontSize = 18.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (!frame?.sub.isNullOrBlank()) {
            Text(
                text = frame.sub,
                color = YangXiaColors.WorkoutInkMuted,
                fontSize = 12.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }

        Box(modifier = Modifier.size(ringSize), contentAlignment = Alignment.Center) {
            Canvas(modifier = Modifier.fillMaxSize()) {
                drawArc(
                    color = Color(0xFF2B3A33),
                    startAngle = 0f,
                    sweepAngle = 360f,
                    useCenter = false,
                    style = Stroke(width = 9.dp.toPx(), cap = StrokeCap.Round),
                )
                drawArc(
                    color = ringColor,
                    startAngle = -90f,
                    sweepAngle = sweep,
                    useCenter = false,
                    style = Stroke(width = 9.dp.toPx(), cap = StrokeCap.Round),
                )
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                if (!frame?.over.isNullOrBlank()) {
                    Text(frame.over, color = YangXiaColors.WorkoutInkMuted, fontSize = 11.sp)
                }
                Text(
                    text = frame?.big?.ifBlank { "--" } ?: "--",
                    color = YangXiaColors.WorkoutInk,
                    fontSize = bigFontSp.sp,
                    fontWeight = FontWeight.ExtraBold,
                )
                if (!frame?.small.isNullOrBlank()) {
                    Text(frame.small, color = YangXiaColors.WorkoutInkMuted, fontSize = 12.sp)
                }
            }
        }

        if (!frame?.phase.isNullOrBlank()) {
            Text(
                text = listOf(frame.phase, frame.phaseSec).filter { it.isNotBlank() }.joinToString(" · "),
                color = ringColor,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (!frame?.next.isNullOrBlank()) {
            Text(
                text = frame.next,
                color = YangXiaColors.WorkoutInkMuted,
                fontSize = 12.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        } else {
            Spacer(Modifier.height(4.dp))
        }
    }
}

@Composable
private fun WorkoutControlsBar(
    isPaused: Boolean,
    canNext: Boolean,
    onTogglePause: () -> Unit,
    onPrevStage: () -> Unit,
    onNextStage: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OutlinedButton(
            onClick = onPrevStage,
            modifier = Modifier.weight(1f).height(48.dp),
            contentPadding = PaddingValues(horizontal = 6.dp, vertical = 0.dp),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = YangXiaColors.WorkoutInk),
        ) {
            Text("上一段", fontSize = 14.sp, maxLines = 1, softWrap = false)
        }
        Button(
            onClick = onTogglePause,
            modifier = Modifier.weight(1.45f).height(50.dp),
            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp),
            colors = ButtonDefaults.buttonColors(containerColor = YangXiaColors.Accent),
        ) {
            Text(if (isPaused) "继续" else "暂停", fontSize = 17.sp, fontWeight = FontWeight.Bold, maxLines = 1, softWrap = false)
        }
        OutlinedButton(
            onClick = onNextStage,
            enabled = canNext,
            modifier = Modifier.weight(1f).height(48.dp),
            contentPadding = PaddingValues(horizontal = 6.dp, vertical = 0.dp),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = YangXiaColors.WorkoutInk),
        ) {
            Text("下一段", fontSize = 14.sp, maxLines = 1, softWrap = false)
        }
    }
}
