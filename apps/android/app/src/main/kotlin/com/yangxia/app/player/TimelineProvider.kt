package com.yangxia.app.player

import com.dokar.quickjs.QuickJs
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import java.io.Closeable
import java.util.concurrent.Executors

/**
 * 架构 6.3 可逆播放计划提供器抽象：
 * - 默认使用 QuickJsTimelineProvider（常驻单线程 QuickJS 执行 assets/player-runtime.js，零双份维护）；
 * - 保留 ServerPrecomputedTimelineProvider 零沉没成本回退预案（直消费服务端 ?withTimeline=1 预计算结果）。
 */
interface TimelineProvider {
    suspend fun buildPlayerPlan(
        courseJson: String,
        devicePrefsJson: String = "{}",
        userPatchJson: String? = null,
    ): PlayerPlanResultDto

    suspend fun computeSetsDone(
        courseJson: String,
        timelineJson: String,
        playedIndices: List<Int>,
    ): List<Int>

    suspend fun buildPlayerSessionJson(
        courseJson: String,
        timelineJson: String,
        playedIndices: List<Int>,
        startedAtIso: String,
        endedAtIso: String,
        symptoms: List<String>,
        feeling: String,
        note: String,
        edited: Boolean = false,
    ): String

    suspend fun buildSessionWithSetsDoneJson(
        courseJson: String,
        setsDone: List<Int>,
        startedAtIso: String,
        endedAtIso: String,
        symptoms: List<String>,
        feeling: String,
        note: String,
        edited: Boolean = false,
    ): String
}

/**
 * 常驻单线程 QuickJS 引擎实现：
 * - 启动载入一次 assets/player-runtime.js，全生命周期复用同一 QuickJs 实例；
 * - 仅在课程加载 / 修改设置 / 练完保存时低频调用，跟练 60fps 渲染绝不跨 JNI。
 */
