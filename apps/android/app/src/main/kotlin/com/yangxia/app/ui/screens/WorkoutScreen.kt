package com.yangxia.app.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
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
import com.yangxia.app.player.TimelineDto
import com.yangxia.app.service.WorkoutPhaseStatus
import com.yangxia.app.service.WorkoutSessionState
import com.yangxia.app.ui.theme.YangXiaColors
import kotlinx.coroutines.delay
import kotlin.math.ceil

/** 跟练页常驻的安全声明全文（v1 审查定的必须项：含"疼、头晕、胸闷马上停下"）。 */
const val WORKOUT_SAFETY_TEXT = "未经专业审核，不是医学建议，不能替代医生的判断。疼、头晕、胸闷马上停下。"

@Composable
fun WorkoutSafetyNote(modifier: Modifier = Modifier) {
    Text(
        text = buildAnnotatedString {
            append("未经专业审核，不是医学建议，不能替代医生的判断。")
            withStyle(SpanStyle(color = YangXiaColors.WorkoutStop, fontWeight = FontWeight.Bold)) { append("疼、头晕、胸闷马上停下。") }
        },
        color = Color(0xFFC9D4CD),
        fontSize = 16.sp,
        lineHeight = 22.sp,
        modifier = modifier.fillMaxWidth(),
    )
}

private fun formatClock(sec: Double): String {
    val s = ceil(sec.coerceAtLeast(0.0)).toInt()
    return "%02d:%02d".format(s / 60, s % 60)
}

/** 顶部分段进度：每个组段、休息段一格（准备段不单列），走过的满格、正在做的按进度。 */
private fun segmentFills(tl: TimelineDto, stageIndex: Int, t: Double): List<Float> =
    tl.stages.indices.mapNotNull { i ->
        if (LiveViewMath.parseStage(tl.stages[i].id)?.kind == "prep") return@mapNotNull null
        val (a, b) = LiveViewMath.stageSpan(tl, i)
        when {
            i < stageIndex -> 1f
            i > stageIndex -> 0f
            else -> ((t - a) / (b - a).coerceAtLeast(0.001)).toFloat().coerceIn(0f, 1f)
        }
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
    val curStageIdx = remember(timeline, state.elapsedSec) {
        if (timeline != null) LiveViewMath.stageIndexAt(timeline, state.elapsedSec) else 0
    }
    val canNextStage = timeline != null && curStageIdx < timeline.stages.lastIndex
    val fills = remember(timeline, curStageIdx, state.elapsedSec) {
        if (timeline != null) segmentFills(timeline, curStageIdx.coerceAtLeast(0), state.elapsedSec) else emptyList()
    }
    val leftText = formatClock(frame?.left ?: 0.0)

    BoxWithConstraints(
        modifier = Modifier
            .fillMaxSize()
            .background(YangXiaColors.WorkoutGround)
            .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        val isLandscape = maxWidth > maxHeight
        val compact = !isLandscape && maxHeight < 640.dp

        if (isLandscape) {
            Row(modifier = Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Column(
                    modifier = Modifier.weight(1.05f).fillMaxHeight(),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    TitleBlock(frame, titleSp = 19)
                    MotionLottieCard(
                        figure = figure,
                        rawJson = figure?.let { motionRawMap[it.clip] },
                        fallbackNote = frame?.phase ?: "",
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                        paused = isPaused,
                    )
                    WorkoutSafetyNote()
                }
                Column(
                    modifier = Modifier.weight(1.2f).fillMaxHeight(),
                    verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterVertically),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    SegmentBar(fills)
                    CounterRing(frame, ringSize = 170.dp, bigFontSp = 72)
                    PhasePill(frame)
                }
                Column(
                    modifier = Modifier.weight(0.8f).fillMaxHeight(),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                        LeftClock(leftText)
                        EndButton(onFinish)
                    }
                    NextCard(frame?.next ?: "", stacked = true)
                    Spacer(Modifier.weight(1f))
                    PauseButton(isPaused, onTogglePause, height = 72.dp)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        StageButton("上一段", true, onPrevStage, Modifier.weight(1f), height = 52.dp)
                        StageButton("下一段", canNextStage, onNextStage, Modifier.weight(1f), height = 52.dp)
                    }
                }
            }
        } else {
            Column(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(if (compact) 8.dp else 10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    TitleBlock(frame, titleSp = if (compact) 19 else 21, modifier = Modifier.weight(1f))
                    LeftClock(leftText)
                    Spacer(Modifier.width(10.dp))
                    EndButton(onFinish)
                }
                SegmentBar(fills)
                MotionLottieCard(
                    figure = figure,
                    rawJson = figure?.let { motionRawMap[it.clip] },
                    fallbackNote = frame?.phase ?: "",
                    modifier = Modifier.fillMaxWidth().height(if (compact) 92.dp else 150.dp),
                    paused = isPaused,
                )
                Column(
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
                ) {
                    CounterRing(frame, ringSize = if (compact) 128.dp else 206.dp, bigFontSp = if (compact) 52 else 88)
                    PhasePill(frame)
                    NextCard(frame?.next ?: "", stacked = false)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    StageButton("上一段", true, onPrevStage, Modifier.weight(1f), height = if (compact) 54.dp else 62.dp)
                    PauseButton(isPaused, onTogglePause, Modifier.weight(1.5f), height = if (compact) 58.dp else 70.dp)
                    StageButton("下一段", canNextStage, onNextStage, Modifier.weight(1f), height = if (compact) 54.dp else 62.dp)
                }
                Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(YangXiaColors.WorkoutTrack))
                WorkoutSafetyNote()
            }
        }
    }
}

