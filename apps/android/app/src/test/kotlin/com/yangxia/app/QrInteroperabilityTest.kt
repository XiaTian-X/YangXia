package com.yangxia.app

import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 真实跨端二维码互操作测试：
 * 用 Node 直接运行网页端 apps/web/src/lib/qr.ts 生成覆盖 Version 1–10（含中文配对 JSON）的二维码矩阵，
 * 再交由 Android 端实际使用的 com.google.zxing.qrcode.QRCodeReader 真解码核对，确保手机摄像头 100% 可扫出。
 */
class QrInteroperabilityTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun webQrEncoderDecodesCleanlyWithRealZxingAcrossVersions1To10() {
        val qrTs = listOf(
            File("../../../apps/web/src/lib/qr.ts"),
            File("../../apps/web/src/lib/qr.ts"),
            File("apps/web/src/lib/qr.ts"),
        ).firstOrNull { it.exists() } ?: error("找不到 apps/web/src/lib/qr.ts")

        val payloads = listOf(
            "hi", // V1
            "http://192.168.1.100:3000", // V2
            """{"type":"yangxia_pair","code":"0123456789abcdef0123456789abcdef"}""", // V4
            """{"type":"yangxia_pair","serverUrl":"http://127.0.0.1:3000","code":"288982eb6934073eda791f7caabeca55","profileCode":"小夏"}""", // V7/V8 (真实配对码！)
            """{"type":"yangxia_pair","serverUrl":"https://yangxia.home.example.com:8443","code":"fd25a3cffc38df4ef1ec0f82a946979b","profileCode":"爸爸65岁"}""", // V8/V9
            """{"type":"yangxia_pair","serverUrl":"https://very-long-home-nas-domain.example.org:8443/sub","code":"fd25a3cffc38df4ef1ec0f82a946979b","profileCode":"家庭测试成员代号甲乙丙丁戊己庚辛"}""", // V10
        )

        val script = """
            import { encodeQrMatrix } from ${Json.encodeToString(qrTs.canonicalPath)};
            const inputs = ${Json.encodeToString(payloads)};
            const out = inputs.map((text) => ({ text, ...encodeQrMatrix(text) }));
            process.stdout.write(JSON.stringify(out));
        """.trimIndent()

        val proc = ProcessBuilder("node", "--input-type=module", "-e", script)
            .redirectErrorStream(true)
            .start()
        val stdout = proc.inputStream.bufferedReader().readText()
        val code = proc.waitFor()
        assertEquals("node 执行 qr.ts 失败：$stdout", 0, code)

        val reader = QRCodeReader()
        val hints = mapOf(
            DecodeHintType.CHARACTER_SET to "UTF-8",
            DecodeHintType.TRY_HARDER to true,
        )

        val items = json.parseToJsonElement(stdout).jsonArray
        assertEquals(payloads.size, items.size)

        for (el in items) {
            val obj = el.jsonObject
            val expectedText = obj["text"]!!.jsonPrimitive.content
            val size = obj["size"]!!.jsonPrimitive.int
            val modules = obj["modules"]!!.jsonArray
            val quiet = 4
            val scale = 4
            val imgSize = (size + quiet * 2) * scale
            val pixels = IntArray(imgSize * imgSize) { 0xFFFFFFFF.toInt() }
            for (r in 0 until size) {
                val row = modules[r].jsonArray
                for (c in 0 until size) {
                    if (row[c].jsonPrimitive.boolean) {
                        val y0 = (r + quiet) * scale
                        val x0 = (c + quiet) * scale
                        for (dy in 0 until scale) {
                            val rowOff = (y0 + dy) * imgSize + x0
                            for (dx in 0 until scale) {
                                pixels[rowOff + dx] = 0xFF000000.toInt()
                            }
                        }
                    }
                }
            }
            val source = RGBLuminanceSource(imgSize, imgSize, pixels)
            val bitmap = BinaryBitmap(HybridBinarizer(source))
            val decoded = reader.decode(bitmap, hints)
            assertTrue("ZXing 解码结果不应为空", decoded.text.isNotEmpty())
            assertEquals("Version size=$size 解码文本必须与原 JSON 完全一致", expectedText, decoded.text)
        }
    }
}
