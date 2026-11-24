package com.yangxia.app.ui.screens

import androidx.compose.foundation.background
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
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.yangxia.app.ui.theme.YangXiaColors
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

@Composable
fun ConnectScreen(
    initialServerUrl: String,
    initialAllowTailscale: Boolean,
    busy: Boolean,
    error: String?,
    message: String?,
    onToggleTailscale: (Boolean) -> Unit,
    onLoginPassword: (serverUrl: String, username: String, password: String) -> Unit,
    onLoginPairCode: (serverUrl: String, pairCode: String) -> Unit,
    onRequestQrScan: ((String) -> Unit) -> Unit,
) {
    var serverUrl by remember { mutableStateOf(initialServerUrl.ifBlank { "http://192.168.1.100:3000" }) }
    var allowTailscale by remember { mutableStateOf(initialAllowTailscale) }
    var modePair by remember { mutableStateOf(true) }
    var pairCode by remember { mutableStateOf("") }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(YangXiaColors.Ground)
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("养夏跟练 · 连接服务端", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = YangXiaColors.Ink)
        Card(
            colors = CardDefaults.cardColors(containerColor = YangXiaColors.InhaleSoft),
            shape = RoundedCornerShape(12.dp),
        ) {
            Text(
                "未经专业审核，不是医学建议，不能替代医生的判断",
                modifier = Modifier.padding(10.dp),
                fontSize = 12.sp,
                color = YangXiaColors.Inhale,
            )
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

        Card(colors = CardDefaults.cardColors(containerColor = YangXiaColors.Surface), shape = RoundedCornerShape(16.dp)) {
            Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = serverUrl,
                    onValueChange = { serverUrl = it },
                    label = { Text("服务端地址（局域网 HTTP 或公网 HTTPS）") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text("允许 Tailscale (100.64/10) 明文", fontSize = 13.sp, color = YangXiaColors.Ink2)
                    Switch(
                        checked = allowTailscale,
                        onCheckedChange = {
                            allowTailscale = it
                            onToggleTailscale(it)
                        },
                    )
                }

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = modePair, onClick = { modePair = true }, label = { Text("扫码 / 绑定码") })
                    FilterChip(selected = !modePair, onClick = { modePair = false }, label = { Text("账号密码") })
                }

                if (modePair) {
                    OutlinedButton(
                        onClick = {
                            onRequestQrScan { raw ->
                                runCatching {
                                    val obj = Json.parseToJsonElement(raw).jsonObject
                                    obj["serverUrl"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() }?.let { serverUrl = it }
                                    obj["code"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() }?.let { pairCode = it }
                                }.onFailure {
                                    pairCode = raw.trim()
                                }
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("扫描网页端 5 分钟配对二维码")
                    }
                    OutlinedTextField(
                        value = pairCode,
                        onValueChange = { pairCode = it },
                        label = { Text("或粘贴配对码") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Button(
                        onClick = { onLoginPairCode(serverUrl, pairCode) },
                        enabled = !busy && serverUrl.isNotBlank() && pairCode.isNotBlank(),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(if (busy) "绑定中..." else "绑定此档案设备")
                    }
                } else {
                    OutlinedTextField(
                        value = username,
                        onValueChange = { username = it },
                        label = { Text("用户名") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = password,
                        onValueChange = { password = it },
                        label = { Text("密码") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Button(
                        onClick = { onLoginPassword(serverUrl, username, password) },
                        enabled = !busy && serverUrl.isNotBlank() && username.isNotBlank() && password.isNotBlank(),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(if (busy) "登录中..." else "登录")
                    }
                }
            }
        }
        Spacer(Modifier.height(12.dp))
    }
}
