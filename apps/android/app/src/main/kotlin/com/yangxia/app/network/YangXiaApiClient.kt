package com.yangxia.app.network

import com.yangxia.app.player.PlayerPlanResultDto
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI
import java.util.concurrent.TimeUnit

class ApiHttpException(
    val status: Int,
    val code: String,
    override val message: String,
) : IOException(message)

@Serializable
data class HealthResponse(
    val ok: Boolean = false,
    val initialized: Boolean = false,
    val templateVersion: String? = null,
)

@Serializable
data class LoginResponse(
    val ok: Boolean = false,
    val token: String = "",
    val sessionId: String = "",
    val expiresAt: String = "",
)

@Serializable
data class PairResponse(
    val ok: Boolean = false,
    val token: String = "",
    val sessionId: String = "",
    val profileId: String = "",
    val profileCode: String = "",
    val expiresAt: String = "",
)

@Serializable
data class MobileActiveCourseDto(
    val id: String,
    val courseId: String = "",
    val segment: Int = 1,
    val week: Int = 1,
    val day: String = "",
    val half: Boolean = false,
    val snapshotHash: String = "",
    val updatedAt: String = "",
    /** 保留服务端原始 JSON 信封，避免 DTO 往返重序列化剥离 coaching.floor 等安全字段。 */
    val envelope: JsonObject,
)

@Serializable
data class MobileInvalidatedCourseDto(
    val id: String,
    val courseId: String = "",
    val segment: Int = 1,
    val week: Int = 1,
    val day: String = "",
    val half: Boolean = false,
    val invalidatedReason: String? = null,
    val updatedAt: String = "",
)

@Serializable
data class MobileTodayProfileDto(
    val id: String = "",
    val code: String = "",
    val age: String = "",
    val stage: String = "",
    val product: String = "",
    val timezone: String = "",
    val version: Int = 1,
    val hasConflict: Boolean = false,
    val conflict: JsonObject? = null,
)

@Serializable
data class MobileTodayResponse(
    val declaration: String = "未经专业审核，不是医学建议，不能替代医生的判断",
    val profile: MobileTodayProfileDto = MobileTodayProfileDto(),
    val supported: Boolean = true,
    val message: String? = null,
    val playback: JsonObject? = null,
    val activeCourses: List<MobileActiveCourseDto> = emptyList(),
    val invalidatedCourses: List<MobileInvalidatedCourseDto> = emptyList(),
)

@Serializable
data class MobileProfileListItem(
    val id: String,
    val code: String,
    val age: String,
    val stage: String = "",
    val product: String,
    val hasWorkoutCourses: Boolean = true,
    val hasConflict: Boolean = false,
    val playback: JsonObject? = null,
)

@Serializable
data class MotionBatchClipDto(
    val hash: String = "",
    val clip: JsonElement,
)

@Serializable
data class MotionsBatchResponse(
    val templateVersion: String = "",
    val clips: Map<String, MotionBatchClipDto> = emptyMap(),
    val unchanged: List<String> = emptyList(),
    val missing: List<String> = emptyList(),
)

@Serializable
data class SessionSyncResponse(
    val ok: Boolean = false,
    val status: String = "",
    val id: String? = null,
    val hasConflict: Boolean = false,
)

