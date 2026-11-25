package com.yangxia.app.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.yangxia.app.player.CourseBlockDto
import com.yangxia.app.player.CourseItemDto
import com.yangxia.app.player.DeliveryEnvelopeDto
import com.yangxia.app.player.PreSessionCheckDto
import com.yangxia.app.storage.CachedCourseEntity
import com.yangxia.app.storage.CachedProfileEntity
import com.yangxia.app.storage.PendingSessionEntity
import com.yangxia.app.ui.theme.YangXiaColors
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

private val todayJson = Json { ignoreUnknownKeys = true }

@Serializable
private data class PlanLengthDto(val timeline: TimelineLengthDto = TimelineLengthDto())

@Serializable
private data class TimelineLengthDto(val totalDuration: Double = 0.0)

/** 服务端预算的时间轴总长（分钟，向上取整）；没有预算的不写时长。 */
private fun minutesOf(course: CachedCourseEntity): Int? {
    val raw = course.precomputedPlanJson ?: return null
    val total = runCatching { todayJson.decodeFromString(PlanLengthDto.serializer(), raw).timeline.totalDuration }.getOrNull() ?: return null
    return if (total > 0) kotlin.math.ceil(total / 60.0).toInt() else null
}

private val SAFETY_STOP = "练的时候疼、头晕、胸闷，马上停下。"

