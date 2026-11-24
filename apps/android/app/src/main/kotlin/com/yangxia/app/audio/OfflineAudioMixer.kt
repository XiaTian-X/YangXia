package com.yangxia.app.audio

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * 纯 Kotlin 离线音频平滑拼接与高 BPM 变速器（架构 6.4，可直接在 JVM 单元测试验证）：
 * - 对齐 apps/sequencer/src/audio/voice-bank.ts:67 的 12ms 余弦交叉淡化（crossfadeConcatFloat32）；
 * - 当课程 BPM > 76 时按 tempoScale = max(0.78, 76.0 / bpm) 计算播放采样率倍率（sampleRate / tempoScale）；
 * - 零外部音频解码器依赖，输入为 22.05kHz 16-bit mono PCM ShortArray。
 */
object OfflineAudioMixer {

    const val DEFAULT_SAMPLE_RATE = 22050
    const val DEFAULT_OVERLAP_MS = 12.0

    fun tempoScaleForBpm(bpm: Int): Double =
        if (bpm > 76) max(0.78, 76.0 / bpm.toDouble()) else 1.0

    fun playbackSampleRateForBpm(baseSampleRate: Int, bpm: Int): Int {
        val scale = tempoScaleForBpm(bpm)
        return (baseSampleRate.toDouble() / scale).roundToInt().coerceIn(8000, 48000)
    }

    /**
     * 使用余弦交叉淡化（Raised Cosine Crossfade）拼接多段 PCM 词元：
     * 每一处衔接重叠 overlapSamples（默认 12ms @ 22050Hz = 264 采样点），杜绝拼接爆音。
     */
    fun crossfadeConcat(
        segments: List<ShortArray>,
        sampleRate: Int = DEFAULT_SAMPLE_RATE,
        overlapMs: Double = DEFAULT_OVERLAP_MS,
    ): ShortArray {
        val nonEmpty = segments.filter { it.isNotEmpty() }
        if (nonEmpty.isEmpty()) return ShortArray(0)
        if (nonEmpty.size == 1) return nonEmpty[0].copyOf()

        val targetOverlap = max(0, ((overlapMs / 1000.0) * sampleRate).roundToInt())
        var out = nonEmpty[0]
        for (idx in 1 until nonEmpty.size) {
            val next = nonEmpty[idx]
            val ov = min(targetOverlap, min(out.size, next.size) / 2)
            val merged = ShortArray(out.size + next.size - ov)
            // 前段未重叠部分
            System.arraycopy(out, 0, merged, 0, out.size - ov)
            // 重叠区：前半段余弦淡出 + 后半段余弦淡入
            val outStart = out.size - ov
            for (i in 0 until ov) {
                val frac = (i + 0.5) / ov.toDouble()
                val fadeOut = 0.5 * (1.0 + cos(PI * frac))
                val fadeIn = 1.0 - fadeOut
                val mixed = out[outStart + i] * fadeOut + next[i] * fadeIn
                merged[outStart + i] = mixed.roundToInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
            }
            // 后段未重叠部分
            System.arraycopy(next, ov, merged, out.size, next.size - ov)
            out = merged
        }
        return out
    }

    /** 将小端序 16-bit PCM 字节切片解码为 ShortArray。 */
    fun decodeLittleEndianPcm16(bytes: ByteArray, offsetSamples: Int, lengthSamples: Int): ShortArray {
        val out = ShortArray(lengthSamples)
        var bytePos = offsetSamples * 2
        for (i in 0 until lengthSamples) {
            val lo = bytes[bytePos].toInt() and 0xff
            val hi = bytes[bytePos + 1].toInt()
            out[i] = ((hi shl 8) or lo).toShort()
            bytePos += 2
        }
        return out
    }
}
