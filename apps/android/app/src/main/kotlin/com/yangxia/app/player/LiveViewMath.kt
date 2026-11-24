package com.yangxia.app.player

import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * 纯 Kotlin 60fps 零 JNI 渲染数学层（1:1 逐行复刻 packages/course-core/src/live-view.ts 与 figure-motion.ts）：
 * 跟练播放期间每帧只查内存中的 TimelineDto，绝不跨 QuickJS JNI，
 * 保障小米 6（骁龙 835）丝滑 60fps 并与 contracts/fixtures/golden-player.json 误差 < 1e-4。
 */
object LiveViewMath {

    private val STAGE_RE = Regex("^ex-(\\d+)-(prep|set|rest)(?:-(\\d+))?$")
    private val LEAD_BREATH_RE = Regex("领呼\"(吸|呼)\"")
    private val NEUTRAL_BREATH_RE = Regex("均匀|自然|别把气停住")
    private val SIDE_TAG_RE = Regex("· (左侧|右侧)")
    private val STRIP_LEAD_RE = Regex("^[^\\p{L}\\p{N}]+")
    private val SEC_DISPLAY_RE = Regex("^(\\d+)s$")
    private val INT_DISPLAY_RE = Regex("^\\d+$")
    private val REP_DISPLAY_RE = Regex("(\\d+) / (\\d+)")
    private val REP_PREFIX_RE = Regex("^第 \\d+ 次 · ")
    private val PLUS_ONE_RE = Regex("\\s*\\(\\+1\\)")

    data class StageInfo(val kind: String, val itemIndex: Int, val set: Int)

    fun parseStage(id: String): StageInfo? {
        val m = STAGE_RE.matchEntire(id) ?: return null
        return StageInfo(
            kind = m.groupValues[2],
            itemIndex = m.groupValues[1].toInt(),
            set = m.groupValues[3].toIntOrNull() ?: 0,
        )
    }

    fun breathOf(text: String): String? {
        LEAD_BREATH_RE.find(text)?.let { m ->
            return if (m.groupValues[1] == "吸") "inhale" else "exhale"
        }
        if (NEUTRAL_BREATH_RE.containsMatchIn(text)) return null
        val inh = text.contains("吸")
        val exh = text.contains("呼")
        return when {
            inh && !exh -> "inhale"
            exh && !inh -> "exhale"
            else -> null
        }
    }

    fun eventIndexAt(events: List<TimelineEventDto>, t: Double): Int {
        if (events.isEmpty()) return -1
        var lo = 0
        var hi = events.size - 1
        while (lo < hi) {
            val mid = (lo + hi + 1) ushr 1
            if (events[mid].time <= t) lo = mid else hi = mid - 1
        }
        return if (events[lo].time <= t) lo else 0
    }

    fun stageSpan(tl: TimelineDto, i: Int): Pair<Double, Double> {
        val start = tl.events.getOrNull(tl.stages[i].firstEventIdx)?.time ?: 0.0
        val next = tl.stages.getOrNull(i + 1)
        val end = if (next != null) tl.events.getOrNull(next.firstEventIdx)?.time ?: tl.totalDuration else tl.totalDuration
        return start to end
    }

    private fun stripLead(s: String): String = s.replace(STRIP_LEAD_RE, "").trim()

    private fun breathPhrase(text: String): String {
        LEAD_BREATH_RE.find(text)?.let { m ->
            return if (m.groupValues[1] == "吸") "吸气" else "呼气"
        }
        return stripLead(text)
    }

    private fun tempoSeconds(item: CourseItemDto?, label: String): String {
        val tp = item?.tempo ?: return ""
        val sec = when {
            label.contains("下放") -> tp.down
            label.contains("发力") -> tp.up
            label.contains("顶点") -> tp.top
            label.contains("底部") -> tp.bottom
            else -> null
        }
        return if (sec != null && sec > 0) "$sec 秒" else ""
    }