@Composable
fun TodayScreen(
    profiles: List<CachedProfileEntity>,
    activeProfile: CachedProfileEntity?,
    isMobileBound: Boolean,
    courses: List<CachedCourseEntity>,
    pendingSessions: List<PendingSessionEntity>,
    clockSkewAlert: PendingSessionEntity?,
    busy: Boolean,
    error: String?,
    message: String?,
    onSelectProfile: (String) -> Unit,
    onRefresh: () -> Unit,
    onSyncPending: () -> Unit,
    onStartCourse: (CachedCourseEntity) -> Unit,
    onOpenSettings: () -> Unit,
) {
    val activeCourses = courses.filter { it.status == "active" }
    val invalidatedCourses = courses.filter { it.status != "active" }
    var selectedId by remember { mutableStateOf<String?>(null) }
    val selected = activeCourses.firstOrNull { it.courseRecordId == selectedId } ?: activeCourses.firstOrNull()
    val env = remember(selected?.courseRecordId, selected?.envelopeJson) {
        selected?.let { c -> runCatching { todayJson.decodeFromString(DeliveryEnvelopeDto.serializer(), c.envelopeJson) }.getOrNull() }
    }
    val minutes = remember(selected?.courseRecordId, selected?.precomputedPlanJson, env?.minutes) { env?.minutes ?: selected?.let(::minutesOf) }
    // 练前确认的回答只用来决定能不能开练，不存、不传
    val answers = remember(selected?.courseRecordId) { mutableStateMapOf<Int, Boolean>() }
    val checks = env?.checks.orEmpty()
    val fallStop = checks.withIndex().any { (i, c) -> c.kind == "fall" && answers[i] == true }
    val unanswered = checks.indices.any { answers[it] == null }
    val canWorkout = activeProfile?.supportedForWorkout != false

    Box(modifier = Modifier.fillMaxSize().background(YangXiaColors.Ground)) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(start = 18.dp, end = 18.dp, top = 14.dp, bottom = if (selected != null && canWorkout) 104.dp else 18.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            TodayHeader(activeProfile = activeProfile, busy = busy, onRefresh = onRefresh, onOpenSettings = onOpenSettings)

            // 多档案切换（扫码绑定的手机固定一个档案，不显示）
            if (!isMobileBound && profiles.size > 1) {
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    profiles.forEach { p ->
                        FilterChip(selected = p.profileId == activeProfile?.profileId, onClick = { onSelectProfile(p.profileId) }, label = { Text(p.code) })
                    }
                }
            }

            if (clockSkewAlert != null) {
                Banner(
                    title = "手机的时间比服务器快，先停了同步",
                    body = clockSkewAlert.lastErrorMessage ?: "把手机时间调准，再点\"立即同步\"。",
                    bg = YangXiaColors.DangerSoft, fg = YangXiaColors.Danger,
                )
            }
            if (activeProfile?.hasConflict == true) {
                Banner(
                    title = "有一条练习记录要先处理",
                    body = activeProfile.conflictMessage ?: "在网页上的周复盘里处理最近的不适记录；处理之前不发新课。",
                    bg = YangXiaColors.WarnSoft, fg = YangXiaColors.Warn,
                )
            }
            if (!error.isNullOrBlank()) Banner(title = null, body = error, bg = YangXiaColors.DangerSoft, fg = YangXiaColors.Danger)
            if (!message.isNullOrBlank()) Banner(title = null, body = message, bg = YangXiaColors.AccentSoft, fg = YangXiaColors.AccentStrong)

            if (pendingSessions.isNotEmpty()) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(YangXiaColors.InhaleSoft, RoundedCornerShape(14.dp))
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("还有 ${pendingSessions.size} 条练习记录没传上", fontSize = 14.sp, color = YangXiaColors.InhaleInk, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    OutlinedButton(onClick = onSyncPending, enabled = !busy) { Text("立即同步", fontSize = 13.sp) }
                }
            }

            when {
                activeProfile != null && !activeProfile.supportedForWorkout -> InfoCard(
                    title = "6–12 岁家长版没有手机跟练",
                    body = "在网页上的「饮食与模板」看《${activeProfile.product}》，陪孩子做户外游戏。",
                )
                selected == null -> InfoCard(
                    title = "还没有发布的课",
                    body = "在网页上的「排课」发布这一周的课，再点右上角的「刷新」。",
                )
            }

            if (selected != null && canWorkout) {
                // 同时发了几天的课：先选练哪一天
                if (activeCourses.size > 1) {
                    Row(
                        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        activeCourses.forEach { c ->
                            FilterChip(
                                selected = c.courseRecordId == selected.courseRecordId,
                                onClick = { selectedId = c.courseRecordId },
                                label = { Text("第 ${c.week} 周 ${c.day} 日${if (c.half) " 半量" else ""}") },
                            )
                        }
                    }
                }

                CourseHead(course = selected, env = env, minutes = minutes)

                if (checks.isNotEmpty()) {
                    ChecksCard(checks = checks, answers = answers, onAnswer = { i, v -> answers[i] = v })
                }

                env?.course?.blocks?.takeIf { it.isNotEmpty() }?.let { MovesSection(blocks = it) }

                val followItems = env?.followItems().orEmpty()
                val notes = env?.noteLines().orEmpty()
                if (followItems.isNotEmpty() || notes.isNotEmpty()) FollowCard(followItems = followItems, notes = notes)

                Text(
                    "${(env?.declaration ?: "未经专业审核，不是医学建议，不能替代医生的判断").trimEnd('。')}。$SAFETY_STOP",
                    fontSize = 13.sp,
                    lineHeight = 21.sp,
                    color = YangXiaColors.Ink2,
                )
            }

            // 服务端作废了的课：锁住、写原因
            if (invalidatedCourses.isNotEmpty()) {
                Text("作废了的课（不能再练）", fontSize = 14.sp, fontWeight = FontWeight.Bold, color = YangXiaColors.Ink2)
                invalidatedCourses.forEach { ic ->
                    Banner(
                        title = "第 ${ic.week} 周 ${ic.day} 日",
                        body = "作废原因：${ic.invalidatedReason ?: "档案进度或模板改过了，用新发的课"}",
                        bg = YangXiaColors.WarnSoft, fg = YangXiaColors.Warn,
                    )
                }
            }
        }

        if (selected != null && canWorkout) {
            StartBar(
                modifier = Modifier.align(Alignment.BottomCenter),
                enabled = !busy && !unanswered && !fallStop,
                label = when {
                    fallStop -> "今天先不跟练"
                    unanswered -> "先回答上面的练前确认"
                    else -> "开始跟练"
                },
                onClick = { onStartCourse(selected) },
            )
        }
    }
}

@Composable
private fun TodayHeader(activeProfile: CachedProfileEntity?, busy: Boolean, onRefresh: () -> Unit, onOpenSettings: () -> Unit) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("养夏 · 跟练", fontSize = 15.sp, fontWeight = FontWeight.Bold, color = YangXiaColors.Ink)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.size(8.dp).background(if (activeProfile != null) YangXiaColors.Accent else YangXiaColors.Muted, CircleShape))
                Text(activeProfile?.code ?: "还没有档案", fontSize = 13.sp, color = YangXiaColors.Ink2)
            }
        }
        OutlinedButton(
            onClick = onRefresh,
            enabled = !busy,
            shape = RoundedCornerShape(14.dp),
            border = BorderStroke(1.dp, YangXiaColors.Line),
            modifier = Modifier.heightIn(min = 44.dp),
        ) { Text(if (busy) "刷新中" else "刷新", fontSize = 14.sp, color = YangXiaColors.Ink) }
        Spacer(Modifier.width(8.dp))
        OutlinedButton(
            onClick = onOpenSettings,
            shape = RoundedCornerShape(14.dp),
            border = BorderStroke(1.dp, YangXiaColors.Line),
            modifier = Modifier.heightIn(min = 44.dp),
        ) { Text("设置", fontSize = 14.sp, color = YangXiaColors.Ink) }
    }
}

