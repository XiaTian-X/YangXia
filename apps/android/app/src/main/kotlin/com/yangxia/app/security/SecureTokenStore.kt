package com.yangxia.app.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class AuthCredentials(
    val serverUrl: String,
    val token: String,
    val sessionKind: String,
    val boundProfileId: String?,
    val boundProfileCode: String?,
    val username: String?,
)

/**
 * 基于 Android Keystore (AES-256-GCM) 的敏感凭据本地加密存储：
 * 适配 API 26–35（含小米 6 LineageOS Android 15），零废弃库依赖，不随系统备份外泄。
 */
class SecureTokenStore(context: Context) {

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private fun getOrCreateSecretKey(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
        val existing = ks.getKey(KEY_ALIAS, null) as? SecretKey
        if (existing != null) return existing
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER)
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        gen.init(spec)
        return gen.generateKey()
    }

    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateSecretKey())
        val iv = cipher.iv
        val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP)
    }

    private fun decrypt(blob: String): String? = runCatching {
        val parts = blob.split(":")
        if (parts.size != 2) return null
        val iv = Base64.decode(parts[0], Base64.NO_WRAP)
        val ct = Base64.decode(parts[1], Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateSecretKey(), GCMParameterSpec(128, iv))
        String(cipher.doFinal(ct), Charsets.UTF_8)
    }.getOrNull()

    fun saveServerUrl(url: String) {
        prefs.edit().putString(KEY_SERVER_URL, url.trim().trimEnd('/')).apply()
    }

    fun getServerUrl(): String = prefs.getString(KEY_SERVER_URL, "")?.trim().orEmpty()

    fun setAllowTailscaleCleartext(allow: Boolean) {
        prefs.edit().putBoolean(KEY_ALLOW_TAILSCALE, allow).apply()
    }

    fun isAllowTailscaleCleartext(): Boolean = prefs.getBoolean(KEY_ALLOW_TAILSCALE, false)

    fun saveCredentials(creds: AuthCredentials) {
        prefs.edit()
            .putString(KEY_SERVER_URL, creds.serverUrl.trim().trimEnd('/'))
            .putString(KEY_TOKEN_ENC, encrypt(creds.token))
            .putString(KEY_SESSION_KIND, creds.sessionKind)
            .putString(KEY_BOUND_PROFILE_ID, creds.boundProfileId)
            .putString(KEY_BOUND_PROFILE_CODE, creds.boundProfileCode)
            .putString(KEY_USERNAME, creds.username)
            .apply()
    }

    fun loadCredentials(): AuthCredentials? {
        val serverUrl = getServerUrl()
        val tokenEnc = prefs.getString(KEY_TOKEN_ENC, null) ?: return null
        val token = decrypt(tokenEnc) ?: return null
        if (serverUrl.isBlank() || token.isBlank()) return null
        return AuthCredentials(
            serverUrl = serverUrl,
            token = token,
            sessionKind = prefs.getString(KEY_SESSION_KIND, "mobile_account") ?: "mobile_account",
            boundProfileId = prefs.getString(KEY_BOUND_PROFILE_ID, null),
            boundProfileCode = prefs.getString(KEY_BOUND_PROFILE_CODE, null),
            username = prefs.getString(KEY_USERNAME, null),
        )
    }

    fun clearToken() {
        prefs.edit()
            .remove(KEY_TOKEN_ENC)
            .remove(KEY_SESSION_KIND)
            .remove(KEY_BOUND_PROFILE_ID)
            .remove(KEY_BOUND_PROFILE_CODE)
            .remove(KEY_USERNAME)
            .apply()
    }

    companion object {
        private const val PREFS_NAME = "yangxia_secure_prefs"
        private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        private const val KEY_ALIAS = "yangxia_auth_token_aes_gcm_v1"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_ALLOW_TAILSCALE = "allow_tailscale_cleartext"
        private const val KEY_TOKEN_ENC = "token_enc"
        private const val KEY_SESSION_KIND = "session_kind"
        private const val KEY_BOUND_PROFILE_ID = "bound_profile_id"
        private const val KEY_BOUND_PROFILE_CODE = "bound_profile_code"
        private const val KEY_USERNAME = "username"
    }
}