@OptIn(ExperimentalSerializationApi::class)
class YangXiaApiClient(
    private val allowTailscale: () -> Boolean,
    private val json: Json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    },
) {
    private val safeDns = SafePrivateNetDns(allowTailscale)

    /** 局域网明文 HTTP 请求绝不经由系统 HTTP 代理转发，防止不可信 Wi-Fi 代理窃取 Bearer Token。 */
    private val cleartextNoProxySelector = object : ProxySelector() {
        private val systemDefault = ProxySelector.getDefault()
        override fun select(uri: URI?): List<Proxy> {
            if (uri?.scheme.equals("http", ignoreCase = true)) {
                return listOf(Proxy.NO_PROXY)
            }
            return runCatching { systemDefault?.select(uri) }.getOrNull().orEmpty().ifEmpty { listOf(Proxy.NO_PROXY) }
        }
        override fun connectFailed(uri: URI?, sa: SocketAddress?, ioe: IOException?) {
            runCatching { systemDefault?.connectFailed(uri, sa, ioe) }
        }
    }

    val httpClient: OkHttpClient = OkHttpClient.Builder()
        .dns(safeDns)
        .proxySelector(cleartextNoProxySelector)
        .addInterceptor(SafePrivateNetAppInterceptor(safeDns))
        .addNetworkInterceptor(SafePrivateNetNetworkInterceptor(allowTailscale, safeDns))
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private fun buildUrl(serverUrl: String, pathSegments: List<String>, query: Map<String, String> = emptyMap()): String {
        val base = serverUrl.trim().trimEnd('/').toHttpUrl()
        val b = base.newBuilder()
        for (seg in pathSegments) b.addPathSegment(seg)
        for ((k, v) in query) b.addQueryParameter(k, v)
        return b.build().toString()
    }

    private suspend fun executeJson(
        serverUrl: String,
        pathSegments: List<String>,
        query: Map<String, String> = emptyMap(),
        method: String = "GET",
        token: String? = null,
        bodyJson: String? = null,
    ): String = withContext(Dispatchers.IO) {
        val url = buildUrl(serverUrl, pathSegments, query)
        val reqBuilder = Request.Builder().url(url)
        if (!token.isNullOrBlank()) {
            reqBuilder.header("Authorization", "Bearer $token")
        }
        when (method.uppercase()) {
            "GET" -> reqBuilder.get()
            "POST" -> reqBuilder.post((bodyJson ?: "{}").toRequestBody(jsonMedia))
            "PATCH" -> reqBuilder.patch((bodyJson ?: "{}").toRequestBody(jsonMedia))
            "DELETE" -> reqBuilder.delete(bodyJson?.toRequestBody(jsonMedia))
        }
        httpClient.newCall(reqBuilder.build()).execute().use { resp ->
            val raw = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                var code = "HTTP_${resp.code}"
                var message = "服务端返回错误 (${resp.code})"
                runCatching {
                    val obj = json.parseToJsonElement(raw).jsonObject
                    obj["code"]?.jsonPrimitive?.content?.let { code = it }
                    obj["message"]?.jsonPrimitive?.content?.let { message = it }
                }
                throw ApiHttpException(resp.code, code, message)
            }
            raw
        }
    }

    suspend fun health(serverUrl: String): HealthResponse {
        val raw = executeJson(serverUrl, listOf("api", "health"))
        return json.decodeFromString(HealthResponse.serializer(), raw)
    }

    suspend fun login(serverUrl: String, username: String, password: String, deviceName: String): LoginResponse {
        val body = buildJsonObject {
            put("username", username)
            put("password", password)
            put("kind", "mobile_account")
            put("deviceName", deviceName)
        }.toString()
        val raw = executeJson(serverUrl, listOf("api", "auth", "login"), method = "POST", bodyJson = body)
        return json.decodeFromString(LoginResponse.serializer(), raw)
    }

    suspend fun redeemPairCode(serverUrl: String, code: String, deviceName: String): PairResponse {
        val body = buildJsonObject {
            put("code", code)
            put("deviceName", deviceName)
        }.toString()
        val raw = executeJson(serverUrl, listOf("api", "auth", "pair"), method = "POST", bodyJson = body)
        return json.decodeFromString(PairResponse.serializer(), raw)
    }

    suspend fun refreshToken(serverUrl: String, token: String) {
        executeJson(serverUrl, listOf("api", "auth", "refresh"), method = "POST", token = token)
    }

    suspend fun logout(serverUrl: String, token: String) {
        executeJson(serverUrl, listOf("api", "auth", "logout"), method = "POST", token = token)
    }

    suspend fun listProfiles(serverUrl: String, token: String): List<MobileProfileListItem> {
        val raw = executeJson(serverUrl, listOf("api", "mobile", "profiles"), token = token)
        val obj = json.parseToJsonElement(raw).jsonObject
        val arr = obj["profiles"]?.jsonArray ?: return emptyList()
        return arr.map { json.decodeFromJsonElement(MobileProfileListItem.serializer(), it) }
    }

    suspend fun fetchToday(serverUrl: String, token: String, profileId: String?): MobileTodayResponse {
        val query = if (!profileId.isNullOrBlank()) mapOf("profileId" to profileId) else emptyMap()
        val raw = executeJson(serverUrl, listOf("api", "mobile", "today"), query = query, token = token)
        return json.decodeFromString(MobileTodayResponse.serializer(), raw)
    }

    suspend fun fetchCoursePrecomputedPlan(serverUrl: String, token: String, courseRecordId: String): PlayerPlanResultDto? {
        val raw = executeJson(
            serverUrl,
            listOf("api", "mobile", "courses", courseRecordId),
            query = mapOf("withTimeline" to "1"),
            token = token,
        )
        val obj = json.parseToJsonElement(raw).jsonObject
        val planEl = obj["precomputedPlan"] ?: return null
        return json.decodeFromJsonElement(PlayerPlanResultDto.serializer(), planEl)
    }

    suspend fun fetchMotionsBatch(
        serverUrl: String,
        token: String,
        ids: List<String>,
        knownHashes: Map<String, String>,
    ): MotionsBatchResponse {
        val body = buildJsonObject {
            put("ids", buildJsonArray { ids.forEach { add(JsonPrimitive(it)) } })
            put("knownHashes", buildJsonObject { knownHashes.forEach { (k, v) -> put(k, v) } })
        }.toString()
        val raw = executeJson(serverUrl, listOf("api", "mobile", "motions", "batch"), method = "POST", token = token, bodyJson = body)
        return json.decodeFromString(MotionsBatchResponse.serializer(), raw)
    }

    suspend fun syncSession(
        serverUrl: String,
        token: String,
        profileId: String,
        idempotencyKey: String,
        courseRecordId: String?,
        courseSnapshotHash: String?,
        sessionJson: String,
    ): SessionSyncResponse {
        val sessionEl = json.parseToJsonElement(sessionJson)
        val body = buildJsonObject {
            put("profileId", profileId)
            put("idempotencyKey", idempotencyKey)
            if (!courseRecordId.isNullOrBlank()) put("courseRecordId", courseRecordId)
            if (!courseSnapshotHash.isNullOrBlank()) put("courseSnapshotHash", courseSnapshotHash)
            put("session", sessionEl)
        }.toString()
        val raw = executeJson(serverUrl, listOf("api", "mobile", "sessions"), method = "POST", token = token, bodyJson = body)
        return json.decodeFromString(SessionSyncResponse.serializer(), raw)
    }

    suspend fun patchPlayback(
        serverUrl: String,
        token: String,
        profileId: String,
        breathLead: JsonElement?,
        breathAfter: String?,
        countTiming: String?,
    ) {
        val body = buildJsonObject {
            put("profileId", profileId)
            put(
                "playback",
                buildJsonObject {
                    if (breathLead != null) put("breathLead", breathLead)
                    if (breathAfter != null) put("breathAfter", breathAfter)
                    if (countTiming != null) put("countTiming", countTiming)
                },
            )
        }.toString()
        executeJson(serverUrl, listOf("api", "mobile", "playback"), method = "PATCH", token = token, bodyJson = body)
    }
}
