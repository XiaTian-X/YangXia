package com.yangxia.app

import com.yangxia.app.player.DeliveryEnvelopeDto
import com.yangxia.app.player.PreSessionCheckDto
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** "今天"页练前确认：什么回答下不能照这节课开练（摔倒答"有"；档案记的是不保守的一边、当天答成保守的一边）。 */
class PreSessionCheckTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun fallCheckBlocksOnlyWhenAnsweredYes() {
        val c = PreSessionCheckDto(kind = "fall", ask = "上次练完以后，有没有摔倒、差点摔倒、头晕", stop = "今天先不跟练")
        assertTrue(c.blocks(true))
        assertFalse(c.blocks(false))
        assertFalse(c.blocks(null))
    }

    @Test
    fun conditionBlocksOnlyWhenCourseWasBuiltForTheLessCautiousSide() {
        // 家里没有别人：没确认时按"是"（保守）。档案记"否"（有人在）→ 课是照有人在排的；当天答"是"（只有自己）就不能照它练
        val recordedNo = PreSessionCheckDto(kind = "condition", condition = "家里没有别人", ask = "训练的时候，是不是家里只有你一个人", recorded = false, conservative = true)
        assertTrue(recordedNo.blocks(true))
        assertFalse(recordedNo.blocks(false))
        assertFalse(recordedNo.blocks(null))
        // 档案没确认：课已经是保守版，当天怎么答都能练
        val unconfirmed = recordedNo.copy(recorded = null)
        assertFalse(unconfirmed.blocks(true))
        assertFalse(unconfirmed.blocks(false))
        // 档案记的就是保守的一边：课是保守版，当天答成另一边也能练
        assertFalse(recordedNo.copy(recorded = true).blocks(false))
        // 家长在旁边：没确认时按"否"（保守）。档案记"是"、当天答"否"就不能练
        val parent = PreSessionCheckDto(kind = "condition", condition = "家长在旁边", ask = "做桌下划船时，家长能不能在旁边压住桌子", recorded = true, conservative = false)
        assertTrue(parent.blocks(false))
        assertFalse(parent.blocks(true))
        // 旧信封没带 conservative：不拦，只提示
        assertFalse(recordedNo.copy(conservative = null).blocks(true))
    }

    @Test
    fun fallFallbackUsesTheSameWordsAsCore() {
        // 和核心库 engine.ts 的 FALL_CHECK 同一句（旧课兜底）；Gradle test 工作目录在 apps/android/app
        val engine = listOf(
            File("../../../packages/course-core/src/engine.ts"),
            File("../../packages/course-core/src/engine.ts"),
            File("packages/course-core/src/engine.ts"),
        ).first { it.exists() }
        val src = engine.readText()
        assertTrue("兜底的问句要和核心库一致", src.contains("ask: \"${PreSessionCheckDto.FALL_FALLBACK.ask}\""))
        assertTrue("兜底的做法要和核心库一致", src.contains("stop: \"${PreSessionCheckDto.FALL_FALLBACK.stop}\""))
    }

    @Test
    fun envelopeChecksParseFromServerJson() {
        val env = json.decodeFromString(
            DeliveryEnvelopeDto.serializer(),
            """{"course":{"id":"c","name":"n"},"checks":[{"kind":"fall","ask":"a","stop":"s"},{"kind":"condition","condition":"家里没有别人","ask":"q","recorded":false,"conservative":true,"hint":"h","stop":"x"}],"minutes":8}""",
        )
        assertEquals(2, env.checks.size)
        assertEquals(true, env.checks[1].conservative)
        assertEquals(8, env.minutes)
        assertTrue(env.checks[1].blocks(true))
    }
}
