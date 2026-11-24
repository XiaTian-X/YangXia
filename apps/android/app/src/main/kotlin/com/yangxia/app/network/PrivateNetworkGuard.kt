package com.yangxia.app.network

import okhttp3.Dns
import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.ConcurrentHashMap

class CleartextPublicHostException(message: String) : IOException(message)

/**
 * 架构 6.2 三层组合网络安全校验器：
 * 1. 明文 http:// 仅允许 RFC1918 私网（10/8、172.16/12、192.168/16）、回环（127/8、::1），
 *    以及用户显式开启的 Tailscale CGNAT（100.64.0.0/10）；
 * 2. 自动解包 IPv4-mapped IPv6（::ffff:x.x.x.x），防止绕过；
 * 3. DNS 解析校验全部返回 IP（任意一个公网 IP 即拒绝）并固定交付同一解析结果，根治 DNS Rebinding；
 * 4. 配合 OkHttp followSslRedirects(false) 与 addNetworkInterceptor 拦截所有公网明文跳转。
 */
object PrivateNetworkGuard {

    fun isAllowedCleartextAddress(address: InetAddress, allowTailscale: Boolean): Boolean {
        val raw = address.address
        // IPv4 (4 bytes)
        if (raw.size == 4) {
            return isAllowedIpv4Bytes(raw, allowTailscale)
        }
        // IPv6 (16 bytes)
        if (raw.size == 16) {
            // ::1 loopback
            if (address.isLoopbackAddress) return true
            // Check IPv4-mapped IPv6 ::ffff:0:0/96
            val isV4Mapped = (0 until 10).all { raw[it] == 0.toByte() } &&
                raw[10] == 0xff.toByte() &&
                raw[11] == 0xff.toByte()
            if (isV4Mapped) {
                val v4 = byteArrayOf(raw[12], raw[13], raw[14], raw[15])
                return isAllowedIpv4Bytes(v4, allowTailscale)
            }
            // IPv6 ULA fc00::/7 (private LAN IPv6) & link-local fe80::/10
            val b0 = raw[0].toInt() and 0xff
            val b1 = raw[1].toInt() and 0xff
            if ((b0 and 0xfe) == 0xfc) return true
            if (b0 == 0xfe && (b1 and 0xc0) == 0x80) return true
            return false
        }
        return false
    }

    private fun isAllowedIpv4Bytes(b: ByteArray, allowTailscale: Boolean): Boolean {
        val o0 = b[0].toInt() and 0xff
        val o1 = b[1].toInt() and 0xff
        // 127.0.0.0/8 loopback
        if (o0 == 127) return true
        // 10.0.0.0/8 RFC1918
        if (o0 == 10) return true
        // 172.16.0.0/12 RFC1918
        if (o0 == 172 && o1 in 16..31) return true
        // 192.168.0.0/16 RFC1918
        if (o0 == 192 && o1 == 168) return true
        // 100.64.0.0/10 Tailscale CGNAT (only if explicitly enabled by user)
        if (allowTailscale && o0 == 100 && o1 in 64..127) return true
        return false
    }
}

/**
 * 自定义 DNS + 双层拦截器：
 * - 发起 http:// 请求前由 SafePrivateNetAppInterceptor 调用 verifyAndPinCleartextHost 预校验所有 DNS 结果并钉选，
 *   确保底层 Socket 绝不向公网 IP 发起哪怕一次 TCP SYN；
 * - SafePrivateNetNetworkInterceptor 在真实连接建立层再次核验 Socket 目标 IP，拦截 301/302 重定向到公网明文。
 */
class SafePrivateNetDns(
    private val allowTailscale: () -> Boolean,
    private val delegate: Dns = Dns.SYSTEM,
) : Dns {

    private data class PinnedEntry(val addresses: List<InetAddress>, val expiresAtMs: Long)

    private val pinned = ConcurrentHashMap<String, PinnedEntry>()
    private val cleartextHosts = ConcurrentHashMap.newKeySet<String>()

    @Throws(UnknownHostException::class, CleartextPublicHostException::class)
    fun verifyAndPinCleartextHost(host: String): List<InetAddress> {
        val key = host.lowercase()
        cleartextHosts.add(key)
        val resolved = delegate.lookup(host)
        if (resolved.isEmpty()) throw UnknownHostException("无法解析主机：$host")
        val tailscale = allowTailscale()
        for (addr in resolved) {
            if (!PrivateNetworkGuard.isAllowedCleartextAddress(addr, tailscale)) {
                pinned.remove(key)
                throw CleartextPublicHostException(
                    "安全拦截：明文 HTTP 仅允许访问局域网/回环地址${if (tailscale) "或 Tailscale 网段" else ""}，已拒绝公网地址 ${addr.hostAddress}。如需外网访问请配置 HTTPS。",
                )
            }
        }
        pinned[key] = PinnedEntry(resolved, System.currentTimeMillis() + 5_000L)
        return resolved
    }

    override fun lookup(hostname: String): List<InetAddress> {
        val key = hostname.lowercase()
        val entry = pinned[key]
        if (entry != null && System.currentTimeMillis() <= entry.expiresAtMs) {
            return entry.addresses
        }
        pinned.remove(key)
        // 对明文主机绝不在 TTL 过期后无校验回落至 delegate.lookup，防止重试/慢连时向公网发包
        if (cleartextHosts.contains(key)) {
            return verifyAndPinCleartextHost(hostname)
        }
        return delegate.lookup(hostname)
    }
}

/** 应用层拦截器：在 TCP 建连前对明文 http:// 做全量 DNS IP 私网验证与钉选。 */
class SafePrivateNetAppInterceptor(
    private val safeDns: SafePrivateNetDns,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        if (!req.url.isHttps) {
            safeDns.verifyAndPinCleartextHost(req.url.host)
        }
        return chain.proceed(req)
    }
}

/** 网络层拦截器：覆查每一跳真实连接（含 301/302 重定向目标），确保明文 HTTP 绝不流向公网。 */
class SafePrivateNetNetworkInterceptor(
    private val allowTailscale: () -> Boolean,
    private val safeDns: SafePrivateNetDns,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        if (!req.url.isHttps) {
            val connectedIp = chain.connection()?.socket()?.inetAddress
            val tailscale = allowTailscale()
            if (connectedIp != null) {
                if (!PrivateNetworkGuard.isAllowedCleartextAddress(connectedIp, tailscale)) {
                    throw CleartextPublicHostException(
                        "安全拦截：检测到重定向至公网明文地址 ${connectedIp.hostAddress}，已中断连接。",
                    )
                }
            } else {
                safeDns.verifyAndPinCleartextHost(req.url.host)
            }
        }
        val resp = chain.proceed(req)
        // 拦截响应头中的跨公网明文重定向，异常前先关闭 Response 防止连接泄漏
        if (resp.isRedirect) {
            val loc = resp.header("Location")
            if (!loc.isNullOrBlank()) {
                val target = req.url.resolve(loc)
                if (target != null && !target.isHttps) {
                    try {
                        safeDns.verifyAndPinCleartextHost(target.host)
                    } catch (e: IOException) {
                        resp.close()
                        throw e
                    }
                }
            }
        }
        return resp
    }
}