@OptIn(ExperimentalSerializationApi::class)
class QuickJsTimelineProvider(
    private val runtimeJsLoader: () -> String,
    private val json: Json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    },
) : TimelineProvider, Closeable {

    private val executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "yangxia-quickjs").apply { isDaemon = true }
    }
    private val dispatcher = executor.asCoroutineDispatcher()
    private val mutex = Mutex()
    private var qjs: QuickJs? = null

    private suspend fun ensureRuntime(): QuickJs {
        val existing = qjs
        if (existing != null) return existing
        val created = QuickJs.create(dispatcher)
        created.memoryLimit = 64L * 1024L * 1024L
        created.maxStackSize = 2L * 1024L * 1024L
        val bundleJs = runtimeJsLoader()
        created.evaluate<Any?>(bundleJs, "player-runtime.js")
        // 仅转义 UTF-16 代理对（非 BMP 4 字节 Emoji 如 🗣️ / 💪），避开 JNI NewStringUTF 的 CESU-8 截断；
        // 并为 1000+ 条时间轴事件提供紧凑行打包，跳过重复的 22,000 个 JSON 键名解析，使小米 6 单课耗时降至 < 80ms
        created.evaluate<Any?>(
            """
            globalThis.__yxEscSurr = function(s) {
              return s.replace(/[\uD800-\uDFFF]/g, function(ch) {
                return "\\u" + ("0000" + ch.charCodeAt(0).toString(16)).slice(-4);
              });
            };
            globalThis.__yxToJniSafeJson = function(v) {
              return globalThis.__yxEscSurr(JSON.stringify(v));
            };
            globalThis.__yxEscCell = function(s) {
              if (!s) return "";
              var out = String(s);
              if (out.indexOf("\\") >= 0) out = out.replace(/\\/g, "\\\\");
              if (out.indexOf("\t") >= 0) out = out.replace(/\t/g, "\\t");
              if (out.indexOf("\n") >= 0) out = out.replace(/\n/g, "\\n");
              if (out.indexOf("\r") >= 0) out = out.replace(/\r/g, "\\r");
              return out;
            };
            globalThis.__yxPackPlan = function(plan) {
              var evs = plan.timeline.events;
              var rows = new Array(evs.length);
              var cache = Object.create(null);
              function esc(s) {
                if (!s) return "";
                var hit = cache[s];
                if (hit !== undefined) return hit;
                var out = String(s);
                if (/[\\\t\n\r\uD800-\uDFFF]/.test(out)) {
                  out = out.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
                  out = globalThis.__yxEscSurr(out);
                }
                cache[s] = out;
                return out;
              }
              for (var i = 0; i < evs.length; i++) {
                var e = evs[i];
                var bp = e.breathPluck ? ((e.breathPluck.direction === "inhale" ? "i" : "e") + (e.breathPluck.isRestPhase ? "1" : "0")) : "";
                var vt = e.voiceTokens ? e.voiceTokens.join("|") : "";
                var flags = (e.isLastThree ? 1 : 0)
                  | (e.isSetFinalRep ? 2 : 0)
                  | (e.isCountJumpBeat ? 4 : 0)
                  | (e.isTimedMode ? 8 : 0);
                rows[i] = e.time + "\t" + e.beatDur + "\t" + e.bpm + "\t" + e.cueType + "\t" + e.style + "\t" + e.state
                  + "\t" + esc(e.display) + "\t" + esc(e.tag) + "\t" + esc(e.label) + "\t" + esc(e.breathText)
                  + "\t" + (e.voice != null ? "1" + esc(e.voice) : "")
                  + "\t" + (e.voiceTokens != null ? "1" + esc(vt) : "")
                  + "\t" + (e.voiceVolScale != null ? e.voiceVolScale : 1)
                  + "\t" + (e.voiceOffset != null ? e.voiceOffset : 0)
                  + "\t" + bp
                  + "\t" + flags
                  + "\t" + (e.timedProgressRatio != null ? e.timedProgressRatio : "")
                  + "\t" + esc(e.phaseGroup)
                  + "\t" + (e.itemIndex | 0);
              }
              var head = globalThis.__yxToJniSafeJson({
                course: plan.course,
                effectiveSettings: plan.effectiveSettings,
                floor: plan.floor,
                units: plan.units,
                timeline: {
                  events: [],
                  stages: plan.timeline.stages,
                  totalDuration: plan.timeline.totalDuration,
                  motion: plan.timeline.motion
                }
              });
              return head + "\n" + rows.join("\n");
            };
            """.trimIndent(),
            "yx-json-helper.js",
        )
        qjs = created
        return created
    }

    /** 预热引擎并测量冷启动加载耗时（ms）。 */
    suspend fun warmup(): Long = mutex.withLock {
        withContext(dispatcher) {
            val t0 = System.nanoTime()
            ensureRuntime()
            (System.nanoTime() - t0) / 1_000_000L
        }
    }

    override suspend fun buildPlayerPlan(
        courseJson: String,
        devicePrefsJson: String,
        userPatchJson: String?,
    ): PlayerPlanResultDto = mutex.withLock {
        withContext(dispatcher) {
            val rt = ensureRuntime()
            val patchExpr = if (userPatchJson != null) "JSON.parse(${lit(userPatchJson)})" else "undefined"
            val script = """
                (function() {
                  var course = JSON.parse(${lit(courseJson)});
                  var devicePrefs = JSON.parse(${lit(devicePrefsJson)});
                  var plan = globalThis.YangXiaPlayer.buildPlayerPlan(course, devicePrefs, $patchExpr);
                  return globalThis.__yxPackPlan(plan);
                })()
            """.trimIndent()
            val packed = rt.evaluate<String>(script)
            unpackPlan(packed)
        }
    }

    private fun unpackPlan(packed: String): PlayerPlanResultDto {
        val firstNl = packed.indexOf('\n')
        if (firstNl < 0) {
            return json.decodeFromString(PlayerPlanResultDto.serializer(), packed)
        }
        val headJson = packed.substring(0, firstNl)
        val head = json.decodeFromString(PlayerPlanResultDto.serializer(), headJson)
        val events = ArrayList<TimelineEventDto>(1024)
        val cols = Array(19) { "" }
        var pos = firstNl + 1
        val len = packed.length
        while (pos < len) {
            var end = packed.indexOf('\n', pos)
            if (end < 0) end = len
            if (end > pos) {
                events.add(parseEventRow(packed, pos, end, cols))
            }
            pos = end + 1
        }
        return head.copy(timeline = head.timeline.copy(events = events))
    }

    private fun parseEventRow(src: String, start: Int, end: Int, cols: Array<String>): TimelineEventDto {
        cols.fill("")
        var col = 0
        var cStart = start
        var i = start
        while (i < end && col < 18) {
            if (src[i] == '\t') {
                cols[col++] = src.substring(cStart, i)
                cStart = i + 1
            }
            i++
        }
        cols[col] = src.substring(cStart, end)

        val voiceRaw = cols[10]
        val voice = if (voiceRaw.startsWith("1")) unescapeCell(voiceRaw.substring(1)) else null
        val tokensRaw = cols[11]
        val voiceTokens = if (tokensRaw.startsWith("1")) {
            val body = unescapeCell(tokensRaw.substring(1))
            if (body.isEmpty()) emptyList() else body.split('|')
        } else {
            null
        }
        val bpRaw = cols[14]
        val breathPluck = if (bpRaw.length == 2) {
            BreathPluckDto(
                direction = if (bpRaw[0] == 'i') "inhale" else "exhale",
                isRestPhase = bpRaw[1] == '1',
            )
        } else {
            null
        }
        val flags = cols[15].toIntOrNull() ?: 0
        val ratioRaw = cols[16]
        return TimelineEventDto(
            time = cols[0].toDouble(),
            beatDur = cols[1].toDouble(),
            bpm = cols[2].toInt(),
            cueType = cols[3],
            style = cols[4],
            state = cols[5],
            display = unescapeCell(cols[6]),
            tag = unescapeCell(cols[7]),
            label = unescapeCell(cols[8]),
            breathText = unescapeCell(cols[9]),
            srtText = null,
            voice = voice,
            voiceTokens = voiceTokens,
            voiceVolScale = cols[12].toDoubleOrNull() ?: 1.0,
            voiceOffset = cols[13].toDoubleOrNull() ?: 0.0,
            breathPluck = breathPluck,
            isLastThree = (flags and 1) != 0,
            isSetFinalRep = (flags and 2) != 0,
            isCountJumpBeat = (flags and 4) != 0,
            isTimedMode = (flags and 8) != 0,
            timedProgressRatio = if (ratioRaw.isEmpty()) null else ratioRaw.toDoubleOrNull(),
            phaseGroup = unescapeCell(cols[17]),
            itemIndex = cols[18].toIntOrNull() ?: 0,
        )
    }

    private fun unescapeCell(s: String): String {
        if (s.indexOf('\\') < 0) return s
        val sb = StringBuilder(s.length)
        var i = 0
        while (i < s.length) {
            val ch = s[i]
            if (ch == '\\' && i + 1 < s.length) {
                when (s[i + 1]) {
                    '\\' -> { sb.append('\\'); i += 2 }
                    't' -> { sb.append('\t'); i += 2 }
                    'n' -> { sb.append('\n'); i += 2 }
                    'r' -> { sb.append('\r'); i += 2 }
                    'u' -> {
                        if (i + 5 < s.length) {
                            val code = s.substring(i + 2, i + 6).toIntOrNull(16)
                            if (code != null) {
                                sb.append(code.toChar())
                                i += 6
                                continue
                            }
                        }
                        sb.append(ch)
                        i++
                    }
                    else -> { sb.append(ch); i++ }
                }
            } else {
                sb.append(ch)
                i++
            }
        }
        return sb.toString()
    }

    override suspend fun computeSetsDone(
        courseJson: String,
        timelineJson: String,
        playedIndices: List<Int>,
    ): List<Int> = mutex.withLock {
        withContext(dispatcher) {
            val rt = ensureRuntime()
            val course = json.decodeFromString(CourseDto.serializer(), courseJson)
            val idxJson = json.encodeToString(playedIndices)
            val script = """
                (function() {
                  var tl = JSON.parse(${lit(timelineJson)});
                  var played = JSON.parse(${lit(idxJson)});
                  var map = globalThis.YangXiaPlayer.setsDoneFromPlayed(tl.events, played);
                  return JSON.stringify(map);
                })()
            """.trimIndent()
            val rawMap = rt.evaluate<String>(script)
            val map: Map<String, Int> = json.decodeFromString(rawMap)
            course.allItems().indices.map { i -> map[i.toString()] ?: 0 }
        }
    }

    override suspend fun buildPlayerSessionJson(
        courseJson: String,
        timelineJson: String,
        playedIndices: List<Int>,
        startedAtIso: String,
        endedAtIso: String,
        symptoms: List<String>,
        feeling: String,
        note: String,
        edited: Boolean,
    ): String = mutex.withLock {
        withContext(dispatcher) {
            val rt = ensureRuntime()
            val idxJson = json.encodeToString(playedIndices)
            val pain = symptoms.contains("疼痛")
            val dizzy = symptoms.contains("头晕")
            val chest = symptoms.contains("胸闷")
            val script = """
                (function() {
                  var course = JSON.parse(${lit(courseJson)});
                  var tl = JSON.parse(${lit(timelineJson)});
                  var played = JSON.parse(${lit(idxJson)});
                  var sess = globalThis.YangXiaPlayer.buildPlayerSession(course, tl, played, {
                    startedAt: ${lit(startedAtIso)},
                    endedAt: ${lit(endedAtIso)},
                    symptoms: { pain: $pain, dizzy: $dizzy, chest: $chest },
                    feeling: ${lit(feeling)},
                    edited: $edited,
                    note: ${lit(note)}
                  });
                  return globalThis.__yxToJniSafeJson(sess);
                })()
            """.trimIndent()
            rt.evaluate<String>(script)
        }
    }

    override suspend fun buildSessionWithSetsDoneJson(
        courseJson: String,
        setsDone: List<Int>,
        startedAtIso: String,
        endedAtIso: String,
        symptoms: List<String>,
        feeling: String,
        note: String,
        edited: Boolean,
    ): String = mutex.withLock {
        withContext(dispatcher) {
            val rt = ensureRuntime()
            val setsMapJson = json.encodeToString(setsDone.mapIndexed { i, v -> i.toString() to v }.toMap())
            val pain = symptoms.contains("疼痛")
            val dizzy = symptoms.contains("头晕")
            val chest = symptoms.contains("胸闷")
            val script = """
                (function() {
                  var course = JSON.parse(${lit(courseJson)});
                  var sets = JSON.parse(${lit(setsMapJson)});
                  var sess = globalThis.YangXiaPlayer.buildSession(course, {
                    startedAt: new Date(${lit(startedAtIso)}),
                    endedAt: new Date(${lit(endedAtIso)}),
                    setsDone: sets,
                    symptoms: { pain: $pain, dizzy: $dizzy, chest: $chest },
                    feeling: ${lit(feeling)},
                    edited: $edited,
                    note: ${lit(note)}
                  });
                  return globalThis.__yxToJniSafeJson(sess);
                })()
            """.trimIndent()
            rt.evaluate<String>(script)
        }
    }

    /** 仅限测试使用的受控 JS 评估入口。 */
    internal suspend fun evalRawJson(jsExpression: String): String = mutex.withLock {
        withContext(dispatcher) {
            val rt = ensureRuntime()
            rt.evaluate<String>(jsExpression)
        }
    }

    override fun close() {
        runCatching { qjs?.close() }
        qjs = null
        executor.shutdown()
    }

    companion object {
        /** 仅转义 UTF-16 代理对，避免输入方向 Emoji 触发 JNI Modified UTF-8 异常，同时保持中文原生速度。 */
        fun lit(s: String): String {
            val encoded = Json.encodeToString(s)
            var hasSurrogate = false
            for (ch in encoded) {
                if (ch.isSurrogate()) {
                    hasSurrogate = true
                    break
                }
            }
            if (!hasSurrogate) return encoded
            val sb = StringBuilder(encoded.length + 32)
            for (ch in encoded) {
                if (ch.isSurrogate()) sb.append("\\u").append(ch.code.toString(16).padStart(4, '0'))
                else sb.append(ch)
            }
            return sb.toString()
        }
    }
}

