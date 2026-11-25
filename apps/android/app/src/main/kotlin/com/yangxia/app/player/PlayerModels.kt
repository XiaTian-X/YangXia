package com.yangxia.app.player

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

@Serializable
data class TempoDto(
    val start: String = "down", // "down" | "up"
    val down: Int = 2,
    val up: Int = 1,
    val top: Int? = null,
    val bottom: Int? = null,
)

@Serializable
data class CourseSourceDto(
    val product: String = "",
    val templates: String? = null,
    val week: Int = 1,
    val day: String? = null,
    val plan: String? = null,
    val segment: Int? = null,
    val type: String? = null,
    val phase: String? = null,
    val picks: Map<String, String>? = null,
    val half: Boolean? = null,
)

@Serializable
data class CourseItemDto(
    val exercise: String = "",
    val name: String = "",
    val mode: String = "reps", // "reps" | "timed"
    val sets: Int? = null,
    val reps: Int? = null,
    val duration: Int? = null,
    val rest: Int = 60,
    val perSide: Boolean = false,
    val tempo: TempoDto? = null,
    val figure: String? = null,
    val note: String? = null,
    val quote: List<String> = emptyList(),
)

@Serializable
data class CourseBlockDto(
    val kind: String = "sets", // "sets" | "circuit"
    val rounds: Int? = null,
    val restBetweenRounds: Int? = null,
    val items: List<CourseItemDto> = emptyList(),
)

@Serializable
data class CoachingDto(
    val floor: String? = null, // "pluck" | null
    val prefs: JsonObject? = null,
)

@Serializable
data class CourseDto(
    val schema: String = "yangxia.course/1",
    val id: String = "",
    val name: String = "",
    val age: String = "a18",
    val source: CourseSourceDto = CourseSourceDto(),
    val coaching: CoachingDto? = null,
    val presentation: JsonObject? = null,
    val blocks: List<CourseBlockDto> = emptyList(),
) {
    fun allItems(): List<CourseItemDto> = blocks.flatMap { it.items }
    fun units(): List<String> = blocks.flatMap { b -> b.items.map { if (b.kind == "circuit") "轮" else "组" } }
    fun plannedPerItem(): List<Pair<Int, String>> = blocks.flatMap { b ->
        b.items.map { it ->
            if (b.kind == "circuit") (b.rounds ?: 1) to "轮" else (it.sets ?: 1) to "组"
        }
    }
}

@Serializable
data class PlaybackSettingsDto(
    val bpm: Int = 60,
    val sound: String = "woodblock",
    val voiceEngine: String = "tts",
    val voiceTimbre: String = "female",
    val music: String = "none",
    val musicVolume: Int = 0,
    val voiceVolume: Int = 92,
    val soundVolume: Int = 70,
    val breathVolume: Int = 65,
    val breathLead: JsonElement? = null,
    val breathAfter: String = "pluck",
    val countTiming: String = "on-up",
    val vibrate: Boolean = true,
)

@Serializable
data class BreathPluckDto(
    val direction: String, // "inhale" | "exhale"
    val isRestPhase: Boolean = false,
)

@Serializable
data class RepDto(val n: Int = 0, val of: Int = 0)

/**
 * 跟练画面用的结构化字段（核心库 timeline.ts 的 EventView）：吸呼、左右侧、数到第几、倒数几秒都读这里，
 * 不从显示文字（display、label、breathText、tag）里解析。
 */
@Serializable
data class EventViewDto(
    val breath: String? = null, // "inhale" | "exhale" | null
    val lead: Boolean = false,
    val tempo: String? = null, // "down" | "up" | "top" | "bottom" | null
    val rep: RepDto? = null,
    val secLeft: Int? = null,
    val restTotal: Int? = null,
    val count: Int? = null,
    val side: String? = null, // "左侧" | "右侧" | null
    val sideSwitch: Boolean = false,
    val done: Boolean = false,
)

@Serializable
data class TimelineEventDto(
    val time: Double = 0.0,
    val beatDur: Double = 1.0,
    val bpm: Int = 60,
    val cueType: String = "none",
    val style: String = "bell",
    val state: String = "prep", // "prep" | "action" | "rest"
    val display: String = "",
    val tag: String = "",
    val label: String = "",
    val breathText: String = "",
    val srtText: String? = null,
    val voice: String? = null,
    val voiceTokens: List<String>? = null,
    val voiceVolScale: Double = 1.0,
    val voiceOffset: Double = 0.0,
    val breathPluck: BreathPluckDto? = null,
    val isLastThree: Boolean = false,
    val isSetFinalRep: Boolean = false,
    val isCountJumpBeat: Boolean = false,
    val isTimedMode: Boolean = false,
    val timedProgressRatio: Double? = null,
    val phaseGroup: String = "",
    val itemIndex: Int = 0,
    val view: EventViewDto = EventViewDto(),
)

