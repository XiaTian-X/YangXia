package com.yangxia.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import com.yangxia.app.player.CourseBlockDto
import com.yangxia.app.player.CourseDto
import com.yangxia.app.player.CourseItemDto
import com.yangxia.app.player.PlaybackSettingsDto
import com.yangxia.app.player.PlayerPlanResultDto
import com.yangxia.app.player.StageDto
import com.yangxia.app.player.TempoDto
import com.yangxia.app.player.TimelineDto
import com.yangxia.app.player.TimelineEventDto
import com.yangxia.app.service.WorkoutPhaseStatus
import com.yangxia.app.service.WorkoutSessionState
import com.yangxia.app.storage.CachedCourseEntity
import com.yangxia.app.storage.CachedProfileEntity
import com.yangxia.app.ui.screens.TodayScreen
import com.yangxia.app.ui.screens.WorkoutScreen
import com.yangxia.app.ui.theme.YangXiaTheme

private val sampleProfile = CachedProfileEntity(
    profileId = "11111111-1111-4111-8111-111111111111",
    code = "小夏",
    age = "a18",
    product = "18-39岁-居家版",
    supportedForWorkout = true,
    hasConflict = false,
    conflictMessage = null,
    playbackJson = null,
    updatedAt = "2026-11-02T03:00:00Z",
)

private val sampleCourse = CourseDto(
    id = "sample-course",
    name = "第 1 周 · A 日（居家版）",
    blocks = listOf(
        CourseBlockDto(
            kind = "sets",
            items = listOf(
                CourseItemDto(
                    exercise = "pushup",
                    name = "上斜俯卧撑",
                    mode = "reps",
                    sets = 3,
                    reps = 8,
                    tempo = TempoDto(start = "down", down = 2, up = 1),
                ),
            ),
        ),
    ),
)

private val sampleWorkoutState = WorkoutSessionState(
    status = WorkoutPhaseStatus.PLAYING,
    profileCode = "小夏",
    course = sampleCourse,
    plan = PlayerPlanResultDto(
        course = sampleCourse,
        effectiveSettings = PlaybackSettingsDto(),
        timeline = TimelineDto(
            events = listOf(
                TimelineEventDto(
                    time = 0.0,
                    state = "action",
                    display = "5 / 8",
                    label = "第 5 次 · 发力起",
                    breathText = "领呼\"呼\"",
                    cueType = "up",
                    phaseGroup = "ex-0-set-1",
                    itemIndex = 0,
                ),
            ),
            stages = listOf(StageDto(id = "ex-0-set-1", label = "第 1 组", firstEventIdx = 0)),
            totalDuration = 420.0,
        ),
    ),
    elapsedSec = 42.0,
)

@Preview(name = "Mi6_Today_360x568", widthDp = 360, heightDp = 568, showBackground = true)
@Composable
fun PreviewMi6Today() {
    YangXiaTheme {
        TodayScreen(
            profiles = listOf(sampleProfile),
            activeProfile = sampleProfile,
            isMobileBound = false,
            courses = listOf(
                CachedCourseEntity(
                    courseRecordId = "c1",
                    profileId = sampleProfile.profileId,
                    courseId = "sample-course",
                    courseName = "第 1 周 · A 日（居家版）",
                    segment = 1,
                    week = 1,
                    day = "A",
                    half = false,
                    snapshotHash = "h1",
                    envelopeJson = "{}",
                    precomputedPlanJson = null,
                    status = "active",
                    invalidatedReason = null,
                    updatedAt = "2026-11-02T03:00:00Z",
                ),
            ),
            pendingSessions = emptyList(),
            clockSkewAlert = null,
            busy = false,
            error = null,
            message = null,
            onSelectProfile = {},
            onRefresh = {},
            onSyncPending = {},
            onStartCourse = {},
            onOpenSettings = {},
        )
    }
}

@Preview(name = "Mi6_Workout_Portrait_360x568", widthDp = 360, heightDp = 568, showBackground = true)
@Composable
fun PreviewMi6WorkoutPortrait() {
    YangXiaTheme {
        WorkoutScreen(
            state = sampleWorkoutState,
            motionRawMap = emptyMap(),
            motionMetaMap = emptyMap(),
            onTogglePause = {},
            onPrevStage = {},
            onNextStage = {},
            onFinish = {},
        )
    }
}

@Preview(name = "Standard_Workout_411x891", widthDp = 411, heightDp = 891, showBackground = true)
@Composable
fun PreviewStandardWorkout() {
    YangXiaTheme {
        WorkoutScreen(
            state = sampleWorkoutState,
            motionRawMap = emptyMap(),
            motionMetaMap = emptyMap(),
            onTogglePause = {},
            onPrevStage = {},
            onNextStage = {},
            onFinish = {},
        )
    }
}

@Preview(name = "Landscape_Workout_640x360", widthDp = 640, heightDp = 360, showBackground = true)
@Composable
fun PreviewLandscapeWorkout() {
    YangXiaTheme {
        WorkoutScreen(
            state = sampleWorkoutState,
            motionRawMap = emptyMap(),
            motionMetaMap = emptyMap(),
            onTogglePause = {},
            onPrevStage = {},
            onNextStage = {},
            onFinish = {},
        )
    }
}