/** 架构 6.3 可逆回退实现：直接消费服务端 GET /api/mobile/courses/:id?withTimeline=1 预计算结果。 */
@OptIn(ExperimentalSerializationApi::class)
class ServerPrecomputedTimelineProvider(
    private val precomputedPlanProvider: () -> PlayerPlanResultDto?,
    private val json: Json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    },
) : TimelineProvider {

    override suspend fun buildPlayerPlan(
        courseJson: String,
        devicePrefsJson: String,
        userPatchJson: String?,
    ): PlayerPlanResultDto {
        return precomputedPlanProvider()
            ?: error("缺少服务端预计算时间轴，请联网刷新课程或切回本地 QuickJS 引擎")
    }

    override suspend fun computeSetsDone(
        courseJson: String,
        timelineJson: String,
        playedIndices: List<Int>,
    ): List<Int> {
        val course = json.decodeFromString(CourseDto.serializer(), courseJson)
        val tl = json.decodeFromString(TimelineDto.serializer(), timelineJson)
        val playedSet = playedIndices.toSet()
        val counts = IntArray(course.allItems().size)
        for (i in playedSet) {
            val ev = tl.events.getOrNull(i) ?: continue
            if (ev.isSetFinalRep && ev.cueType == "rep" && ev.itemIndex in counts.indices) counts[ev.itemIndex]++
        }
        return counts.toList()
    }

    override suspend fun buildPlayerSessionJson(
        courseJson: String,
        timelineJson: String,
        playedIndices: List<Int>,
        startedAtIso: String,
        endedAtIso: String,
        symptoms: List<String>,
        feeling: String,
        note: String,
        edited: Boolean,
    ): String {
        val setsDone = computeSetsDone(courseJson, timelineJson, playedIndices)
        return buildSessionWithSetsDoneJson(
            courseJson = courseJson,
            setsDone = setsDone,
            startedAtIso = startedAtIso,
            endedAtIso = endedAtIso,
            symptoms = symptoms,
            feeling = feeling,
            note = note,
            edited = edited,
        )
    }

    override suspend fun buildSessionWithSetsDoneJson(
        courseJson: String,
        setsDone: List<Int>,
        startedAtIso: String,
        endedAtIso: String,
        symptoms: List<String>,
        feeling: String,
        note: String,
        edited: Boolean,
    ): String {
        val course = json.decodeFromString(CourseDto.serializer(), courseJson)
        val plannedList = course.plannedPerItem()
        val itemsJson = course.allItems().mapIndexed { idx, item ->
            val planned = plannedList.getOrElse(idx) { 1 to "组" }.first
            val done = minOf(planned, setsDone.getOrElse(idx) { 0 })
            """{"exercise":${Json.encodeToString(item.exercise)},"setsPlanned":$planned,"setsDone":$done,"skipped":${done == 0}}"""
        }.joinToString(",")
        val pain = symptoms.contains("疼痛")
        val dizzy = symptoms.contains("头晕")
        val chest = symptoms.contains("胸闷")
        val editedField = if (edited) ""","edited":true""" else ""
        val trimmedNote = truncateCodePoints(note.trim(), 500)
        val noteField = if (trimmedNote.isNotEmpty()) ""","note":${Json.encodeToString(trimmedNote)}""" else ""
        val schemaId = "yangxia." + "session/1"
        return """{"schema":${Json.encodeToString(schemaId)},"course":{"id":${Json.encodeToString(course.id)},"name":${Json.encodeToString(course.name)},"source":${json.encodeToString(CourseSourceDto.serializer(), course.source)}},"startedAt":${Json.encodeToString(startedAtIso)},"endedAt":${Json.encodeToString(endedAtIso)},"items":[$itemsJson],"feeling":${Json.encodeToString(feeling)},"symptoms":{"pain":$pain,"dizzy":$dizzy,"chest":$chest}$editedField$noteField}"""
    }

    private fun truncateCodePoints(input: String, maxCodePoints: Int): String {
        val total = input.codePointCount(0, input.length)
        if (total <= maxCodePoints) return input
        val endOffset = input.offsetByCodePoints(0, maxCodePoints)
        return input.substring(0, endOffset)
    }
}
