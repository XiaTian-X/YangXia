package com.yangxia.app

import com.yangxia.app.audio.OfflineAudioMixer
import com.yangxia.app.network.MobileTodayResponse
import com.yangxia.app.network.MotionsBatchResponse
import com.yangxia.app.player.LiveViewMath
import com.yangxia.app.player.MotionClipMetaDto
import com.yangxia.app.player.QuickJsTimelineProvider
import com.yangxia.app.player.ServerPrecomputedTimelineProvider
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.zip.GZIPInputStream
import kotlin.math.abs

class GoldenPlayerParityTest {

    @OptIn(ExperimentalSerializationApi::class)
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    private fun resolveRepoFile(relative: String): File {
        // Gradle test 工作目录在 apps/android/app
        val candidates = listOf(
            File("../../../$relative"),
            File("../../$relative"),
            File(relative),
        )
        return candidates.firstOrNull { it.exists() }
            ?: error("找不到测试基线文件：$relative (cwd=${File(".").absolutePath})")
    }

    @Test
    fun quickJsAndKotlinLiveViewMatchAllGoldenCasesBitForBit() = runTest {
        val runtimeFile = File("src/main/assets/player-runtime.js")
        assertTrue("缺少 assets/player-runtime.js", runtimeFile.exists())

        val goldenFile = resolveRepoFile("contracts/fixtures/golden-player.json")
        val motionsFile = resolveRepoFile("contracts/fixtures/data/motions.json")
        val goldenRoot = json.parseToJsonElement(goldenFile.readText()).jsonObject
        val motionsRoot = json.parseToJsonElement(motionsFile.readText()).jsonObject
        val clipsJson = motionsRoot["clips"]!!.jsonObject

        val clipMetaMap = clipsJson.entries.associate { (k, v) ->
            val obj = v.jsonObject
            val lottie = obj["lottie"]?.jsonObject
            val phases = obj["phases"]?.jsonObject?.mapValues { (_, pv) ->
                pv.jsonArray.mapNotNull { it.jsonPrimitive.doubleOrNull }
            }
            k to MotionClipMetaDto(
                exercises = obj["exercises"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),
                frames = obj["frames"]?.jsonPrimitive?.intOrNull ?: 1,
                dur = obj["dur"]?.jsonPrimitive?.doubleOrNull ?: 1.0,
                phases = phases,
                hold = obj["hold"]?.jsonPrimitive?.doubleOrNull,
                loop = obj["loop"]?.jsonPrimitive?.booleanOrNull ?: false,
                lottieIp = lottie?.get("ip")?.jsonPrimitive?.doubleOrNull ?: 0.0,
                lottieOp = lottie?.get("op")?.jsonPrimitive?.doubleOrNull,
            )
        }

        val provider = QuickJsTimelineProvider({ runtimeFile.readText() }, json)
        try {
            val cases = goldenRoot["cases"]!!.jsonArray
            assertEquals("应包含全部 8 个跨端黄金用例", 8, cases.size)

            for (caseEl in cases) {
                val cObj = caseEl.jsonObject
                val caseId = cObj["id"]!!.jsonPrimitive.content
                val courseJson = cObj["course"]!!.toString()
                val devicePrefsJson = cObj["devicePrefs"]?.toString() ?: "{}"
                val userPatchJson = cObj["userPatch"]?.toString()
                val expected = cObj["expected"]!!.jsonObject

                val plan = provider.buildPlayerPlan(courseJson, devicePrefsJson, userPatchJson)

                // 1. floor & totalDuration & eventCount & stageCount & units 100% 精确一致
                val expFloor = expected["floor"]?.jsonPrimitive?.content?.takeUnless { it == "null" }
                assertEquals("[$caseId] floor", expFloor, plan.floor)
                assertEquals("[$caseId] totalDuration", expected["totalDuration"]!!.jsonPrimitive.doubleOrNull!!, plan.timeline.totalDuration, 1e-4)
                assertEquals("[$caseId] eventCount", expected["eventCount"]!!.jsonPrimitive.int, plan.timeline.events.size)
                assertEquals("[$caseId] stageCount", expected["stageCount"]!!.jsonPrimitive.int, plan.timeline.stages.size)
                assertEquals(
                    "[$caseId] units",
                    expected["units"]!!.jsonArray.map { it.jsonPrimitive.content },
                    plan.units,
                )

                // 2. 抽样事件时间、cueType、voice、voiceTokens、breathPluck 零偏差
                for (se in expected["sampleEvents"]!!.jsonArray) {
                    val seObj = se.jsonObject
                    val idx = seObj["index"]!!.jsonPrimitive.int
                    val expEv = seObj["event"]!!.jsonObject
                    val actualEv = plan.timeline.events[idx]
                    assertEquals("[$caseId] ev[$idx].time", expEv["time"]!!.jsonPrimitive.doubleOrNull!!, actualEv.time, 1e-4)
                    assertEquals("[$caseId] ev[$idx].cueType", expEv["cueType"]!!.jsonPrimitive.content, actualEv.cueType)
                    val expTokens = expEv["voiceTokens"]?.takeIf { it.toString() != "null" }?.jsonArray?.map { it.jsonPrimitive.content }
                    assertEquals("[$caseId] ev[$idx].voiceTokens", expTokens, actualEv.voiceTokens)
                }

                // 3. 纯 Kotlin 60fps LiveViewMath.liveFrame 与 motionAt 逐帧误差 < 1e-4
                for (fs in expected["frameSamples"]!!.jsonArray) {
                    val fsObj = fs.jsonObject
                    val idx = fsObj["idx"]!!.jsonPrimitive.int
                    val t = fsObj["t"]!!.jsonPrimitive.doubleOrNull!!
                    val expFrame = fsObj["frame"]!!.jsonObject

                    val actualFrame = LiveViewMath.liveFrame(plan.course, plan.timeline, idx, t)
                    assertEquals("[$caseId] frame[$idx].mode", expFrame["mode"]!!.jsonPrimitive.content, actualFrame.mode)
                    assertEquals("[$caseId] frame[$idx].title", expFrame["title"]!!.jsonPrimitive.content, actualFrame.title)
                    assertEquals("[$caseId] frame[$idx].sub", expFrame["sub"]!!.jsonPrimitive.content, actualFrame.sub)
                    assertEquals("[$caseId] frame[$idx].big", expFrame["big"]!!.jsonPrimitive.content, actualFrame.big)
                    assertEquals("[$caseId] frame[$idx].small", expFrame["small"]!!.jsonPrimitive.content, actualFrame.small)
                    assertEquals("[$caseId] frame[$idx].over", expFrame["over"]!!.jsonPrimitive.content, actualFrame.over)
                    assertEquals("[$caseId] frame[$idx].ring", expFrame["ring"]!!.jsonPrimitive.doubleOrNull!!, actualFrame.ring, 1e-4)
                    val expBreath = expFrame["breath"]?.takeIf { it.toString() != "null" }?.jsonPrimitive?.content
                    assertEquals("[$caseId] frame[$idx].breath", expBreath, actualFrame.breath)
                    assertEquals("[$caseId] frame[$idx].phase", expFrame["phase"]!!.jsonPrimitive.content, actualFrame.phase)
                    assertEquals("[$caseId] frame[$idx].next", expFrame["next"]!!.jsonPrimitive.content, actualFrame.next)

                    val expMotion = fsObj["motion"]?.takeIf { it.toString() != "null" }?.jsonObject
                    val actualMotion = LiveViewMath.motionAt(plan.timeline, plan.course, clipMetaMap, t)
                    if (expMotion == null) {
                        assertEquals("[$caseId] motion[$idx] should be null", null, actualMotion)
                    } else {
                        assertNotNull("[$caseId] motion[$idx] should not be null", actualMotion)
                        assertEquals("[$caseId] motion[$idx].clip", expMotion["clip"]!!.jsonPrimitive.content, actualMotion!!.clip)
                        assertEquals("[$caseId] motion[$idx].frame", expMotion["frame"]!!.jsonPrimitive.doubleOrNull!!, actualMotion.frame, 1e-4)
                        assertEquals("[$caseId] motion[$idx].progress", expMotion["progress"]!!.jsonPrimitive.doubleOrNull!!.toFloat(), actualMotion.lottieProgress, 1e-4f)
                        assertEquals("[$caseId] motion[$idx].note", expMotion["note"]!!.jsonPrimitive.content, actualMotion.note)
                        assertEquals("[$caseId] motion[$idx].perSide", expMotion["perSide"]!!.jsonPrimitive.booleanOrNull, actualMotion.perSide)
                    }
                }

                // 4. buildPlayerSession 输出与 golden expectedSession 完全一致
                val sc = expected["sessionCheck"]?.takeIf { it.toString() != "null" }?.jsonObject
                if (sc != null) {
                    val played = sc["playedIndices"]!!.jsonArray.map { it.jsonPrimitive.int }
                    val symObj = sc["symptoms"]!!.jsonObject
                    val syms = buildList {
                        if (symObj["pain"]?.jsonPrimitive?.booleanOrNull == true) add("疼痛")
                        if (symObj["dizzy"]?.jsonPrimitive?.booleanOrNull == true) add("头晕")
                        if (symObj["chest"]?.jsonPrimitive?.booleanOrNull == true) add("胸闷")
                    }
                    val tlJson = json.encodeToString(com.yangxia.app.player.TimelineDto.serializer(), plan.timeline)
                    val noteText = sc["note"]?.takeIf { it.toString() != "null" }?.jsonPrimitive?.content ?: ""
                    val editedFlag = sc["edited"]?.jsonPrimitive?.booleanOrNull == true
                    val actualSessJson = provider.buildPlayerSessionJson(
                        courseJson = courseJson,
                        timelineJson = tlJson,
                        playedIndices = played,
                        startedAtIso = sc["startedAt"]!!.jsonPrimitive.content,
                        endedAtIso = sc["endedAt"]!!.jsonPrimitive.content,
                        symptoms = syms,
                        feeling = sc["feeling"]!!.jsonPrimitive.content,
                        note = noteText,
                        edited = editedFlag,
                    )
                    assertEquals(
                        "[$caseId] sessionCheck (QuickJS)",
                        sc["expectedSession"]!!,
                        json.parseToJsonElement(actualSessJson),
                    )
                    // 同时验证可逆回退 Provider（ServerPrecomputedTimelineProvider）产出完全一致
                    val fallback = ServerPrecomputedTimelineProvider({ plan }, json)
                    val fallbackSessJson = fallback.buildPlayerSessionJson(
                        courseJson = courseJson,
                        timelineJson = tlJson,
                        playedIndices = played,
                        startedAtIso = sc["startedAt"]!!.jsonPrimitive.content,
                        endedAtIso = sc["endedAt"]!!.jsonPrimitive.content,
                        symptoms = syms,
                        feeling = sc["feeling"]!!.jsonPrimitive.content,
                        note = noteText,
                        edited = editedFlag,
                    )
                    assertEquals(
                        "[$caseId] sessionCheck (ServerPrecomputedFallback)",
                        sc["expectedSession"]!!,
                        json.parseToJsonElement(fallbackSessJson),
                    )
                }
            }
        } finally {
            provider.close()
        }
    }

