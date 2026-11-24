package com.yangxia.app

import com.yangxia.app.network.CleartextPublicHostException
import com.yangxia.app.network.PrivateNetworkGuard
import com.yangxia.app.network.SafePrivateNetDns
import okhttp3.Dns
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.InetAddress

class PrivateNetworkGuardTest {

    @Test
    fun allowsRfc1918AndLoopbackAndBlocksPublicIps() {
        val allowed = listOf("127.0.0.1", "10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.50", "::1")
        for (ip in allowed) {
            assertTrue("应放行私网/回环 $ip", PrivateNetworkGuard.isAllowedCleartextAddress(InetAddress.getByName(ip), false))
        }

        val blocked = listOf("8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "192.167.1.1", "100.64.0.1", "100.127.255.254", "203.0.113.5")
        for (ip in blocked) {
            assertFalse("默认应拒绝公网/未开启 Tailscale 地址 $ip", PrivateNetworkGuard.isAllowedCleartextAddress(InetAddress.getByName(ip), false))
        }
    }

    @Test
    fun tailscaleCgnatOnlyAllowedWhenExplicitlyEnabled() {
        val tsIp = InetAddress.getByName("100.100.12.34")
        val nonTsIp = InetAddress.getByName("100.128.0.1")
        assertFalse(PrivateNetworkGuard.isAllowedCleartextAddress(tsIp, allowTailscale = false))
        assertTrue(PrivateNetworkGuard.isAllowedCleartextAddress(tsIp, allowTailscale = true))
        assertFalse(PrivateNetworkGuard.isAllowedCleartextAddress(nonTsIp, allowTailscale = true))
    }

    @Test
    fun unwrapsIpv4MappedIpv6AddressesProperly() {
        // ::ffff:192.168.1.10 (bytes: 10*0x00, 0xff, 0xff, 192, 168, 1, 10)
        val mappedPrivate = InetAddress.getByAddress(
            byteArrayOf(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -1, -1, 192.toByte(), 168.toByte(), 1, 10),
        )
        val mappedPublic = InetAddress.getByAddress(
            byteArrayOf(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -1, -1, 8, 8, 8, 8),
        )
        assertTrue(PrivateNetworkGuard.isAllowedCleartextAddress(mappedPrivate, false))
        assertFalse(PrivateNetworkGuard.isAllowedCleartextAddress(mappedPublic, false))
    }

    @Test
    fun safeDnsRejectsMixedPublicAndPrivateAnswersAndPinsAgainstRebinding() {
        var callCount = 0
        val rebindingDns = object : Dns {
            override fun lookup(hostname: String): List<InetAddress> {
                callCount++
                return when (hostname) {
                    "mixed.local" -> listOf(InetAddress.getByName("192.168.1.2"), InetAddress.getByName("8.8.8.8"))
                    "rebind.local" -> if (callCount == 1) listOf(InetAddress.getByName("192.168.1.20")) else listOf(InetAddress.getByName("8.8.8.8"))
                    else -> listOf(InetAddress.getByName("127.0.0.1"))
                }
            }
        }
        val safeDns = SafePrivateNetDns(allowTailscale = { false }, delegate = rebindingDns)

        // 混合 DNS 返回含公网 IP 必须整体拒绝
        try {
            safeDns.verifyAndPinCleartextHost("mixed.local")
            fail("混合私网+公网 DNS 必须抛出 CleartextPublicHostException")
        } catch (_: CleartextPublicHostException) {
            // expected
        }

        // DNS Rebinding：首次通过后钉选，紧接着的 lookup 复用钉选私网 IP，不会回源拿公网 IP
        callCount = 0
        val pinned = safeDns.verifyAndPinCleartextHost("rebind.local")
        val lookupAfterPin = safeDns.lookup("rebind.local")
        assertTrue(lookupAfterPin.all { it.hostAddress == "192.168.1.20" })
        assertTrue(pinned == lookupAfterPin)
    }
}