@Composable
private fun CourseHead(course: CachedCourseEntity, env: DeliveryEnvelopeDto?, minutes: Int?) {
    val src = env?.course?.source
    val items = env?.course?.allItems().orEmpty()
    val sets = env?.course?.blocks.orEmpty().filter { it.kind != "circuit" }.flatMap { b -> b.items.map { it.sets ?: 1 } }.distinct()
    val phase = src?.phase?.takeIf { it.isNotBlank() }?.let { if (it.endsWith("期")) it else "${it}期" } ?: "起始期"
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            listOfNotNull("今天", src?.product?.takeIf { it.isNotBlank() }, "${phase}第 ${course.segment} 段").joinToString(" · "),
            fontSize = 13.sp,
            color = YangXiaColors.Ink2,
        )
        Text(
            "第 ${course.week} 周 · ${course.day} 日${if (course.half) "（半量）" else ""}",
            fontSize = 30.sp,
            lineHeight = 36.sp,
            fontWeight = FontWeight.Black,
            color = YangXiaColors.Ink,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (minutes != null) Text("约 $minutes 分钟", fontSize = 14.sp, color = YangXiaColors.Ink2)
            if (items.isNotEmpty()) Text("${items.size} 个跟练动作", fontSize = 14.sp, color = YangXiaColors.Ink2)
            if (sets.size == 1 && items.isNotEmpty()) Text("每个 ${sets[0]} 组", fontSize = 14.sp, color = YangXiaColors.Ink2)
        }
    }
}

@Composable
private fun ChecksCard(checks: List<PreSessionCheckDto>, answers: Map<Int, Boolean>, onAnswer: (Int, Boolean) -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(YangXiaColors.WarnSoft, RoundedCornerShape(20.dp))
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("练之前先确认", fontSize = 16.sp, fontWeight = FontWeight.Bold, color = YangXiaColors.WarnInk)
        checks.forEachIndexed { i, c ->
            val a = answers[i]
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("${c.ask}？", fontSize = 15.sp, lineHeight = 23.sp, color = YangXiaColors.Ink)
                if (c.kind == "fall") {
                    YesNo(label = c.ask, yes = "有", no = "没有", noFirst = true, value = a, onChange = { onAnswer(i, it) })
                    if (a == true) {
                        Text(
                            c.stop ?: "今天先不跟练：告诉家人，先问医生。",
                            modifier = Modifier.fillMaxWidth().background(YangXiaColors.DangerSoft, RoundedCornerShape(12.dp)).padding(12.dp),
                            fontSize = 14.sp,
                            lineHeight = 22.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = YangXiaColors.Danger,
                        )
                    }
                } else {
                    YesNo(label = c.ask, yes = "是", no = "不是", noFirst = false, value = a, onChange = { onAnswer(i, it) })
                    val rec = when (c.recorded) { true -> "是"; false -> "否"; null -> "没确认（按保守版本）" }
                    val differs = a != null && c.recorded != null && a != c.recorded
                    Text(
                        "档案记的是：$rec。${c.hint ?: "和档案记的不一样时，照成品原文换做法"}",
                        fontSize = 13.sp,
                        lineHeight = 21.sp,
                        fontWeight = if (differs) FontWeight.Bold else FontWeight.Normal,
                        color = YangXiaColors.WarnInk,
                    )
                }
            }
        }
    }
}

