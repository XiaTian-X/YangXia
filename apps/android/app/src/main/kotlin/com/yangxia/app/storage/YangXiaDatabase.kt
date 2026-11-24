package com.yangxia.app.storage

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "cached_profiles")
data class CachedProfileEntity(
    @PrimaryKey val profileId: String,
    val code: String,
    val age: String,
    val product: String,
    val supportedForWorkout: Boolean,
    val hasConflict: Boolean,
    val conflictMessage: String?,
    val playbackJson: String?,
    val updatedAt: String,
)

@Entity(tableName = "cached_courses")
data class CachedCourseEntity(
    @PrimaryKey val courseRecordId: String,
    val profileId: String,
    val courseId: String,
    val courseName: String,
    val segment: Int,
    val week: Int,
    val day: String,
    val half: Boolean,
    val snapshotHash: String,
    val envelopeJson: String,
    val precomputedPlanJson: String?,
    val status: String, // "active" | "invalidated"
    val invalidatedReason: String?,
    val updatedAt: String,
)

@Entity(tableName = "cached_motions")
data class CachedMotionEntity(
    @PrimaryKey val clipId: String,
    val hash: String,
    val jsonContent: String,
    val lastUsedAt: Long,
)

@Entity(tableName = "pending_sessions")
data class PendingSessionEntity(
    @PrimaryKey val idempotencyKey: String,
    val profileId: String,
    val courseRecordId: String?,
    val courseId: String,
    val courseSnapshotHash: String?,
    val startedAt: String,
    val sessionJson: String,
    val lastErrorCode: String?,
    val lastErrorMessage: String?,
    val retryCount: Int,
    val createdAt: Long,
)

@Dao
interface ProfileDao {
    @Query("SELECT * FROM cached_profiles ORDER BY updatedAt DESC")
    fun observeAll(): Flow<List<CachedProfileEntity>>

    @Query("SELECT * FROM cached_profiles ORDER BY updatedAt DESC")
    suspend fun listAll(): List<CachedProfileEntity>

    @Query("SELECT * FROM cached_profiles WHERE profileId = :profileId LIMIT 1")
    suspend fun getById(profileId: String): CachedProfileEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(profile: CachedProfileEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(profiles: List<CachedProfileEntity>)

    @Query("DELETE FROM cached_profiles WHERE profileId NOT IN (:keepIds)")
    suspend fun pruneMissing(keepIds: List<String>)

    @Query("DELETE FROM cached_profiles")
    suspend fun clearAll()
}

@Dao
interface CourseDao {
    @Query("SELECT * FROM cached_courses WHERE profileId = :profileId ORDER BY status ASC, updatedAt DESC")
    fun observeByProfile(profileId: String): Flow<List<CachedCourseEntity>>

    @Query("SELECT * FROM cached_courses WHERE profileId = :profileId")
    suspend fun listByProfile(profileId: String): List<CachedCourseEntity>

    @Query("SELECT * FROM cached_courses WHERE courseRecordId = :courseRecordId LIMIT 1")
    suspend fun getByRecordId(courseRecordId: String): CachedCourseEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(courses: List<CachedCourseEntity>)

    @Query("UPDATE cached_courses SET status = 'invalidated', invalidatedReason = :reason, updatedAt = :updatedAt WHERE courseRecordId = :courseRecordId")
    suspend fun markInvalidated(courseRecordId: String, reason: String, updatedAt: String)

    @Query("DELETE FROM cached_courses WHERE profileId = :profileId AND status = 'active' AND courseRecordId NOT IN (:keepIds)")
    suspend fun pruneMissingActive(profileId: String, keepIds: List<String>)

    @Query("DELETE FROM cached_courses WHERE profileId = :profileId AND status = 'active'")
    suspend fun deleteAllActiveForProfile(profileId: String)

    @Query("DELETE FROM cached_courses")
    suspend fun clearAll()
}

@Dao
interface MotionDao {
    @Query("SELECT clipId, hash FROM cached_motions")
    suspend fun listHashes(): List<MotionHashTuple>

    @Query("SELECT * FROM cached_motions WHERE clipId IN (:clipIds)")
    suspend fun getByIds(clipIds: List<String>): List<CachedMotionEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(motions: List<CachedMotionEntity>)

    @Query("UPDATE cached_motions SET lastUsedAt = :ts WHERE clipId IN (:clipIds)")
    suspend fun touchUsed(clipIds: List<String>, ts: Long)

    @Query("DELETE FROM cached_motions WHERE clipId NOT IN (SELECT clipId FROM cached_motions ORDER BY lastUsedAt DESC LIMIT :keepMax)")
    suspend fun pruneLru(keepMax: Int = 80)
}

data class MotionHashTuple(val clipId: String, val hash: String)

@Dao
interface PendingSessionDao {
    @Query("SELECT * FROM pending_sessions WHERE profileId = :profileId ORDER BY createdAt ASC")
    fun observeByProfile(profileId: String): Flow<List<PendingSessionEntity>>

    @Query("SELECT * FROM pending_sessions ORDER BY createdAt ASC")
    suspend fun listAll(): List<PendingSessionEntity>

    @Query("SELECT * FROM pending_sessions WHERE profileId = :profileId AND lastErrorCode = 'CLOCK_SKEW_FUTURE' LIMIT 1")
    fun observeClockSkewAlert(profileId: String): Flow<PendingSessionEntity?>

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIgnore(item: PendingSessionEntity): Long

    @Query("UPDATE pending_sessions SET lastErrorCode = :code, lastErrorMessage = :msg, retryCount = retryCount + 1 WHERE idempotencyKey = :key")
    suspend fun recordError(key: String, code: String?, msg: String?)

    @Query("DELETE FROM pending_sessions WHERE idempotencyKey = :key")
    suspend fun deleteByKey(key: String)

    @Query("DELETE FROM pending_sessions")
    suspend fun clearAll()
}

@Database(
    entities = [
        CachedProfileEntity::class,
        CachedCourseEntity::class,
        CachedMotionEntity::class,
        PendingSessionEntity::class,
    ],
    version = 1,
    exportSchema = false,
)
abstract class YangXiaDatabase : RoomDatabase() {
    abstract fun profileDao(): ProfileDao
    abstract fun courseDao(): CourseDao
    abstract fun motionDao(): MotionDao
    abstract fun pendingSessionDao(): PendingSessionDao

    companion object {
        @Volatile
        private var instance: YangXiaDatabase? = null

        fun getInstance(context: Context): YangXiaDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    YangXiaDatabase::class.java,
                    "yangxia_mobile_cache.db",
                ).fallbackToDestructiveMigration(dropAllTables = true).build().also { instance = it }
            }
    }
}