@Serializable
data class StageDto(
    val id: String,
    val label: String,
    val isRest: Boolean = false,
    val firstEventIdx: Int = 0,
)

@Serializable
data class MotionSpanDto(
    val itemIndex: Int,
    val start: Double,
    val end: Double,
    val note: String = "doing",
    val kind: String = "pose", // "phase" | "timed" | "pose"
    val phase: String? = null, // "up" | "down" | "top" | "bottom"
    val pose: String? = null, // "start" | "last"
)

@Serializable
data class TimelineDto(
    val events: List<TimelineEventDto> = emptyList(),
    val stages: List<StageDto> = emptyList(),
    val totalDuration: Double = 0.0,
    val motion: List<MotionSpanDto> = emptyList(),
)

@Serializable
data class PlayerPlanResultDto(
    val course: CourseDto,
    val effectiveSettings: PlaybackSettingsDto,
    val floor: String? = null, // "pluck" | null
    val timeline: TimelineDto,
    val units: List<String> = emptyList(),
)

@Serializable
data class MotionClipMetaDto(
    val exercises: List<String> = emptyList(),
    val frames: Int = 1,
    val dur: Double = 1.0,
    val w: Int = 200,
    val h: Int = 200,
    val phases: Map<String, List<Double>>? = null,
    val hold: Double? = null,
    val loop: Boolean = false,
    val lottieIp: Double = 0.0,
    val lottieOp: Double? = null,
)

data class LiveNextItem(
    val name: String,
    val detail: String,
    val set: String,
    val itemIndex: Int,
)

data class LiveFrame(
    val mode: String, // "prep" | "action" | "rest"
    val title: String,
    val sub: String,
    val big: String,
    val small: String,
    val over: String,
    val ring: Double,
    val breath: String?, // "inhale" | "exhale" | null
    val phase: String,
    val phaseSec: String,
    val next: String,
    val nextItem: LiveNextItem?,
    val itemIndex: Int,
    val stageIndex: Int,
    val left: Double,
)

data class FigureFrame(
    val clip: String,
    val frame: Double,
    val lottieProgress: Float,
    val note: String,
    val perSide: Boolean,
    val itemIndex: Int,
)

/**
 * 练前确认（核心库 PreSessionCheck）：
 * - kind = "fall"：65 岁以上每次问；答"有"不开练，照 stop 做；
 * - kind = "condition"：训练单"每次练之前确认"的条件；recorded 是档案记的（null 没确认），不一样时照 hint 换做法。
 */
@Serializable
data class PreSessionCheckDto(
    val kind: String = "condition",
    val ask: String = "",
    val stop: String? = null,
    val condition: String? = null,
    val recorded: Boolean? = null,
    val hint: String? = null,
)

@Serializable
data class DeliveryEnvelopeDto(
    val schema: String = "yangxia.delivery/1",
    val declaration: String = "未经专业审核，不是医学建议，不能替代医生的判断",
    val profileId: String = "",
    val profileCode: String = "",
    val segment: Int = 1,
    val week: Int = 1,
    val day: String = "",
    val half: Boolean = false,
    val templateVersion: String = "",
    val templateHash: String = "",
    val snapshotHash: String = "",
    val course: CourseDto,
    val follow: List<JsonElement> = emptyList(),
    val notes: List<JsonElement> = emptyList(),
    val checks: List<PreSessionCheckDto> = emptyList(),
    /** 服务端照本人播放偏好排出的时间轴总长（分钟，向上取整）；没有就不写时长。 */
    val minutes: Int? = null,
    val motionHashes: Map<String, String> = emptyMap(),
) {
    fun followLines(): List<String> = follow.mapNotNull(::formatNoteElement)
    fun noteLines(): List<String> = notes.mapNotNull(::formatNoteElement)

    /** 照成品做的项：名字和原因分开（名字连成一行，原因去重后逐条写）。 */
    fun followItems(): List<Pair<String, String>> = follow.mapNotNull { el ->
        when (el) {
            is JsonPrimitive -> el.content.takeIf { it.isNotBlank() }?.let { it to "" }
            is JsonObject -> {
                val name = el["name"]?.jsonPrimitive?.content.orEmpty()
                val reason = el["reason"]?.jsonPrimitive?.content.orEmpty()
                if (name.isBlank() && reason.isBlank()) null else name to reason
            }
            else -> null
        }
    }

    companion object {
        private fun formatNoteElement(el: JsonElement): String? = when (el) {
            is JsonPrimitive -> el.content.takeIf { it.isNotBlank() }
            is JsonObject -> {
                val name = el["name"]?.jsonPrimitive?.content ?: el["label"]?.jsonPrimitive?.content ?: ""
                val reason = el["reason"]?.jsonPrimitive?.content ?: el["text"]?.jsonPrimitive?.content ?: el["detail"]?.jsonPrimitive?.content ?: ""
                listOf(name, reason).filter { it.isNotBlank() }.joinToString("：").ifBlank { null }
            }
            else -> null
        }
    }
}