@Composable
private fun TitleBlock(frame: LiveFrame?, titleSp: Int, modifier: Modifier = Modifier) {
    Column(modifier = modifier) {
        if (!frame?.sub.isNullOrBlank()) {
            Text(frame.sub, color = YangXiaColors.WorkoutInkMuted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text(
            text = frame?.title?.ifBlank { "准备开始" } ?: "准备开始",
            color = YangXiaColors.WorkoutInk,
            fontSize = titleSp.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun LeftClock(leftText: String) {
    Column(horizontalAlignment = Alignment.End) {
        Text("还剩", color = YangXiaColors.WorkoutInkMuted, fontSize = 12.sp)
        Text(leftText, color = YangXiaColors.WorkoutInk, fontSize = 17.sp, fontWeight = FontWeight.Bold)
    }
}

/** 结束要在 3 秒内再点一次（防做动作时误碰）。 */
@Composable
private fun EndButton(onFinish: () -> Unit) {
    var armed by remember { mutableStateOf(false) }
    LaunchedEffect(armed) {
        if (armed) {
            delay(3000L)
            armed = false
        }
    }
    if (armed) {
        Button(
            onClick = onFinish,
            modifier = Modifier.height(44.dp),
            contentPadding = PaddingValues(horizontal = 12.dp),
            colors = ButtonDefaults.buttonColors(containerColor = YangXiaColors.Danger, contentColor = Color.White),
        ) { Text("再点一次结束", fontSize = 14.sp, fontWeight = FontWeight.Bold, maxLines = 1, softWrap = false) }
    } else {
        OutlinedButton(
            onClick = { armed = true },
            modifier = Modifier.height(44.dp),
            contentPadding = PaddingValues(horizontal = 14.dp),
            border = androidx.compose.foundation.BorderStroke(1.dp, Color(0xFF5A2F28)),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = YangXiaColors.WorkoutDanger),
        ) { Text("结束", fontSize = 15.sp, maxLines = 1, softWrap = false) }
    }
}

@Composable
private fun SegmentBar(fills: List<Float>) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        fills.forEach { f ->
            Box(
                modifier = Modifier.weight(1f).height(6.dp).clip(RoundedCornerShape(3.dp)).background(YangXiaColors.WorkoutTrack),
            ) {
                if (f > 0f) Box(modifier = Modifier.fillMaxWidth(f).fillMaxHeight().background(YangXiaColors.WorkoutAccent))
            }
        }
    }
}

@Composable
private fun MotionLottieCard(
    figure: FigureFrame?,
    rawJson: String?,
    fallbackNote: String,
    modifier: Modifier,
    paused: Boolean,
) {
    Box(
        modifier = modifier.clip(RoundedCornerShape(20.dp)).background(YangXiaColors.MotionCardLight).padding(8.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (!rawJson.isNullOrBlank() && figure != null) {
            val composition by rememberLottieComposition(LottieCompositionSpec.JsonString(rawJson), cacheKey = figure.clip)
            LottieAnimation(composition = composition, progress = { figure.lottieProgress }, modifier = Modifier.fillMaxSize())
        } else {
            Text(
                text = fallbackNote.ifBlank { "跟着语音和呼吸节拍做" },
                color = YangXiaColors.Ink2,
                fontSize = 15.sp,
            )
        }
        Text(
            text = if (figure?.perSide == true) "动作示意 · 示意一侧" else "动作示意",
            color = YangXiaColors.Ink2,
            fontSize = 12.sp,
            modifier = Modifier.align(Alignment.BottomStart).padding(4.dp),
        )
        if (paused) {
            Text(
                text = "已暂停",
                color = YangXiaColors.WorkoutGround,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.align(Alignment.TopEnd).clip(RoundedCornerShape(50)).background(YangXiaColors.ExhaleRing).padding(horizontal = 10.dp, vertical = 3.dp),
            )
        }
    }
}

@Composable
private fun CounterRing(frame: LiveFrame?, ringSize: Dp, bigFontSp: Int) {
    val (disc, edge) = when (frame?.breath) {
        "inhale" -> YangXiaColors.InhaleDisc to YangXiaColors.InhaleRing
        "exhale" -> YangXiaColors.ExhaleDisc to YangXiaColors.ExhaleRing
        else -> YangXiaColors.WorkoutCard to YangXiaColors.WorkoutLine
    }
    val sweep = ((frame?.ring ?: 0.0) * 360.0).toFloat()
    Box(modifier = Modifier.size(ringSize), contentAlignment = Alignment.Center) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val stroke = 10.dp.toPx()
            drawArc(color = YangXiaColors.WorkoutTrack, startAngle = 0f, sweepAngle = 360f, useCenter = false, style = Stroke(width = stroke))
            drawArc(color = YangXiaColors.WorkoutAccent, startAngle = -90f, sweepAngle = sweep, useCenter = false, style = Stroke(width = stroke, cap = StrokeCap.Round))
            val r = size.minDimension / 2f * 0.79f
            drawCircle(color = disc, radius = r)
            drawCircle(color = edge, radius = r, style = Stroke(width = 3.dp.toPx()))
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            if (!frame?.over.isNullOrBlank()) Text(frame.over, color = YangXiaColors.WorkoutInkMuted, fontSize = 13.sp)
            Text(
                text = frame?.big?.ifBlank { "--" } ?: "--",
                color = YangXiaColors.WorkoutInk,
                fontSize = bigFontSp.sp,
                lineHeight = bigFontSp.sp,
                fontWeight = FontWeight.ExtraBold,
            )
            if (!frame?.small.isNullOrBlank()) Text(frame.small, color = YangXiaColors.WorkoutInkMuted, fontSize = 17.sp)
        }
    }
}

/** 这一拍在做什么：吸气蓝、呼气橙，带节奏秒数。 */
@Composable
private fun PhasePill(frame: LiveFrame?) {
    val phase = frame?.phase.orEmpty()
    if (phase.isBlank()) return
    val (bg, line, dot, text) = when (frame?.breath) {
        "inhale" -> listOf(YangXiaColors.InhaleDisc, Color(0xFF2A4A6B), YangXiaColors.InhaleRing, YangXiaColors.InhaleText)
        "exhale" -> listOf(YangXiaColors.ExhaleDisc, Color(0xFF6B4A22), YangXiaColors.ExhaleRing, YangXiaColors.ExhaleText)
        else -> listOf(YangXiaColors.WorkoutCard, YangXiaColors.WorkoutLine, YangXiaColors.WorkoutAccent, YangXiaColors.WorkoutInk)
    }
    Row(
        modifier = Modifier.clip(RoundedCornerShape(50)).background(bg).border(1.dp, line, RoundedCornerShape(50)).padding(horizontal = 16.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(modifier = Modifier.size(10.dp).clip(CircleShape).background(dot))
        Text(phase, color = text, fontSize = 20.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (!frame?.phaseSec.isNullOrBlank()) Text(frame!!.phaseSec, color = dot, fontSize = 16.sp)
    }
}

@Composable
private fun NextCard(next: String, stacked: Boolean) {
    if (next.isBlank()) return
    if (stacked) {
        Column(
            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(YangXiaColors.WorkoutCard).padding(horizontal = 12.dp, vertical = 9.dp),
        ) {
            Text("接下来", color = YangXiaColors.WorkoutInkMuted, fontSize = 12.sp)
            Text(next, color = YangXiaColors.WorkoutInk, fontSize = 14.sp)
        }
    } else {
        Row(
            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(YangXiaColors.WorkoutCard).padding(horizontal = 14.dp, vertical = 9.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("接下来", color = YangXiaColors.WorkoutInkMuted, fontSize = 14.sp)
            Text(next, color = YangXiaColors.WorkoutInk, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 10.dp))
        }
    }
}

@Composable
private fun PauseButton(isPaused: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier.fillMaxWidth(), height: Dp) {
    Button(
        onClick = onClick,
        modifier = modifier.height(height),
        shape = RoundedCornerShape(22.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = if (isPaused) YangXiaColors.ExhaleRing else YangXiaColors.WorkoutAccent,
            contentColor = YangXiaColors.WorkoutGround,
        ),
    ) { Text(if (isPaused) "继续" else "暂停", fontSize = 20.sp, fontWeight = FontWeight.Bold, maxLines = 1, softWrap = false) }
}

@Composable
private fun StageButton(label: String, enabled: Boolean, onClick: () -> Unit, modifier: Modifier, height: Dp) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.height(height),
        shape = RoundedCornerShape(20.dp),
        contentPadding = PaddingValues(horizontal = 6.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, YangXiaColors.WorkoutLine),
        colors = ButtonDefaults.outlinedButtonColors(containerColor = YangXiaColors.WorkoutCard, contentColor = YangXiaColors.WorkoutInk),
    ) { Text(label, fontSize = 15.sp, maxLines = 1, softWrap = false) }
}
