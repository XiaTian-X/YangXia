package com.yangxia.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.yangxia.app.player.DeliveryEnvelopeDto
import com.yangxia.app.storage.CachedCourseEntity
import com.yangxia.app.storage.CachedProfileEntity
import com.yangxia.app.storage.PendingSessionEntity
import com.yangxia.app.ui.theme.YangXiaColors
import kotlinx.serialization.json.Json

private val todayJson = Json { ignoreUnknownKeys = true }

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

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(YangXiaColors.Ground)
            .verticalScroll(rememberScrollState())
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // 顶栏（针对 Mi 6 360dp 宽紧凑排列，醒目展示档案代号防误练）
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = activeProfile?.code ?: "今天的课",
                    fontSize = 22.sp,
                    fontWeight = FontWeight.ExtraBold,
                    color = YangXiaColors.Ink,
                )
                Text(
                    text = activeProfile?.product ?: "请下拉刷新获取今日安排",
                    fontSize = 12.sp,
                    color = YangXiaColors.Ink2,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedButton(onClick = onRefresh, enabled = !busy) {
                    Text(if (busy) "刷新中" else "刷新", fontSize = 13.sp)
                }
                OutlinedButton(onClick = onOpenSettings) {
                    Text("设置", fontSize = 13.sp)
                }
            }
        }

        // 多档案快速切换（扫码绑定设备固定单档案不展示切换器）
        if (!isMobileBound && profiles.size > 1) {
            Row(
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                profiles.forEach { p ->
                    FilterChip(
                        selected = p.profileId == activeProfile?.profileId,
                        onClick = { onSelectProfile(p.profileId) },
                        label = { Text(p.code) },
                    )
                }
            }
        }

        // 常驻免责声明
        Card(colors = CardDefaults.cardColors(containerColor = YangXiaColors.Surface2), shape = RoundedCornerShape(10.dp)) {
            Text(
                "未经专业审核，不是医学建议，不能替代医生的判断",
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                fontSize = 12.sp,
                color = YangXiaColors.Ink2,
            )
        }

        // CLOCK_SKEW_FUTURE 强提示
        if (clockSkewAlert != null) {
            Card(colors = CardDefaults.cardColors(containerColor = YangXiaColors.DangerSoft), shape = RoundedCornerShape(12.dp)) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("手机系统时间超前，已暂停同步", fontWeight = FontWeight.Bold, color = YangXiaColors.Danger, fontSize = 14.sp)
                    Text(
                        clockSkewAlert.lastErrorMessage ?: "请先在校准手机系统时间后点击立即补传。",
                        fontSize = 12.sp,
                        color = YangXiaColors.Danger,
                    )
                }
            }
        }

        // 迟到不适冲突告警
        if (activeProfile?.hasConflict == true) {
            Card(colors = CardDefaults.cardColors(containerColor = YangXiaColors.WarnSoft), shape = RoundedCornerShape(12.dp)) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("档案存在未处理的冲突提醒", fontWeight = FontWeight.Bold, color = YangXiaColors.Warn, fontSize = 14.sp)
                    Text(
                        activeProfile.conflictMessage ?: "请先前往网页端复盘处理近期不适记录，处理前不会发布新课。",
                        fontSize = 12.sp,
                        color = YangXiaColors.Warn,
                    )
                }
            }
        }

        if (!error.isNullOrBlank()) {
            Card(colors = CardDefaults.cardColors(containerColor = YangXiaColors.DangerSoft), shape = RoundedCornerShape(12.dp)) {
                Text(error, modifier = Modifier.padding(10.dp), fontSize = 13.sp, color = YangXiaColors.Danger)
            }
        }
        if (!message.isNullOrBlank()) {
            Card(colors = CardDefaults.cardColors(containerColor = YangXiaColors.AccentSoft), shape = RoundedCornerShape(12.dp)) {
                Text(message, modifier = Modifier.padding(10.dp), fontSize = 13.sp, color = YangXiaColors.AccentStrong)
            }
        }

        // 待补传队列条
        if (pendingSessions.isNotEmpty()) {
            Card(colors = CardDefaults.cardColors(containerColor = YangXiaColors.InhaleSoft), shape = RoundedCornerShape(12.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(12.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("待补传离线记录：${pendingSessions.size} 条", fontSize = 13.sp, color = YangXiaColors.Inhale, fontWeight = FontWeight.SemiBold)
                    OutlinedButton(onClick = onSyncPending, enabled = !busy) {
                        Text("立即同步", fontSize = 12.sp)
                    }
                }
            }
        }

        // 6-12 岁家长版无跟练课程说明
        if (activeProfile != null && !activeProfile.supportedForWorkout) {
            Card(colors = CardDefaults.cardColors(containerColor = YangXiaColors.Surface), shape = RoundedCornerShape(14.dp)) {
                Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("6–12 岁家长版不导出手机跟练课程", fontWeight = FontWeight.Bold, color = YangXiaColors.Ink)
                    Text("请前往网页端「饮食与模板」阅读《${activeProfile.product}》陪伴孩子进行户外游戏活动。", fontSize = 13.sp, color = YangXiaColors.Ink2)
                }
            }
        } else if (activeCourses.isEmpty()) {
            Card(colors = CardDefaults.cardColors(containerColor = YangXiaColors.Surface), shape = RoundedCornerShape(14.dp)) {
                Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("今日暂无已发布课程", fontWeight = FontWeight.Bold, color = YangXiaColors.Ink)
                    Text("请在网页端「排课中心」发布本周课程后点击右上角「刷新」。", fontSize = 13.sp, color = YangXiaColors.Ink2)
                }
            }
        }

        // 活跃可跟练课程卡片（展示 follow 配套有氧与 notes 注意事项）
        activeCourses.forEach { course ->
            val env = runCatching {
                todayJson.decodeFromString(DeliveryEnvelopeDto.serializer(), course.envelopeJson)
            }.getOrNull()

            Card(colors = CardDefaults.cardColors(containerColor = YangXiaColors.Surface), shape = RoundedCornerShape(16.dp)) {
                Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(course.courseName, fontSize = 16.sp, fontWeight = FontWeight.Bold, color = YangXiaColors.Ink, modifier = Modifier.weight(1f))
                        Text(
                            "第${course.week}周 ${course.day}日${if (course.half) " 半量" else ""}",
                            fontSize = 12.sp,
                            color = YangXiaColors.AccentStrong,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                    if (!env?.follow.isNullOrEmpty()) {
                        Text(
                            "配套有氧/习惯：${env.follow.joinToString("；")}",
                            fontSize = 13.sp,
                            color = YangXiaColors.Ink2,
                        )
                    }
                    if (!env?.notes.isNullOrEmpty()) {
                        Text(
                            "练前提醒：${env.notes.joinToString("；")}",
                            fontSize = 12.sp,
                            color = YangXiaColors.Warn,
                        )
                    }
                    Button(
                        onClick = { onStartCourse(course) },
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("开始跟练（支持锁屏语音）")
                    }
                }
            }
        }

        // 已被服务端作废的旧缓存课（强制锁定，展示原因，禁止开练）
        if (invalidatedCourses.isNotEmpty()) {
            Text("已作废旧课（已锁定）", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = YangXiaColors.Ink2)
            invalidatedCourses.forEach { ic ->
                Card(colors = CardDefaults.cardColors(containerColor = YangXiaColors.WarnSoft), shape = RoundedCornerShape(12.dp)) {
                    Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("${ic.courseName}（第${ic.week}周 ${ic.day}日）", fontWeight = FontWeight.SemiBold, color = YangXiaColors.Warn, fontSize = 14.sp)
                        Text(
                            "作废原因：${ic.invalidatedReason ?: "档案进度或模板已更新，请使用新课"}",
                            fontSize = 12.sp,
                            color = YangXiaColors.Warn,
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(12.dp))
    }
}
