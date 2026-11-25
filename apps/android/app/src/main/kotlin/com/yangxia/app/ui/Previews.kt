package com.yangxia.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import com.yangxia.app.player.CourseBlockDto
import com.yangxia.app.player.CourseDto
import com.yangxia.app.player.CourseItemDto
import com.yangxia.app.player.EventViewDto
import com.yangxia.app.player.RepDto
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
import com.yangxia.app.ui.screens.SummaryScreen
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
                    view = EventViewDto(breath = "exhale", tempo = "up", rep = RepDto(n = 5, of = 8)),
                ),
            ),
            stages = listOf(StageDto(id = "ex-0-set-1", label = "第 1 组", firstEventIdx = 0)),
            totalDuration = 420.0,
        ),
    ),
    elapsedSec = 42.0,
)

private val sampleSeniorProfile = sampleProfile.copy(code = "夏老", age = "a65", product = "65岁以上-椅子辅助版")

// 65 岁以上的交付信封样例：练前确认两问、5 个跟练动作、照成品做和提醒
private val sampleSeniorEnvelope = """
{"schema":"yangxia.delivery/1","declaration":"未经专业审核，不是医学建议，不能替代医生的判断",
 "course":{"id":"a65-w1-A","name":"第 1 周 · A 日","age":"a65",
  "source":{"product":"65岁以上-椅子辅助版","week":1,"day":"A","segment":1,"phase":"起始"},
  "blocks":[{"kind":"sets","items":[
   {"exercise":"a65-sit","name":"坐站起","sets":1,"reps":8,"rest":60,"tempo":{"start":"up","up":2,"down":2},"quote":["坐在椅子前半，双脚踩稳，站起来、再慢慢坐下"]},
   {"exercise":"a65-calf","name":"扶椅踮脚","sets":1,"reps":10,"rest":60,"tempo":{"start":"up","up":1,"top":1,"down":2}},
   {"exercise":"a65-side","name":"扶椅侧抬腿","sets":1,"reps":8,"perSide":true,"rest":60,"tempo":{"start":"up","up":2,"down":2}},
   {"exercise":"a65-wall","name":"扶墙俯卧撑","sets":1,"reps":8,"rest":60,"tempo":{"start":"down","down":2,"up":1}},
   {"exercise":"a65-row","name":"坐姿夹背划船","sets":1,"reps":10,"rest":60,"tempo":{"start":"up","up":1,"top":2,"down":2}}]}]},
 "follow":[{"name":"扶椅前后脚站","reason":"平衡动作按每侧几次、来回几次和这一周的扶法做，看计划单上的原文"},
           {"name":"扶椅单腿站","reason":"平衡动作按每侧几次、来回几次和这一周的扶法做，看计划单上的原文"},
           {"name":"扶台面侧向走","reason":"平衡动作按每侧几次、来回几次和这一周的扶法做，看计划单上的原文"}],
 "notes":["本周不做：脚跟脚尖走"],
 "checks":[{"kind":"fall","ask":"上次练完以后，有没有摔倒、差点摔倒、头晕","stop":"今天先不跟练：告诉家人，先问医生。"},
           {"kind":"condition","condition":"家里没有别人","ask":"训练的时候，是不是家里只有你一个人","recorded":false,"conservative":true,"hint":"和档案记的不一样时，照成品原文换做法（扶台面侧向走那一项）","stop":"今天和档案记的不一样，这节课是照档案排的：先在网页上的「家庭与档案」把「家里没有别人」改成今天的情况、重新发课，再来练"}]}
""".trimIndent()

private val sampleSeniorCourse = CachedCourseEntity(
    courseRecordId = "c65",
    profileId = sampleSeniorProfile.profileId,
    courseId = "a65-w1-A",
    courseName = "第 1 周 · A 日",
    segment = 1,
    week = 1,
    day = "A",
    half = false,
    snapshotHash = "h65",
    envelopeJson = sampleSeniorEnvelope,
    precomputedPlanJson = """{"timeline":{"totalDuration":468}}""",
    status = "active",
    invalidatedReason = null,
    updatedAt = "2026-11-02T03:00:00Z",
)

@Preview(name = "Senior_Today_390x844", widthDp = 390, heightDp = 844, showBackground = true)
@Composable
fun PreviewSeniorToday() {
    YangXiaTheme {
        TodayScreen(
            profiles = listOf(sampleSeniorProfile),
            activeProfile = sampleSeniorProfile,
            isMobileBound = true,
            courses = listOf(sampleSeniorCourse),
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

@Preview(name = "Mi6_Senior_Today_360x568", widthDp = 360, heightDp = 568, showBackground = true)
@Composable
fun PreviewMi6SeniorToday() {
    YangXiaTheme {
        TodayScreen(
            profiles = listOf(sampleSeniorProfile),
            activeProfile = sampleSeniorProfile,
            isMobileBound = true,
            courses = listOf(sampleSeniorCourse),
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

@Preview(name = "Mi6_Summary_360x568", widthDp = 360, heightDp = 568, showBackground = true)
@Composable
fun PreviewMi6Summary() {
    YangXiaTheme {
        SummaryScreen(
            profileCode = "小夏",
            course = sampleCourse,
            initialSetsDone = listOf(2),
            busy = false,
            elapsedSec = 485.0,
            onSubmit = { _, _, _, _ -> },
            onDiscard = {},
        )
    }
}

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
