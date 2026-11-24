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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.yangxia.app.storage.DevicePrefs
import com.yangxia.app.ui.theme.YangXiaColors
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.math.roundToInt

@Composable
fun SettingsScreen(
    serverUrl: String,
    profileCode: String?,
    profilePlaybackJson: String?,
    pendingSessionCount: Int,
    allowTailscale: Boolean,
    devicePrefs: DevicePrefs,
    busy: Boolean,
    message: String?,
    error: String?,
    onBack: () -> Unit,
    onToggleTailscale: (Boolean) -> Unit,
    onUpdateDevicePrefs: ((DevicePrefs) -> DevicePrefs) -> Unit,
    onSyncProfilePlayback: (breathLead: JsonElement?, breathAfter: String?, countTiming: String?) -> Unit,
    onTestOfflineVoice: () -> Unit,
    onOpenBatterySettings: () -> Unit,
    onLogout: () -> Unit,
) {
    val parsedPb = remember(profilePlaybackJson) {
        profilePlaybackJson?.let { runCatching { Json.parseToJsonElement(it).jsonObject }.getOrNull() }
    }
    var breathAfter by remember(profileCode, profilePlaybackJson) {
        mutableStateOf(parsedPb?.get("breathAfter")?.jsonPrimitive?.content ?: "pluck")
    }
    var countTiming by remember(profileCode, profilePlaybackJson) {
        mutableStateOf(parsedPb?.get("countTiming")?.jsonPrimitive?.content ?: "on-up")
    }
    var breathLeadAll by remember(profileCode, profilePlaybackJson) {
        mutableStateOf(parsedPb?.get("breathLead")?.jsonPrimitive?.content == "all")
    }
    var confirmLogoutOpen by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(YangXiaColors.Ground)
            .verticalScroll(rememberScrollState())
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("跟练与设备设置", fontSize = 20.sp, fontWeight = FontWeight.Bold, color = YangXiaColors.Ink)
            OutlinedButton(onClick = onBack) { Text("返回") }
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

        // 第一层：设备本机偏好（仅存本机）
        Card(colors = CardDefaults.cardColors(containerColor = YangXiaColors.Surface), shape = RoundedCornerShape(14.dp)) {
            Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("本机播放设置（仅留在本机）", fontWeight = FontWeight.Bold, fontSize = 15.sp)
                Text("语音音量：${devicePrefs.voiceVol}%", fontSize = 13.sp, color = YangXiaColors.Ink2)
                Slider(
                    value = devicePrefs.voiceVol.toFloat(),
                    onValueChange = { v -> onUpdateDevicePrefs { it.copy(voiceVol = v.roundToInt()) } },
                    valueRange = 0f..100f,
                )
                Text("打点提示音音量：${devicePrefs.cueVol}%", fontSize = 13.sp, color = YangXiaColors.Ink2)
                Slider(
                    value = devicePrefs.cueVol.toFloat(),
                    onValueChange = { v -> onUpdateDevicePrefs { it.copy(cueVol = v.roundToInt()) } },
                    valueRange = 0f..100f,
                )
                Text("换气提示音音量：${devicePrefs.breathVol}%（有安全下限时自动保持 ≥ 15%）", fontSize = 13.sp, color = YangXiaColors.Ink2)
                Slider(
                    value = devicePrefs.breathVol.toFloat(),
                    onValueChange = { v -> onUpdateDevicePrefs { it.copy(breathVol = v.roundToInt()) } },
                    valueRange = 0f..100f,
                )
                Text("打点音色", fontSize = 13.sp, color = YangXiaColors.Ink2)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("woodblock" to "木鱼/钟", "marimba" to "马林巴", "perc" to "打击").forEach { (id, label) ->
                        FilterChip(
                            selected = devicePrefs.soundStyle == id,
                            onClick = { onUpdateDevicePrefs { it.copy(soundStyle = id) } },
                            label = { Text(label) },
                        )
                    }
                }

                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text("强制使用内置 27 词元离线语音兜底", fontSize = 13.sp, modifier = Modifier.weight(1f))
                    Switch(
                        checked = devicePrefs.forceOfflineVoice,
                        onCheckedChange = { checked -> onUpdateDevicePrefs { it.copy(forceOfflineVoice = checked) } },
                    )
                }
                OutlinedButton(onClick = onTestOfflineVoice, modifier = Modifier.fillMaxWidth()) {
                    Text("试听内置离线语音（3-2-1-开始）")
                }

                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text("关键节拍震动反馈", fontSize = 13.sp)
                    Switch(
                        checked = devicePrefs.vibrate,
                        onCheckedChange = { checked -> onUpdateDevicePrefs { it.copy(vibrate = checked) } },
                    )
                }

                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text("改用服务端预计算时间轴（QuickJS 回退开关）", fontSize = 13.sp, modifier = Modifier.weight(1f))
                    Switch(
                        checked = devicePrefs.useServerPrecomputed,
                        onCheckedChange = { checked -> onUpdateDevicePrefs { it.copy(useServerPrecomputed = checked) } },
                    )
                }
            }
        }

        // 第二层：档案级播放偏好（双向同步至服务端）
        if (!profileCode.isNullOrBlank()) {
            Card(colors = CardDefaults.cardColors(containerColor = YangXiaColors.Surface), shape = RoundedCornerShape(14.dp)) {
                Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("档案级播报偏好（同步至服务端 · $profileCode）", fontWeight = FontWeight.Bold, fontSize = 15.sp)
                    Text("注：65 岁以上或高血压保守模式下，领完以后仍自动保留换气提示音。", fontSize = 12.sp, color = YangXiaColors.Ink2)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(selected = breathAfter == "pluck", onClick = { breathAfter = "pluck" }, label = { Text("领完后提示音") })
                        FilterChip(selected = breathAfter == "quiet", onClick = { breathAfter = "quiet" }, label = { Text("领完后安静") })
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(selected = countTiming == "on-rep", onClick = { countTiming = "on-rep" }, label = { Text("完成时报数") })
                        FilterChip(selected = countTiming == "on-up", onClick = { countTiming = "on-up" }, label = { Text("起身时报数") })
                    }
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        Text("全程语音领呼吸（不限前 3 次）", fontSize = 13.sp)
                        Switch(checked = breathLeadAll, onCheckedChange = { breathLeadAll = it })
                    }
                    Button(
                        onClick = {
                            onSyncProfilePlayback(
                                if (breathLeadAll) JsonPrimitive("all") else JsonPrimitive(3),
                                breathAfter,
                                countTiming,
                            )
                        },
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("同步档案偏好到服务端")
                    }
                }
            }
        }

        // 网络与后台保活设置
        Card(colors = CardDefaults.cardColors(containerColor = YangXiaColors.Surface), shape = RoundedCornerShape(14.dp)) {
            Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("连接与息屏保活", fontWeight = FontWeight.Bold, fontSize = 15.sp)
                Text("当前服务端：$serverUrl", fontSize = 12.sp, color = YangXiaColors.Ink2)
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text("允许 Tailscale (100.64/10) 明文", fontSize = 13.sp)
                    Switch(checked = allowTailscale, onCheckedChange = onToggleTailscale)
                }
                OutlinedButton(onClick = onOpenBatterySettings, modifier = Modifier.fillMaxWidth()) {
                    Text("MIUI / 系统省电白名单设置（防息屏杀后台）")
                }
                OutlinedButton(
                    onClick = {
                        if (pendingSessionCount > 0) confirmLogoutOpen = true else onLogout()
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("退出登录 / 解绑设备", color = YangXiaColors.Danger)
                }
            }
        }
    }

    if (confirmLogoutOpen) {
        AlertDialog(
            onDismissRequest = { confirmLogoutOpen = false },
            title = { Text("存在未同步的离线练习记录") },
            text = { Text("当前本机还有 $pendingSessionCount 条未上传的练习记录。退出登录将清空本机缓存与待传队列，建议先联网补传后再退出。") },
            confirmButton = {
                TextButton(onClick = {
                    confirmLogoutOpen = false
                    onLogout()
                }) {
                    Text("仍要退出并清空", color = YangXiaColors.Danger)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmLogoutOpen = false }) {
                    Text("取消")
                }
            },
        )
    }
}