    private fun tempoText(item: CourseItemDto): String {
        val tp = item.tempo
        if (item.mode == "timed" || tp == null) return "${item.duration ?: ""} 秒"
        val parts = if (tp.start == "down") {
            listOfNotNull("下 ${tp.down} 秒", tp.bottom?.takeIf { it > 0 }?.let { "停 $it 秒" }, "起 ${tp.up} 秒")
        } else {
            listOfNotNull("起 ${tp.up} 秒", tp.top?.takeIf { it > 0 }?.let { "停 $it 秒" }, "下 ${tp.down} 秒")
        }
        return "${item.reps ?: ""} 次 · ${parts.joinToString("、")}"
    }

    private fun setTotalOf(tl: TimelineDto, itemIndex: Int): Int =
        tl.stages.count { s -> parseStage(s.id)?.let { it.kind == "set" && it.itemIndex == itemIndex } == true }

    private fun restSeconds(tl: TimelineDto, stageIndex: Int): Int? {
        val st = tl.stages.getOrNull(stageIndex) ?: return null
        var i = st.firstEventIdx
        while (i < tl.events.size && tl.events[i].phaseGroup == st.id) {
            SEC_DISPLAY_RE.matchEntire(tl.events[i].display)?.let { return it.groupValues[1].toInt() }
            i++
        }
        return null
    }

