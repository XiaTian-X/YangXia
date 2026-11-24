package com.yangxia.app.storage

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.yangXiaDataStore by preferencesDataStore(name = "yangxia_device_prefs")

data class DevicePrefs(
    val activeProfileId: String = "",
    val voiceVol: Int = 92,
    val cueVol: Int = 70,
    val breathVol: Int = 60,
    val soundStyle: String = "woodblock",
    val forceOfflineVoice: Boolean = false,
    val vibrate: Boolean = true,
    val useServerPrecomputed: Boolean = false,
)

/** 设备级偏好存储（仅留本机，不上传服务端；安全下限永远优先于设备偏好）。 */
class DevicePrefsStore(private val context: Context) {

    val prefsFlow: Flow<DevicePrefs> = context.yangXiaDataStore.data.map { p ->
        DevicePrefs(
            activeProfileId = p[KEY_ACTIVE_PROFILE] ?: "",
            voiceVol = p[KEY_VOICE_VOL] ?: 92,
            cueVol = p[KEY_CUE_VOL] ?: 70,
            breathVol = p[KEY_BREATH_VOL] ?: 60,
            soundStyle = p[KEY_SOUND_STYLE] ?: "woodblock",
            forceOfflineVoice = p[KEY_FORCE_OFFLINE_VOICE] ?: false,
            vibrate = p[KEY_VIBRATE] ?: true,
            useServerPrecomputed = p[KEY_USE_SERVER_PRECOMPUTED] ?: false,
        )
    }

    suspend fun setActiveProfileId(profileId: String) {
        context.yangXiaDataStore.edit { it[KEY_ACTIVE_PROFILE] = profileId }
    }

    suspend fun update(transform: (DevicePrefs) -> DevicePrefs) {
        context.yangXiaDataStore.edit { p ->
            val cur = DevicePrefs(
                activeProfileId = p[KEY_ACTIVE_PROFILE] ?: "",
                voiceVol = p[KEY_VOICE_VOL] ?: 92,
                cueVol = p[KEY_CUE_VOL] ?: 70,
                breathVol = p[KEY_BREATH_VOL] ?: 60,
                soundStyle = p[KEY_SOUND_STYLE] ?: "woodblock",
                forceOfflineVoice = p[KEY_FORCE_OFFLINE_VOICE] ?: false,
                vibrate = p[KEY_VIBRATE] ?: true,
                useServerPrecomputed = p[KEY_USE_SERVER_PRECOMPUTED] ?: false,
            )
            val next = transform(cur)
            p[KEY_ACTIVE_PROFILE] = next.activeProfileId
            p[KEY_VOICE_VOL] = next.voiceVol.coerceIn(0, 100)
            p[KEY_CUE_VOL] = next.cueVol.coerceIn(0, 100)
            p[KEY_BREATH_VOL] = next.breathVol.coerceIn(0, 100)
            p[KEY_SOUND_STYLE] = next.soundStyle
            p[KEY_FORCE_OFFLINE_VOICE] = next.forceOfflineVoice
            p[KEY_VIBRATE] = next.vibrate
            p[KEY_USE_SERVER_PRECOMPUTED] = next.useServerPrecomputed
        }
    }

    companion object {
        private val KEY_ACTIVE_PROFILE = stringPreferencesKey("active_profile_id")
        private val KEY_VOICE_VOL = intPreferencesKey("voice_vol")
        private val KEY_CUE_VOL = intPreferencesKey("cue_vol")
        private val KEY_BREATH_VOL = intPreferencesKey("breath_vol")
        private val KEY_SOUND_STYLE = stringPreferencesKey("sound_style")
        private val KEY_FORCE_OFFLINE_VOICE = booleanPreferencesKey("force_offline_voice")
        private val KEY_VIBRATE = booleanPreferencesKey("vibrate")
        private val KEY_USE_SERVER_PRECOMPUTED = booleanPreferencesKey("use_server_precomputed")
    }
}
