package com.yangxia.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.yangxia.app.player.CourseDto
import com.yangxia.app.ui.theme.YangXiaColors
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** 整体感受（核心库 Feeling）。 */
private val FEELING_OPTIONS = listOf("轻松", "正好", "吃力")
private val SYMPTOM_OPTIONS = listOf("疼痛", "头晕", "胸闷")
/** 每个动作的感受：成品原话三选一（核心库 FEELS），找级照它核对。 */
val ITEM_FEELS = listOf("做不到下限或后面几下变形", "能做到下限，最后两下有点难", "做到上限还很轻松")

/** 一个动作的补充（核心库 ItemNote）。 */
data class ItemNote(val feel: String? = null, val spare: Int? = null, val reverted: Boolean = false)

/** {"itemIndex": {feel, spare, reverted}}：只写填了的。 */
fun perItemToJson(perItem: Map<Int, ItemNote>): String {
    val obj = buildJsonObject {
        perItem.forEach { (i, n) ->
            if (n.feel == null && n.spare == null && !n.reverted) return@forEach
            put(i.toString(), buildJsonObject {
                n.feel?.let { put("feel", it) }
                n.spare?.let { put("spare", it) }
                if (n.reverted) put("reverted", true)
            })
        }
    }
    return Json.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), obj)
}

@Composable
fun SummaryScreen(
    profileCode: String,
    course: CourseDto,
    /** 照实际播放过的拍子算出的完成组数（只读）。 */
    initialSetsDone: List<Int>,
    busy: Boolean,
    /** 实际跟练的时长（秒，暂停的时间不算）；0 不显示。 */
    elapsedSec: Double = 0.0,
    onSubmit: (symptoms: List<String>, feel: String, note: String, perItem: Map<Int, ItemNote>) -> Unit,
    onDiscard: () -> Unit,
) {
    val items = remember(course.id) { course.allItems() }
    val planned = remember(course.id) { course.plannedPerItem() }
    val gym = course.source.product.contains("健身房")
    var feeling by remember { mutableStateOf<String?>(null) }
    val symptoms = remember { mutableStateListOf<String>() }
    val notes = remember(course.id) { mutableStateMapOf<Int, ItemNote>() }
    var note by remember { mutableStateOf("") }
    val doneSets = items.indices.sumOf { initialSetsDone.getOrElse(it) { 0 } }
    val totalSets = planned.sumOf { it.first }

    Box(modifier = Modifier.fillMaxSize().background(YangXiaColors.Ground)) {
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 18.dp, end = 18.dp, top = 20.dp, bottom = 150.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(modifier = Modifier.size(48.dp).clip(RoundedCornerShape(16.dp)).background(YangXiaColors.AccentSoft), contentAlignment = Alignment.Center) {
                    Text("✓", color = YangXiaColors.Accent, fontSize = 24.sp, fontWeight = FontWeight.Bold)
                }
                Column {
                    Text("练完了", fontSize = 28.sp, fontWeight = FontWeight.Black, color = YangXiaColors.Ink)
                    Text("$profileCode · ${course.name}", fontSize = 14.sp, color = YangXiaColors.Ink2)
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (elapsedSec >= 1) {
                    val t = elapsedSec.toInt()
                    Stat("%02d:%02d".format(t / 60, t % 60), "用时", Modifier.weight(1f))
                }
                Stat("$doneSets / $totalSets", "组做完", Modifier.weight(1f))
                Stat("${items.size}", "个动作", Modifier.weight(1f))
            }

            Section("练的时候有没有这些情况") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SYMPTOM_OPTIONS.forEach { s ->
                        val on = s in symptoms
                        Toggle(s, on, danger = true, modifier = Modifier.weight(1f)) { if (on) symptoms.remove(s) else symptoms.add(s) }
                    }
                }
                if (symptoms.isNotEmpty()) {
                    Text(
                        "下次先不加量，照成品\"疼了怎么办\"处理；头晕站不稳、胸闷胸痛，去看医生。",
                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(YangXiaColors.DangerSoft).padding(12.dp),
                        color = Color(0xFF7A2416),
                        fontSize = 14.sp,
                        lineHeight = 21.sp,
                    )
                }
            }

            Section("整体感受") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FEELING_OPTIONS.forEach { f -> Toggle(f, feeling == f, modifier = Modifier.weight(1f)) { feeling = f } }
                }
            }

            Section("每个动作", sub = "做了几组照实际跟练算，不能改。感受选最接近的一句（可以不选），周复盘、找级照它核对") {
                items.forEachIndexed { i, item ->
                    val done = initialSetsDone.getOrElse(i) { 0 }
                    val plan = planned.getOrElse(i) { 1 to "组" }
                    val n = notes[i] ?: ItemNote()
                    Column(
                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(YangXiaColors.Surface)
                            .border(1.dp, Color(0xFFE9E4DA), RoundedCornerShape(18.dp)).padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                            Text(item.name, fontSize = 16.sp, fontWeight = FontWeight.Bold, color = YangXiaColors.Ink, modifier = Modifier.weight(1f))
                            Text(
                                if (done == 0) "0 / ${plan.first} ${plan.second} · 跳过" else "$done / ${plan.first} ${plan.second}",
                                fontSize = 13.sp,
                                color = if (done == 0) YangXiaColors.Ink2 else YangXiaColors.AccentStrong,
                                modifier = Modifier.clip(RoundedCornerShape(50)).background(if (done == 0) YangXiaColors.Surface2 else YangXiaColors.AccentSoft).padding(horizontal = 10.dp, vertical = 3.dp),
                            )
                        }
                        if (done > 0) {
                            ITEM_FEELS.forEach { f ->
                                val on = n.feel == f
                                Row(
                                    modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp).clip(RoundedCornerShape(12.dp))
                                        .background(if (on) YangXiaColors.AccentSoft else YangXiaColors.Ground)
                                        .border(1.5.dp, if (on) YangXiaColors.Accent else Color.Transparent, RoundedCornerShape(12.dp))
                                        .clickable(role = Role.RadioButton) { notes[i] = n.copy(feel = if (on) null else f) }
                                        .padding(horizontal = 12.dp, vertical = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    Box(
                                        modifier = Modifier.size(14.dp).clip(CircleShape)
                                            .border(if (on) 4.dp else 2.dp, if (on) YangXiaColors.Accent else Color(0xFFA5AEA8), CircleShape)
                                            .background(Color.White),
                                    )
                                    Text(f, fontSize = 15.sp, color = YangXiaColors.Ink)
                                }
                            }
                            if (gym) {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                    Text("最后一组还能做几下", fontSize = 15.sp, color = YangXiaColors.Ink, modifier = Modifier.weight(1f))
                                    OutlinedButton(onClick = { notes[i] = n.copy(spare = ((n.spare ?: 1) - 1).coerceAtLeast(0)) }, modifier = Modifier.size(44.dp), contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) { Text("−") }
                                    Text(n.spare?.toString() ?: "—", fontSize = 17.sp, fontWeight = FontWeight.Bold, color = YangXiaColors.Ink)
                                    OutlinedButton(onClick = { notes[i] = n.copy(spare = ((n.spare ?: -1) + 1).coerceAtMost(30)) }, modifier = Modifier.size(44.dp), contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) { Text("+") }
                                }
                            }
                            Row(
                                modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable(role = Role.Checkbox) { notes[i] = n.copy(reverted = !n.reverted) },
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Checkbox(checked = n.reverted, onCheckedChange = { notes[i] = n.copy(reverted = it) })
                                Text("升了级做不到，当场退回上一级", fontSize = 15.sp, color = Color(0xFF2D3B33))
                            }
                        }
                    }
                }
            }

            Section("备注", sub = "不写病名、用药、血压体重数字") {
                OutlinedTextField(value = note, onValueChange = { if (it.codePointCount(0, it.length) <= 500) note = it }, modifier = Modifier.fillMaxWidth(), minLines = 2)
            }
        }

        Column(
            modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(YangXiaColors.Ground).padding(horizontal = 18.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Button(
                onClick = { onSubmit(symptoms.toList(), feeling ?: "正好", note, notes.toMap()) },
                enabled = !busy && feeling != null,
                modifier = Modifier.fillMaxWidth().height(56.dp),
                shape = RoundedCornerShape(20.dp),
                colors = ButtonDefaults.buttonColors(containerColor = YangXiaColors.Accent),
            ) { Text(if (busy) "正在保存…" else if (feeling == null) "先选整体感受" else "保存并传回服务器", fontSize = 18.sp, fontWeight = FontWeight.Bold) }
            Row(horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Text("没网时先存在手机上，连上家里的服务器自动传", fontSize = 12.sp, color = YangXiaColors.Ink2, modifier = Modifier.weight(1f))
                Text("不保存", fontSize = 14.sp, color = YangXiaColors.Danger, modifier = Modifier.clickable(role = Role.Button) { onDiscard() }.padding(8.dp))
            }
        }
    }
}