    fun liveFrame(course: CourseDto, tl: TimelineDto, idx: Int, t: Double): LiveFrame {
        val items = course.allItems()
        if (tl.events.isEmpty() || tl.stages.isEmpty()) {
            return LiveFrame("prep", "", "", "", "", "", 0.0, null, "", "", "", null, 0, 0, 0.0)
        }
        val ev = tl.events[idx.coerceIn(0, tl.events.lastIndex)]
        val stageIndex = tl.stages.indexOfFirst { it.id == ev.phaseGroup }.coerceAtLeast(0)
        val info = parseStage(tl.stages[stageIndex].id) ?: StageInfo("set", ev.itemIndex, 1)
        val nextOfStage = tl.stages.getOrNull(stageIndex + 1)?.let { parseStage(it.id) }
        val itemIndex = if (ev.state == "prep" && info.kind == "rest" && nextOfStage != null) nextOfStage.itemIndex else info.itemIndex
        val item = items.getOrNull(itemIndex)
        val units = course.units()
        val unit = units.getOrElse(info.itemIndex) { "组" }
        val total = setTotalOf(tl, info.itemIndex).coerceAtLeast(1)
        val head = "${itemIndex + 1} / ${items.size}"
        val side = SIDE_TAG_RE.find(ev.tag)?.groupValues?.get(1)
        val (start, end) = stageSpan(tl, stageIndex)
        val breath = breathOf(ev.breathText)
        val breathWord = when (breath) {
            "inhale" -> "吸气"
            "exhale" -> "呼气"
            else -> ""
        }

        var title = item?.name ?: ""
        var sub = ""
        var big = ""
        var small = ""
        var over = ""
        var ring = 0.0
        var phase = ""
        var phaseSec = ""

        when {
            ev.state == "rest" -> {
                val all = restSeconds(tl, stageIndex) ?: max(1, (end - start).roundToInt())
                val sec = SEC_DISPLAY_RE.matchEntire(ev.display)
                title = if (tl.stages[stageIndex].label == "换项休") "换项休息" else "${unit}间休息"
                sub = if (unit == "轮" && tl.stages[stageIndex].label == "换项休") {
                    "$head · 这一轮的${items.getOrNull(info.itemIndex)?.name ?: "动作"}做完了"
                } else {
                    "$head · 第 ${info.set} ${unit}做完了"
                }
                phase = stripLead(ev.breathText)
                if (sec != null) {
                    val leftSec = max(0.0, sec.groupValues[1].toDouble() - max(0.0, t - ev.time))
                    over = "还剩"
                    big = ceil(leftSec - 0.001).toInt().coerceAtLeast(0).toString()
                    small = "秒，共 $all 秒"
                    ring = (leftSec / all.toDouble()).coerceIn(0.0, 1.0)
                } else {
                    over = stripLead(ev.label)
                    big = if (INT_DISPLAY_RE.matches(ev.display)) ev.display else ""
                    ring = 0.0
                }
            }
            ev.state == "prep" -> {
                sub = "$head · 准备"
                title = item?.name ?: ""
                big = if (INT_DISPLAY_RE.matches(ev.display)) ev.display else ""
                over = if (big.isNotEmpty()) "" else "准备"
                phase = stripLead(ev.label)
            }
            ev.display == "左侧" || ev.display == "右侧" -> {
                sub = "$head · 第 ${info.set} / $total $unit"
                over = "换边"
                big = ev.display
                small = "不休息"
                ring = 0.0
                phase = stripLead(ev.label)
            }
            ev.isTimedMode -> {
                val done = ev.display.contains("✓")
                val leftNum = Regex("\\d+").find(ev.display)?.value?.toIntOrNull() ?: 0
                val sideText = when {
                    side != null -> " · $side"
                    done && item?.perSide == true -> " · 两侧做完"
                    else -> ""
                }
                sub = "$head · 第 ${info.set} / $total $unit$sideText"
                big = leftNum.toString()
                small = "秒"
                ring = if (done) 1.0 else (1.0 - (ev.timedProgressRatio ?: 1.0)).coerceIn(0.0, 1.0)
                phase = if (done) stripLead(ev.label) else breathPhrase(ev.breathText)
            }
            else -> {
                val m = REP_DISPLAY_RE.find(ev.display)
                val r = m?.groupValues?.get(1)?.toIntOrNull() ?: 0
                val n = m?.groupValues?.get(2)?.toIntOrNull() ?: (item?.reps ?: 0)
                sub = "$head · 第 ${info.set} / $total $unit${if (side != null) " · $side" else ""}"
                big = r.toString()
                small = "/ $n"
                ring = if (n > 0) min(1.0, r.toDouble() / n.toDouble()) else 0.0
                val lbl = stripLead(ev.label).replace(REP_PREFIX_RE, "").replace(PLUS_ONE_RE, "")
                phase = if (breathWord.isNotEmpty() && !lbl.contains(breathWord)) "$lbl · $breathWord" else lbl
                phaseSec = tempoSeconds(item, lbl)
            }
        }

        val nextStage = tl.stages.getOrNull(stageIndex + 1)
        val after = tl.stages.getOrNull(stageIndex + 2)
        val nInfo = nextStage?.let { parseStage(it.id) }
        fun describe(s: StageInfo): String =
            if (s.itemIndex == info.itemIndex) "第 ${s.set} $unit" else "下一个：${items.getOrNull(s.itemIndex)?.name ?: ""}"

        val next = when {
            ev.state == "prep" && nextOfStage != null && nextOfStage.kind == "set" && info.kind != "set" ->
                "${items.getOrNull(nextOfStage.itemIndex)?.name ?: ""} · 第 ${nextOfStage.set} ${units.getOrElse(nextOfStage.itemIndex) { "组" }}"
            nextStage == null || nInfo == null -> "最后一段，做完就练完了"
            nInfo.kind == "rest" -> {
                val (a, b) = stageSpan(tl, stageIndex + 1)
                val aInfo = after?.let { parseStage(it.id) }
                val rSec = restSeconds(tl, stageIndex + 1) ?: (b - a).roundToInt()
                val tail = when {
                    aInfo == null -> ""
                    aInfo.itemIndex == info.itemIndex -> "，然后第 ${aInfo.set} $unit"
                    else -> "，然后：${items.getOrNull(aInfo.itemIndex)?.name ?: ""}"
                }
                "休息 $rSec 秒$tail"
            }
            else -> describe(nInfo)
        }

        val nextItem = if (ev.state == "rest" && nInfo != null && nInfo.kind != "rest") {
            items.getOrNull(nInfo.itemIndex)?.let { ni ->
                LiveNextItem(
                    name = ni.name,
                    detail = tempoText(ni),
                    set = "第 ${nInfo.set} / ${setTotalOf(tl, nInfo.itemIndex).coerceAtLeast(1)} ${units.getOrElse(nInfo.itemIndex) { "组" }}",
                    itemIndex = nInfo.itemIndex,
                )
            }
        } else null

        return LiveFrame(
            mode = ev.state,
            title = title,
            sub = sub,
            big = big,
            small = small,
            over = over,
            ring = ring,
            breath = breath,
            phase = phase,
            phaseSec = phaseSec,
            next = next,
            nextItem = nextItem,
            itemIndex = itemIndex,
            stageIndex = stageIndex,
            left = max(0.0, tl.totalDuration - t),
        )
    }