    @Test
    fun offlineAudioPackAndCrossfadeMixerWorkCorrectly() {
        val manifestFile = File("src/main/assets/audio/audio_manifest.json")
        val pcmGzFile = File("src/main/assets/audio/audio_pcm.gz")
        assertTrue(manifestFile.exists())
        assertTrue(pcmGzFile.exists())

        val manifest = json.parseToJsonElement(manifestFile.readText()).jsonObject
        assertEquals(16, manifest["cueCount"]!!.jsonPrimitive.int)
        assertEquals(27, manifest["voiceCount"]!!.jsonPrimitive.int)
        val entries = manifest["entries"]!!.jsonObject
        val rawBytes = GZIPInputStream(pcmGzFile.inputStream()).use { it.readBytes() }

        fun loadTok(key: String): ShortArray {
            val e = entries["tok:$key"]!!.jsonObject
            return OfflineAudioMixer.decodeLittleEndianPcm16(
                rawBytes,
                e["offsetSamples"]!!.jsonPrimitive.int,
                e["lengthSamples"]!!.jsonPrimitive.int,
            )
        }

        val t10 = loadTok("10_short")
        val t2 = loadTok("2")
        val merged = OfflineAudioMixer.crossfadeConcat(listOf(t10, t2), 22050, 12.0)
        // 12ms @ 22050Hz = 265 samples overlap
        val expectedOv = kotlin.math.round(0.012 * 22050).toInt()
        assertEquals(t10.size + t2.size - expectedOv, merged.size)

        // 高 BPM 采样率倍率验证
        assertEquals(22050, OfflineAudioMixer.playbackSampleRateForBpm(22050, 60))
        assertEquals(22050, OfflineAudioMixer.playbackSampleRateForBpm(22050, 76))
        val fastSr = OfflineAudioMixer.playbackSampleRateForBpm(22050, 95)
        assertTrue("BPM=95 应加速播放采样率，实得 $fastSr", fastSr in 27000..28300)
        val clampedScale = OfflineAudioMixer.tempoScaleForBpm(140)
        assertTrue(abs(clampedScale - 0.78) < 1e-6)
    }