@Composable
private fun Stat(value: String, label: String, modifier: Modifier) {
    Column(
        modifier = modifier.clip(RoundedCornerShape(16.dp)).background(YangXiaColors.Surface).border(1.dp, Color(0xFFE9E4DA), RoundedCornerShape(16.dp)).padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Text(value, fontSize = 22.sp, fontWeight = FontWeight.Bold, color = YangXiaColors.Ink)
        Text(label, fontSize = 12.sp, color = YangXiaColors.Ink2)
    }
}

@Composable
private fun Section(title: String, sub: String? = null, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Column {
            Text(title, fontSize = 17.sp, fontWeight = FontWeight.Bold, color = YangXiaColors.Ink)
            if (sub != null) Text(sub, fontSize = 13.sp, color = YangXiaColors.Ink2, lineHeight = 19.sp)
        }
        content()
    }
}

@Composable
private fun Toggle(label: String, on: Boolean, danger: Boolean = false, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val bg = when {
        on && danger -> YangXiaColors.Danger
        on -> YangXiaColors.Accent
        else -> YangXiaColors.Surface
    }
    Box(
        modifier = modifier.height(50.dp).clip(RoundedCornerShape(14.dp)).background(bg)
            .border(1.dp, if (on) Color.Transparent else YangXiaColors.Line, RoundedCornerShape(14.dp))
            .clickable(role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, fontSize = 16.sp, fontWeight = if (on) FontWeight.Bold else FontWeight.Normal, color = if (on) Color.White else YangXiaColors.Ink)
    }
}