    /** 1:1 复刻 packages/course-core/src/figure-motion.ts 的 spanAt + motionAt + motionProgress。 */
    fun spanAt(spans: List<MotionSpanDto>, t: Double): MotionSpanDto? {
        if (spans.isEmpty()) return null
        var lo = 0
        var hi = spans.size - 1
        while (lo <= hi) {
            val mid = (lo + hi) ushr 1
            val s = spans[mid]
            if (t < s.start) hi = mid - 1
            else if (t >= s.end) lo = mid + 1
            else return s
        }
        val last = spans.last()
        return if (t >= last.end) last else null
    }

    fun usableClip(course: CourseDto, item: CourseItemDto?, clips: Map<String, MotionClipMetaDto>): MotionClipMetaDto? {
        val fig = item?.figure
        if (course.source.plan.isNullOrBlank() || fig.isNullOrBlank()) return null
        val clip = clips[fig] ?: return null
        if (!clip.exercises.contains(item.exercise) || clip.frames <= 0) return null
        if (item.mode == "reps") {
            val p = clip.phases ?: return null
            return if (p["up"] != null && p["down"] != null && item.tempo != null) clip else null
        }
        return if (clip.loop || clip.hold != null) clip else null
    }

    fun motionAt(
        tl: TimelineDto,
        course: CourseDto,
        clips: Map<String, MotionClipMetaDto>,
        t: Double,
    ): FigureFrame? {
        val span = spanAt(tl.motion, t) ?: return null
        val item = course.allItems().getOrNull(span.itemIndex) ?: return null
        val clip = usableClip(course, item, clips) ?: return null
        val n = clip.frames.toDouble()

        fun endOf(seg: List<Double>): Double = seg[0] + seg[1]
        fun startPose(): Double =
            if (item.mode == "timed") clip.hold ?: 0.0
            else clip.phases!![item.tempo!!.start]!![0]

        fun lastPose(): Double =
            if (item.mode == "timed") clip.hold ?: 0.0
            else endOf(clip.phases!![if (item.tempo!!.start == "up") "down" else "up"]!!)

        fun phaseFrame(phase: String, progress: Double): Double {
            val p = clip.phases!!
            val seg = p[phase]
            if (seg != null) return seg[0] + seg[1] * progress
            return endOf(if (phase == "top") p["up"]!! else p["down"]!!)
        }

        val rawFrame = when (span.kind) {
            "phase" -> {
                val len = span.end - span.start
                val progress = if (len > 0.0) ((t - span.start) / len).coerceIn(0.0, 1.0) else 1.0
                phaseFrame(span.phase ?: "up", progress)
            }
            "timed" -> if (clip.loop) ((t - span.start) / clip.dur) * n else (clip.hold ?: 0.0)
            else -> if (span.pose == "start") startPose() else lastPose()
        }
        val wrapped = ((rawFrame % n) + n) % n
        val ip = clip.lottieIp
        val op = clip.lottieOp ?: n
        val lottieProgress = ((wrapped - ip) / max(1e-6, op - ip)).toFloat().coerceIn(0f, 1f)

        return FigureFrame(
            clip = item.figure!!,
            frame = wrapped,
            lottieProgress = lottieProgress,
            note = span.note,
            perSide = item.perSide,
            itemIndex = span.itemIndex,
        )
    }

    /** 架构 6.4 & settings.ts:96 安全下限：存在安全下限时换气提示音音量强制 ≥ 15。 */
    fun enforceSafetyFloor(settings: PlaybackSettingsDto, floor: String?): PlaybackSettingsDto {
        if (floor != "pluck") return settings
        return settings.copy(
            breathAfter = "pluck",
            breathVolume = max(15, settings.breathVolume),
        )
    }
}
