package com.yangxia.app.network

import com.yangxia.app.player.DeliveryEnvelopeDto
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
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
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
    val courseId: String,
    val segment: Int,
    val week: Int,
    val day: String,
    val half: Boolean = false,
    val snapshotHash: String = "",
    val updatedAt: String = "",
    val envelope: DeliveryEnvelopeDto,
)

@Serializable
data class MobileInvalidatedCourseDto(
    val id: String,
    val courseId: String,
    val segment: Int,
    val week: Int,
    val day: String,
    val half: Boolean = false,
    val invalidatedReason: String? = null,
    val updatedAt: String = "",
)

@Serializable
data class MobileTodayResponse(
    val declaration: String = "未经专业审核，不是医学建议，不能替代医生的判断",
    val profileId: String = "",
    val code: String = "",
    val age: String = "",
    val product: String = "",
    val supported: Boolean = true,
    val message: String? = null,
    val hasConflict: Boolean = false,
    val conflict: JsonObject? = null,
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
    val hasConflict: Boolean = false,
    val conflict: JsonObject? = null,
    val updatedAt: String = "",
)

@Serializable
data class MotionsBatchResponse(
    val clips: Map<String, JsonElement> = emptyMap(),
    val hashes: Map<String, String> = emptyMap(),
    val unchanged: List<String> = emptyList(),
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

    val httpClient: OkHttpClient = OkHttpClient.Builder()
        .dns(safeDns)
        .addInterceptor(SafePrivateNetAppInterceptor(safeDns))
        .addNetworkInterceptor(SafePrivateNetNetworkInterceptor(allowTailscale, safeDns))
        .followRedirects(true)
        .followSslRedirects(false)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private suspend fun executeJson(
        serverUrl: String,
        path: String,
        method: String = "GET",
        token: String? = null,
        bodyJson: String? = null,
    ): String = withContext(Dispatchers.IO) {
        val base = serverUrl.trim().trimEnd('/')
        val url = "$base$path"
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
        val raw = executeJson(serverUrl, "/api/health")
        return json.decodeFromString(HealthResponse.serializer(), raw)
    }

    suspend fun login(serverUrl: String, username: String, password: String, deviceName: String): LoginResponse {
        val body = buildJsonObject {
            put("username", username)
            put("password", password)
            put("kind", "mobile_account")
            put("deviceName", deviceName)
        }.toString()
        val raw = executeJson(serverUrl, "/api/auth/login", method = "POST", bodyJson = body)
        return json.decodeFromString(LoginResponse.serializer(), raw)
    }

    suspend fun redeemPairCode(serverUrl: String, code: String, deviceName: String): PairResponse {
        val body = buildJsonObject {
            put("code", code)
            put("deviceName", deviceName)
        }.toString()
        val raw = executeJson(serverUrl, "/api/auth/pair", method = "POST", bodyJson = body)
        return json.decodeFromString(PairResponse.serializer(), raw)
    }

    suspend fun refreshToken(serverUrl: String, token: String) {
        executeJson(serverUrl, "/api/auth/refresh", method = "POST", token = token)
    }

    suspend fun listProfiles(serverUrl: String, token: String): List<MobileProfileListItem> {
        val raw = executeJson(serverUrl, "/api/profiles", token = token)
        val obj = json.parseToJsonElement(raw).jsonObject
        val arr = obj["profiles"]?.jsonArray ?: return emptyList()
        return arr.map { json.decodeFromJsonElement(MobileProfileListItem.serializer(), it) }
    }

    suspend fun fetchToday(serverUrl: String, token: String, profileId: String?): MobileTodayResponse {
        val q = if (!profileId.isNullOrBlank()) "?profileId=$profileId" else ""
        val raw = executeJson(serverUrl, "/api/mobile/today$q", token = token)
        return json.decodeFromString(MobileTodayResponse.serializer(), raw)
    }

    suspend fun fetchCoursePrecomputedPlan(serverUrl: String, token: String, courseRecordId: String): PlayerPlanResultDto? {
        val raw = executeJson(serverUrl, "/api/mobile/courses/$courseRecordId?withTimeline=1", token = token)
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
        val raw = executeJson(serverUrl, "/api/mobile/motions/batch", method = "POST", token = token, bodyJson = body)
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
        val raw = executeJson(serverUrl, "/api/mobile/sessions", method = "POST", token = token, bodyJson = body)
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
        executeJson(serverUrl, "/api/mobile/playback", method = "PATCH", token = token, bodyJson = body)
    }
}