    @Test
    fun serverMobileContractAndHypertensionFloorSurviveRoundTrip() = runTest {
        // 核对真实服务端 /api/mobile/today（含嵌套 profile 与 coaching.floor）与 /api/mobile/motions/batch 契约
        val todayPayload = """
            {
              "profile": {
                "id": "11111111-1111-4111-8111-111111111111",
                "code": "爸爸",
                "age": "a40",
                "stage": "40–64 岁",
                "product": "40-64岁-居家版",
                "timezone": "Asia/Shanghai",
                "version": 2,
                "hasConflict": true,
                "conflict": { "message": "发现迟到不适记录，请先复盘处理" }
              },
              "supported": true,
              "declaration": "未经专业审核，不是医学建议，不能替代医生的判断",
              "playback": { "breathAfter": "quiet", "breathLead": 0 },
              "activeCourses": [{
                "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "courseId": "c_bp0001",
                "segment": 1,
                "week": 1,
                "day": "A",
                "half": false,
                "status": "active",
                "snapshotHash": "snap-1",
                "updatedAt": "2026-11-24T01:00:00Z",
                "envelope": {
                  "schema": "yangxia.delivery/1",
                  "declaration": "未经专业审核，不是医学建议，不能替代医生的判断",
                  "course": {
                    "schema": "yangxia.course/1",
                    "id": "c_bp0001",
                    "name": "40-64 居家第1周A日",
                    "age": "a40",
                    "source": { "product": "40-64岁-居家版", "templates": "v1.0.0", "week": 1, "day": "A", "plan": "yangxia.plans/1", "segment": 1 },
                    "coaching": { "floor": "pluck" },
                    "blocks": [{
                      "kind": "sets",
                      "items": [{
                        "exercise": "squat",
                        "name": "徒手深蹲",
                        "mode": "reps",
                        "sets": 2,
                        "reps": 8,
                        "rest": 60,
                        "tempo": { "start": "down", "down": 2, "up": 1 },
                        "quote": ["测试"]
                      }]
                    }]
                  },
                  "follow": ["稳态快走 20 分钟"],
                  "notes": ["高血压保守模式：禁止憋气"],
                  "motionHashes": { "squat": "h-squat" }
                }
              }],
              "invalidatedCourses": []
            }
        """.trimIndent()

        val today = json.decodeFromString(MobileTodayResponse.serializer(), todayPayload)
        assertEquals("爸爸", today.profile.code)
        assertTrue("迟到不适冲突告警必须被保留", today.profile.hasConflict)
        assertEquals("发现迟到不适记录，请先复盘处理", today.profile.conflict?.get("message")?.jsonPrimitive?.content)
        assertEquals(1, today.activeCourses.size)

        // 原始 JSON 信封原样保留 coaching.floor = "pluck"，即使尝试用 quiet / volume=0 覆盖也绝不能静音
        val rawCourseJson = today.activeCourses[0].envelope["course"]!!.toString()
        val runtimeFile = File("src/main/assets/player-runtime.js")
        val provider = QuickJsTimelineProvider({ runtimeFile.readText() }, json)
        try {
            val plan = provider.buildPlayerPlan(rawCourseJson, """{"breathVolume":15}""", """{"breathAfter":"quiet","breathLead":0}""")
            assertEquals("pluck", plan.floor)
            assertEquals("pluck", plan.effectiveSettings.breathAfter)
            val enforced = LiveViewMath.enforceSafetyFloor(plan.effectiveSettings.copy(breathVolume = 0, breathAfter = "quiet"), plan.floor)
            assertEquals("pluck", enforced.breathAfter)
            assertTrue("换气下限音量必须 >= 15", enforced.breathVolume >= 15)

            // 验证「上一段 / 下一段」精准段跳转（落点严格对齐 stages[i].firstEventIdx，不腰斩节拍）
            assertTrue("测试课程应包含多段", plan.timeline.stages.size >= 3)
            val s0Time = plan.timeline.events[plan.timeline.stages[0].firstEventIdx].time
            val s1Idx = plan.timeline.stages[1].firstEventIdx
            val s1Time = plan.timeline.events[s1Idx].time
            val s2Idx = plan.timeline.stages[2].firstEventIdx
            val s2Time = plan.timeline.events[s2Idx].time

            assertEquals(0, LiveViewMath.stageIndexAt(plan.timeline, s0Time + 0.5))
            assertEquals(s1Idx to s1Time, LiveViewMath.adjacentStageTarget(plan.timeline, s0Time + 0.5, +1))
            assertEquals(s2Idx to s2Time, LiveViewMath.adjacentStageTarget(plan.timeline, s1Time + 0.5, +1))
            assertEquals(s1Idx to s1Time, LiveViewMath.adjacentStageTarget(plan.timeline, s2Time + 0.5, -1))
            assertEquals(plan.timeline.stages[0].firstEventIdx to s0Time, LiveViewMath.adjacentStageTarget(plan.timeline, s0Time + 0.5, -1))
        } finally {
            provider.close()
        }

        // 核对 /api/mobile/motions/batch 嵌套 { hash, clip } 解包
        val batchPayload = """
            {
              "templateVersion": "v1.0.0",
              "clips": {
                "squat": {
                  "hash": "h-squat",
                  "clip": { "exercises": ["squat"], "frames": 24, "dur": 2.0, "lottie": { "ip": 0, "op": 24 } }
                }
              },
              "unchanged": [],
              "missing": []
            }
        """.trimIndent()
        val batch = json.decodeFromString(MotionsBatchResponse.serializer(), batchPayload)
        assertEquals("h-squat", batch.clips["squat"]?.hash)
        assertNotNull(batch.clips["squat"]?.clip?.jsonObject?.get("lottie"))
    }
}
