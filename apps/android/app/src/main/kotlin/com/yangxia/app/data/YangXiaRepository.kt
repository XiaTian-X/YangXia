package com.yangxia.app.data

import android.content.Context
import android.os.Build
import com.yangxia.app.network.ApiHttpException
import com.yangxia.app.network.YangXiaApiClient
import com.yangxia.app.player.CourseDto
import com.yangxia.app.player.DeliveryEnvelopeDto
import com.yangxia.app.player.MotionClipMetaDto
import com.yangxia.app.player.PlaybackSettingsDto
import com.yangxia.app.player.PlayerPlanResultDto
import com.yangxia.app.player.QuickJsTimelineProvider
import com.yangxia.app.player.ServerPrecomputedTimelineProvider
import com.yangxia.app.player.TimelineProvider
import com.yangxia.app.security.AuthCredentials
import com.yangxia.app.security.SecureTokenStore
import com.yangxia.app.storage.CachedCourseEntity
import com.yangxia.app.storage.CachedMotionEntity
import com.yangxia.app.storage.CachedProfileEntity
import com.yangxia.app.storage.DevicePrefs
import com.yangxia.app.storage.DevicePrefsStore
import com.yangxia.app.storage.PendingSessionEntity
import com.yangxia.app.storage.YangXiaDatabase
import kotlinx.coroutines.flow.first
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.Instant
import java.util.UUID

data class SyncReport(
    val syncedCount: Int,
    val clockSkewBlocked: Boolean,
    val lastError: String?,
)

class YangXiaRepository(context: Context) {
    private val appContext = context.applicationContext
    val tokenStore = SecureTokenStore(appContext)
    val prefsStore = DevicePrefsStore(appContext)
    val db = YangXiaDatabase.getInstance(appContext)
    val api = YangXiaApiClient(allowTailscale = { tokenStore.isAllowTailscaleCleartext() })
    @OptIn(ExperimentalSerializationApi::class)
    val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    val quickJsProvider = QuickJsTimelineProvider(
        runtimeJsLoader = {
            appContext.assets.open("player-runtime.js").bufferedReader().use { it.readText() }
        },
        json = json,
    )