@Composable
private fun YesNo(label: String, yes: String, no: String, noFirst: Boolean, value: Boolean?, onChange: (Boolean) -> Unit) {
    val options = if (noFirst) listOf(false to no, true to yes) else listOf(true to yes, false to no)
    Row(modifier = Modifier.fillMaxWidth().semantics { contentDescription = label }, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEach { (v, text) ->
            val on = value == v
            Box(
                modifier = Modifier
                    .weight(1f)
                    .height(46.dp)
                    .background(if (on) YangXiaColors.Accent else YangXiaColors.Surface, RoundedCornerShape(14.dp))
                    .then(if (on) Modifier else Modifier.border(1.dp, YangXiaColors.WarnLine, RoundedCornerShape(14.dp)))
                    .semantics { selected = on }
                    .clickable(role = Role.RadioButton) { onChange(v) },
                contentAlignment = Alignment.Center,
            ) {
                Text(text, fontSize = 16.sp, fontWeight = if (on) FontWeight.Bold else FontWeight.Normal, color = if (on) Color.White else YangXiaColors.Ink)
            }
        }
    }
}

private data class MoveRow(val n: Int, val item: CourseItemDto, val spec: String)

private fun moveRows(blocks: List<CourseBlockDto>): List<MoveRow> {
    val all = blocks.flatMap { b -> b.items.map { b to it } }
    return all.mapIndexed { idx, (b, it) ->
        val amount = when {
            it.mode == "timed" -> "${it.duration ?: 0} 秒"
            it.perSide -> "每侧 ${it.reps ?: 0} 次"
            else -> "${it.reps ?: 0} 次"
        }
        val head = if (b.kind == "circuit") "${b.rounds ?: 1} 轮 × $amount" else "${it.sets ?: 1} 组 × $amount"
        val last = idx == all.lastIndex
        val rest = when {
            b.kind == "circuit" -> if (b.items.lastOrNull() === it && (b.restBetweenRounds ?: 0) > 0) "轮间休息 ${b.restBetweenRounds} 秒" else null
            last && (it.sets ?: 1) <= 1 -> null
            it.rest > 0 -> "休息 ${it.rest} 秒"
            else -> null
        }
        MoveRow(idx + 1, it, listOfNotNull(head, rest).joinToString(" · "))
    }
}

/** 节奏小标签：起 = 发力（呼），下 = 还原（吸），停 = 顶点或底部停住。 */
private enum class Beat { IN, OUT, HOLD }

private fun beatsOf(item: CourseItemDto): List<Pair<String, Beat>> {
    if (item.mode == "timed") return listOf("保持 ${item.duration ?: 0} 秒" to Beat.HOLD)
    val tp = item.tempo ?: return emptyList()
    val up = "起 ${tp.up} 秒 · 呼" to Beat.OUT
    val down = "下 ${tp.down} 秒 · 吸" to Beat.IN
    val top = tp.top?.takeIf { it > 0 }?.let { "停 $it 秒" to Beat.HOLD }
    val bottom = tp.bottom?.takeIf { it > 0 }?.let { "停 $it 秒" to Beat.HOLD }
    return if (tp.start == "down") listOfNotNull(down, bottom, up, top) else listOfNotNull(up, top, down, bottom)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MovesSection(blocks: List<CourseBlockDto>) {
    val rows = remember(blocks) { moveRows(blocks) }
    val open = remember(blocks) { mutableStateMapOf<Int, Boolean>() }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
            Text("跟练的动作", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = YangXiaColors.Ink, modifier = Modifier.weight(1f))
            Text("点开看原文和要领", fontSize = 13.sp, color = YangXiaColors.Ink2)
        }
        rows.forEach { r ->
            val expanded = open[r.n] == true
            val hasMore = r.item.quote.isNotEmpty() || !r.item.note.isNullOrBlank()
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(YangXiaColors.Surface, RoundedCornerShape(18.dp))
                    .border(1.dp, YangXiaColors.CardLine, RoundedCornerShape(18.dp))
                    .then(if (hasMore) Modifier.clickable { open[r.n] = !expanded } else Modifier)
                    .padding(horizontal = 14.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier.size(40.dp).background(YangXiaColors.Surface2, RoundedCornerShape(12.dp)),
                        contentAlignment = Alignment.Center,
                    ) { Text("${r.n}", fontSize = 16.sp, fontWeight = FontWeight.Bold, color = YangXiaColors.Ink2) }
                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(r.item.name.ifBlank { r.item.exercise }, fontSize = 17.sp, fontWeight = FontWeight.Bold, color = YangXiaColors.Ink)
                        Text(r.spec, fontSize = 14.sp, color = YangXiaColors.Ink2)
                        val beats = beatsOf(r.item)
                        if (beats.isNotEmpty()) {
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                beats.forEach { (label, kind) -> BeatPill(label, kind) }
                            }
                        }
                    }
                    if (hasMore) Text(if (expanded) "收起" else "原文", fontSize = 13.sp, color = YangXiaColors.Muted)
                }
                if (expanded) {
                    Column(
                        modifier = Modifier.fillMaxWidth().background(YangXiaColors.Ground, RoundedCornerShape(12.dp)).padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        r.item.quote.forEach { q -> Text("「$q」", fontSize = 14.sp, lineHeight = 22.sp, color = YangXiaColors.Ink) }
                        r.item.note?.takeIf { it.isNotBlank() }?.let { Text(it, fontSize = 13.sp, lineHeight = 20.sp, color = YangXiaColors.Ink2) }
                    }
                }
            }
        }
    }
}

