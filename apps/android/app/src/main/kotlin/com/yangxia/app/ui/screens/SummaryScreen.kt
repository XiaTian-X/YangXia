package com.yangxia.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.yangxia.app.player.CourseDto
import com.yangxia.app.ui.theme.YangXiaColors

private val FEEL_OPTIONS = listOf("轻松", "正好", "吃力")
private val SYMPTOM_OPTIONS = listOf("疼痛", "头晕", "胸闷")

@Composable
fun SummaryScreen(
    profileCode: String,
    course: CourseDto,
    initialSetsDone: List<Int>,
    busy: Boolean,
    onSubmit: (setsDone: List<Int>, symptoms: List<String>, feel: String, note: String) -> Unit,
    onDiscard: () -> Unit,
) {
    val items = remember(course.id) { course.allItems() }
    val plannedPerItem = remember(course.id) { course.plannedPerItem() }
    val sets = remember(course.id, initialSetsDone) {
        mutableStateListOf<Int>().apply {
            items.indices.forEach { i -> add(initialSetsDone.getOrElse(i) { 0 }) }
        }
    }
    var feel by remember { mutableStateOf("正好") }
    val selectedSymptoms = remember { mutableStateListOf<String>() }
    var note by remember { mutableStateOf("") }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(YangXiaColors.Ground)
            .verticalScroll(rememberScrollState())
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("本次跟练记录 · $profileCode", fontSize = 20.sp, fontWeight = FontWeight.Bold, color = YangXiaColors.Ink)
        Text(course.name, fontSize = 13.sp, color = YangXiaColors.Ink2)

        if (selectedSymptoms.isNotEmpty()) {
            Card(colors = CardDefaults.cardColors(containerColor = YangXiaColors.DangerSoft), shape = RoundedCornerShape(12.dp)) {
                Text(
                    "已勾选不适（${selectedSymptoms.joinToString("、")}）：请立即停止加量，按成品「疼了怎么办」处理，必要时及时就医。服务端同步后将自动暂停后续加量与过重课程。",
                    modifier = Modifier.padding(12.dp),
                    fontSize = 13.sp,
                    color = YangXiaColors.Danger,
                )
            }
        }

        Card(colors = CardDefaults.cardColors(containerColor = YangXiaColors.Surface), shape = RoundedCornerShape(14.dp)) {
            Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("实际完成组数", fontWeight = FontWeight.Bold, fontSize = 14.sp, color = YangXiaColors.Ink)
                items.forEachIndexed { idx, item ->
                    val (planned, unit) = plannedPerItem.getOrElse(idx) { (item.sets ?: 1) to "组" }
                    val done = sets.getOrElse(idx) { 0 }
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("${item.name}（计划 $planned $unit）", fontSize = 13.sp, modifier = Modifier.weight(1f))
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            OutlinedButton(onClick = { if (done > 0) sets[idx] = done - 1 }) { Text("-") }
                            Text("$done", fontWeight = FontWeight.Bold)
                            OutlinedButton(onClick = { if (done < planned) sets[idx] = done + 1 }) { Text("+") }
                        }
                    }
                }
            }
        }

        Card(colors = CardDefaults.cardColors(containerColor = YangXiaColors.Surface), shape = RoundedCornerShape(14.dp)) {
            Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("整体体感", fontWeight = FontWeight.Bold, fontSize = 14.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    FEEL_OPTIONS.forEach { opt ->
                        FilterChip(selected = feel == opt, onClick = { feel = opt }, label = { Text(opt) })
                    }
                }

                Text("是否出现以下不适？（如实勾选）", fontWeight = FontWeight.Bold, fontSize = 14.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SYMPTOM_OPTIONS.forEach { sym ->
                        val checked = sym in selectedSymptoms
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(
                                checked = checked,
                                onCheckedChange = {
                                    if (it) selectedSymptoms.add(sym) else selectedSymptoms.remove(sym)
                                },
                            )
                            Text(sym, fontSize = 13.sp)
                        }
                    }
                }

                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = { Text("简短备注（请勿填写病名、用药、血压或体重数字）") },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }

        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedButton(onClick = onDiscard, enabled = !busy, modifier = Modifier.weight(1f)) {
                Text("返回不保存")
            }
            Button(
                onClick = { onSubmit(sets.toList(), selectedSymptoms.toList(), feel, note.trim()) },
                enabled = !busy,
                modifier = Modifier.weight(1.6f),
            ) {
                Text(if (busy) "保存同步中..." else "保存并同步练习记录")
            }
        }
    }
}