    fun deviceDisplayName(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()

    suspend fun loginWithPassword(serverUrl: String, username: String, password: String): AuthCredentials {
        val cleanUrl = serverUrl.trim().trimEnd('/')
        val res = api.login(cleanUrl, username, password, deviceDisplayName())
        val creds = AuthCredentials(
            serverUrl = cleanUrl,
            token = res.token,
            sessionKind = "mobile_account",
            boundProfileId = null,
            boundProfileCode = null,
            username = username,
        )
        tokenStore.saveCredentials(creds)
        refreshAllProfilesAndToday()
        return creds
    }

    suspend fun loginWithPairCode(serverUrl: String, pairCode: String): AuthCredentials {
        val cleanUrl = serverUrl.trim().trimEnd('/')
        val res = api.redeemPairCode(cleanUrl, pairCode.trim(), deviceDisplayName())
        val creds = AuthCredentials(
            serverUrl = cleanUrl,
            token = res.token,
            sessionKind = "mobile_bound",
            boundProfileId = res.profileId,
            boundProfileCode = res.profileCode,
            username = null,
        )
        tokenStore.saveCredentials(creds)
        prefsStore.setActiveProfileId(res.profileId)
        refreshTodayForProfile(res.profileId)
        return creds
    }

    suspend fun logout() {
        tokenStore.clearToken()
        db.profileDao().clearAll()
        db.courseDao().clearAll()
        prefsStore.setActiveProfileId("")
    }

    suspend fun refreshAllProfilesAndToday(): String? {
        val creds = tokenStore.loadCredentials() ?: return null
        runCatching { api.refreshToken(creds.serverUrl, creds.token) }

        if (creds.sessionKind == "mobile_bound" && !creds.boundProfileId.isNullOrBlank()) {
            refreshTodayForProfile(creds.boundProfileId)
            return creds.boundProfileId
        }

        val remoteProfiles = api.listProfiles(creds.serverUrl, creds.token)
        val entities = remoteProfiles.map { p ->
            CachedProfileEntity(
                profileId = p.id,
                code = p.code,
                age = p.age,
                product = p.product,
                supportedForWorkout = p.age != "a06",
                hasConflict = p.hasConflict,
                conflictMessage = p.conflict?.get("message")?.jsonPrimitive?.content,
                playbackJson = db.profileDao().getById(p.id)?.playbackJson,
                updatedAt = p.updatedAt,
            )
        }
        db.profileDao().upsertAll(entities)

        val currentActive = prefsStore.prefsFlow.first().activeProfileId
        val chosen = if (entities.any { it.profileId == currentActive }) currentActive else entities.firstOrNull()?.profileId
        if (!chosen.isNullOrBlank()) {
            prefsStore.setActiveProfileId(chosen)
            refreshTodayForProfile(chosen)
        }
        return chosen
    }

    suspend fun refreshTodayForProfile(profileId: String) {
        val creds = tokenStore.loadCredentials() ?: return
        val today = api.fetchToday(creds.serverUrl, creds.token, profileId)
        val nowIso = Instant.now().toString()
        val resolvedPid = today.profileId.ifBlank { profileId }
        val conflictMsg = today.conflict?.get("message")?.jsonPrimitive?.content
            ?: if (today.hasConflict) "检测到迟到不适记录或规则冲突，请前往网页端复盘处理" else null

        db.profileDao().upsert(
            CachedProfileEntity(
                profileId = resolvedPid,
                code = today.code,
                age = today.age,
                product = today.product,
                supportedForWorkout = today.supported,
                hasConflict = today.hasConflict,
                conflictMessage = conflictMsg,
                playbackJson = today.playback?.toString(),
                updatedAt = nowIso,
            ),
        )

        val prefs = prefsStore.prefsFlow.first()
        val activeEntities = today.activeCourses.map { c ->
            val prePlanJson = if (prefs.useServerPrecomputed) {
                runCatching {
                    api.fetchCoursePrecomputedPlan(creds.serverUrl, creds.token, c.id)
                        ?.let { json.encodeToString(PlayerPlanResultDto.serializer(), it) }
                }.getOrNull()
            } else {
                db.courseDao().getByRecordId(c.id)?.precomputedPlanJson
            }
            CachedCourseEntity(
                courseRecordId = c.id,
                profileId = resolvedPid,
                courseId = c.courseId,
                courseName = c.envelope.course.name,
                segment = c.segment,
                week = c.week,
                day = c.day,
                half = c.half,
                snapshotHash = c.snapshotHash.ifBlank { c.envelope.snapshotHash },
                envelopeJson = json.encodeToString(DeliveryEnvelopeDto.serializer(), c.envelope),
                precomputedPlanJson = prePlanJson,
                status = "active",
                invalidatedReason = null,
                updatedAt = c.updatedAt.ifBlank { nowIso },
            )
        }

        val activeIds = activeEntities.map { it.courseRecordId }
        if (activeIds.isEmpty()) {
            db.courseDao().deleteAllActiveForProfile(resolvedPid)
        } else {
            db.courseDao().pruneMissingActive(resolvedPid, activeIds)
        }

        val invalidatedEntities = today.invalidatedCourses.map { ic ->
            val existing = db.courseDao().getByRecordId(ic.id)
            CachedCourseEntity(
                courseRecordId = ic.id,
                profileId = resolvedPid,
                courseId = ic.courseId,
                courseName = existing?.courseName ?: "第 ${ic.week} 周 ${ic.day} 日",
                segment = ic.segment,
                week = ic.week,
                day = ic.day,
                half = ic.half,
                snapshotHash = existing?.snapshotHash ?: "",
                envelopeJson = existing?.envelopeJson ?: "",
                precomputedPlanJson = null,
                status = "invalidated",
                invalidatedReason = ic.invalidatedReason ?: "规则或模板已变更，此课已作废",
                updatedAt = ic.updatedAt.ifBlank { nowIso },
            )
        }
        db.courseDao().upsertAll(activeEntities + invalidatedEntities)

        val neededHashes = mutableMapOf<String, String>()
        for (c in today.activeCourses) neededHashes.putAll(c.envelope.motionHashes)
        if (neededHashes.isNotEmpty()) {
            val localHashes = db.motionDao().listHashes().associate { it.clipId to it.hash }
            val missingOrChanged = neededHashes.filter { (id, h) -> localHashes[id] != h }.keys.toList()
            val nowMs = System.currentTimeMillis()
            if (missingOrChanged.isNotEmpty()) {
                val batch = api.fetchMotionsBatch(creds.serverUrl, creds.token, missingOrChanged, localHashes)
                val upserts = batch.clips.map { (clipId, clipEl) ->
                    CachedMotionEntity(
                        clipId = clipId,
                        hash = batch.hashes[clipId] ?: neededHashes[clipId].orEmpty(),
                        jsonContent = clipEl.toString(),
                        lastUsedAt = nowMs,
                    )
                }
                if (upserts.isNotEmpty()) db.motionDao().upsertAll(upserts)
            }
            db.motionDao().touchUsed(neededHashes.keys.toList(), nowMs)
            db.motionDao().pruneLru(80)
        }
    }

    suspend fun buildPlanForCachedCourse(
        courseEntity: CachedCourseEntity,
        devicePrefs: DevicePrefs,
        profilePlaybackJson: String?,
    ): Triple<DeliveryEnvelopeDto, String, PlayerPlanResultDto> {
        val envelope = json.decodeFromString(DeliveryEnvelopeDto.serializer(), courseEntity.envelopeJson)
        val rawCourseJson = runCatching {
            json.parseToJsonElement(courseEntity.envelopeJson).jsonObject["course"]?.toString()
        }.getOrNull() ?: json.encodeToString(CourseDto.serializer(), envelope.course)
        val mergedDevicePrefs = buildDevicePrefsDto(devicePrefs, profilePlaybackJson)
        val provider: TimelineProvider = if (devicePrefs.useServerPrecomputed && !courseEntity.precomputedPlanJson.isNullOrBlank()) {
            val cached = json.decodeFromString(PlayerPlanResultDto.serializer(), courseEntity.precomputedPlanJson)
            ServerPrecomputedTimelineProvider({ cached }, json)
        } else {
            quickJsProvider
        }
        val devicePrefsJson = json.encodeToString(PlaybackSettingsDto.serializer(), mergedDevicePrefs)
        val plan = provider.buildPlayerPlan(rawCourseJson, devicePrefsJson, null)
        return Triple(envelope, rawCourseJson, plan)
    }

    private fun buildDevicePrefsDto(device: DevicePrefs, profilePlaybackJson: String?): PlaybackSettingsDto {
        val pbObj = profilePlaybackJson?.let { runCatching { json.parseToJsonElement(it).jsonObject }.getOrNull() }
        return PlaybackSettingsDto(
            bpm = 60,
            sound = device.soundStyle,
            voice = if (device.forceOfflineVoice) "synth" else "tts",
            timbre = "warm",
            music = "none",
            musicVolume = 0,
            voiceVolume = device.voiceVol,
            soundVolume = device.cueVol,
            breathVolume = device.breathVol,
            breathLead = pbObj?.get("breathLead"),
            breathAfter = pbObj?.get("breathAfter")?.jsonPrimitive?.content ?: "pluck",
            countTiming = pbObj?.get("countTiming")?.jsonPrimitive?.content ?: "on-up",
            vibrate = device.vibrate,
        )
    }

    suspend fun loadMotionClips(clipIds: List<String>): Pair<Map<String, String>, Map<String, MotionClipMetaDto>> {
        if (clipIds.isEmpty()) return emptyMap<String, String>() to emptyMap()
        val rows = db.motionDao().getByIds(clipIds)
        val rawMap = mutableMapOf<String, String>()
        val metaMap = mutableMapOf<String, MotionClipMetaDto>()
        for (row in rows) {
            runCatching {
                val obj = json.parseToJsonElement(row.jsonContent).jsonObject
                val lottieEl = obj["lottie"] ?: obj
                val lottieObj = lottieEl.jsonObject
                rawMap[row.clipId] = lottieEl.toString()
                val phasesMap = obj["phases"]?.jsonObject?.mapValues { (_, v) ->
                    v.jsonArray.mapNotNull { it.jsonPrimitive.doubleOrNull }
                }
                metaMap[row.clipId] = MotionClipMetaDto(
                    exercises = obj["exercises"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),
                    frames = obj["frames"]?.jsonPrimitive?.intOrNull ?: 24,
                    dur = obj["dur"]?.jsonPrimitive?.doubleOrNull ?: 2.0,
                    w = obj["w"]?.jsonPrimitive?.intOrNull ?: 200,
                    h = obj["h"]?.jsonPrimitive?.intOrNull ?: 200,
                    phases = phasesMap,
                    hold = obj["hold"]?.jsonPrimitive?.doubleOrNull,
                    loop = obj["loop"]?.jsonPrimitive?.booleanOrNull ?: false,
                    lottieIp = lottieObj["ip"]?.jsonPrimitive?.doubleOrNull ?: 0.0,
                    lottieOp = lottieObj["op"]?.jsonPrimitive?.doubleOrNull,
                )
            }
        }
        return rawMap to metaMap
    }

    suspend fun enqueueAndSyncSession(
        profileId: String,
        courseRecordId: String,
        courseSnapshotHash: String,
        courseJson: String,
        timelineJson: String,
        playedIndices: List<Int>,
        startedAtIso: String,
        endedAtIso: String,
        setsDoneOverride: List<Int>,
        symptoms: List<String>,
        feel: String,
        note: String,
    ): SyncReport {
        val baseSessionJson = quickJsProvider.buildPlayerSessionJson(
            courseJson = courseJson,
            timelineJson = timelineJson,
            playedIndices = playedIndices,
            startedAtIso = startedAtIso,
            endedAtIso = endedAtIso,
            symptoms = symptoms,
            feeling = feel,
            note = note,
        )
        val pain = symptoms.contains("疼痛")
        val dizzy = symptoms.contains("头晕")
        val chest = symptoms.contains("胸闷")
        // 若用户微调了完成组数，用 QuickJS buildSession 精确写入
        val finalSessionJson = if (setsDoneOverride.isNotEmpty()) {
            val setsMapJson = json.encodeToString(setsDoneOverride.mapIndexed { i, v -> i.toString() to v }.toMap())
            quickJsProvider.evalRawJson(
                """(function() {
                    var c = JSON.parse(${QuickJsTimelineProvider.lit(courseJson)});
                    var s = JSON.parse(${QuickJsTimelineProvider.lit(setsMapJson)});
                    var sess = globalThis.YangXiaPlayer.buildSession(c, {
                      startedAt: new Date(${QuickJsTimelineProvider.lit(startedAtIso)}),
                      endedAt: new Date(${QuickJsTimelineProvider.lit(endedAtIso)}),
                      setsDone: s,
                      symptoms: { pain: $pain, dizzy: $dizzy, chest: $chest },
                      feeling: ${QuickJsTimelineProvider.lit(feel)},
                      note: ${QuickJsTimelineProvider.lit(note)}
                    });
                    return globalThis.__yxToJniSafeJson(sess);
                })()""",
            )
        } else {
            baseSessionJson
        }

        val course = json.decodeFromString(CourseDto.serializer(), courseJson)
        val item = PendingSessionEntity(
            idempotencyKey = UUID.randomUUID().toString(),
            profileId = profileId,
            courseRecordId = courseRecordId,
            courseId = course.id,
            courseSnapshotHash = courseSnapshotHash.ifBlank { null },
            startedAt = startedAtIso,
            sessionJson = finalSessionJson,
            lastErrorCode = null,
            lastErrorMessage = null,
            retryCount = 0,
            createdAt = System.currentTimeMillis(),
        )
        db.pendingSessionDao().insertIgnore(item)
        return flushPendingSessions()
    }

    suspend fun flushPendingSessions(): SyncReport {
        val creds = tokenStore.loadCredentials() ?: return SyncReport(0, false, "未登录")
        val pending = db.pendingSessionDao().listAll()
        var synced = 0
        var clockSkew = false
        var lastError: String? = null
        for (item in pending) {
            try {
                api.syncSession(
                    serverUrl = creds.serverUrl,
                    token = creds.token,
                    profileId = item.profileId,
                    idempotencyKey = item.idempotencyKey,
                    courseRecordId = item.courseRecordId,
                    courseSnapshotHash = item.courseSnapshotHash,
                    sessionJson = item.sessionJson,
                )
                db.pendingSessionDao().deleteByKey(item.idempotencyKey)
                synced++
            } catch (e: ApiHttpException) {
                db.pendingSessionDao().recordError(item.idempotencyKey, e.code, e.message)
                if (e.code == "CLOCK_SKEW_FUTURE") clockSkew = true
                lastError = e.message
            } catch (e: Exception) {
                db.pendingSessionDao().recordError(item.idempotencyKey, "NETWORK_ERROR", e.message)
                lastError = e.message
            }
        }
        return SyncReport(synced, clockSkew, lastError)
    }

    suspend fun updateProfilePlayback(
        profileId: String,
        breathLead: JsonElement?,
        breathAfter: String?,
        countTiming: String?,
    ) {
        val creds = tokenStore.loadCredentials() ?: return
        api.patchPlayback(creds.serverUrl, creds.token, profileId, breathLead, breathAfter, countTiming)
        refreshTodayForProfile(profileId)
    }
}