@Composable
private fun BeatPill(label: String, kind: Beat) {
    val (bg, fg) = when (kind) {
        Beat.IN -> YangXiaColors.InhaleSoft to YangXiaColors.InhaleInk
        Beat.OUT -> YangXiaColors.ExhaleSoft to YangXiaColors.ExhaleInk
        Beat.HOLD -> YangXiaColors.Surface2 to YangXiaColors.Ink2
    }
    Text(
        label,
        modifier = Modifier.background(bg, RoundedCornerShape(999.dp)).padding(horizontal = 8.dp, vertical = 2.dp),
        fontSize = 12.sp,
        color = fg,
    )
}

@Composable
private fun FollowCard(followItems: List<Pair<String, String>>, notes: List<String>) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(YangXiaColors.Surface, RoundedCornerShape(18.dp))
            .border(1.dp, YangXiaColors.CardLine, RoundedCornerShape(18.dp))
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (followItems.isNotEmpty()) {
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("照成品做", fontSize = 16.sp, fontWeight = FontWeight.Bold, color = YangXiaColors.Ink)
                Text("不在跟练里", fontSize = 13.sp, color = YangXiaColors.Ink2)
            }
            Text(
                followItems.map { it.first }.filter { it.isNotBlank() }.distinct().joinToString(" · "),
                fontSize = 14.sp,
                lineHeight = 24.sp,
                color = YangXiaColors.Ink,
            )
            followItems.map { it.second }.filter { it.isNotBlank() }.distinct().forEach {
                Text(it, fontSize = 13.sp, lineHeight = 20.sp, color = YangXiaColors.Ink2)
            }
        }
        if (notes.isNotEmpty()) {
            if (followItems.isNotEmpty()) Spacer(Modifier.height(2.dp))
            Text("这一次的提醒", fontSize = 15.sp, fontWeight = FontWeight.Bold, color = YangXiaColors.Ink)
            notes.forEach { Text(it, fontSize = 13.sp, lineHeight = 20.sp, color = YangXiaColors.Ink2) }
        }
    }
}

@Composable
private fun Banner(title: String?, body: String, bg: Color, fg: Color) {
    Column(
        modifier = Modifier.fillMaxWidth().background(bg, RoundedCornerShape(14.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (title != null) Text(title, fontWeight = FontWeight.Bold, color = fg, fontSize = 14.sp)
        Text(body, fontSize = 13.sp, lineHeight = 20.sp, color = fg)
    }
}

@Composable
private fun InfoCard(title: String, body: String) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(YangXiaColors.Surface, RoundedCornerShape(18.dp))
            .border(1.dp, YangXiaColors.CardLine, RoundedCornerShape(18.dp))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(title, fontWeight = FontWeight.Bold, fontSize = 16.sp, color = YangXiaColors.Ink)
        Text(body, fontSize = 14.sp, lineHeight = 21.sp, color = YangXiaColors.Ink2)
    }
}

@Composable
private fun StartBar(modifier: Modifier, enabled: Boolean, label: String, onClick: () -> Unit) {
    Column(modifier = modifier.fillMaxWidth().background(YangXiaColors.Ground)) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(YangXiaColors.Line))
        Button(
            onClick = onClick,
            enabled = enabled,
            modifier = Modifier.padding(start = 18.dp, end = 18.dp, top = 12.dp, bottom = 18.dp).fillMaxWidth().height(60.dp),
            shape = RoundedCornerShape(20.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = YangXiaColors.Accent,
                contentColor = Color.White,
                disabledContainerColor = YangXiaColors.Surface2,
                disabledContentColor = YangXiaColors.Ink2,
            ),
        ) {
            Text(if (enabled) "▶  $label" else label, fontSize = 19.sp, fontWeight = FontWeight.Bold)
        }
    }
}
