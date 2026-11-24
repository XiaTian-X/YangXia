// 受控业务工具注册表（零 Agent SDK 依赖）：
// - 严禁任何 shell / 任意文件 / 外网请求工具；
// - ToolContext 由鉴权中间件注入，模型无法跨档案传参（工具入参中不含 profileId/userId）；
// - 含只读工具 + 8 大校验型写入域（档案更新拆为 5 个扁平强类型子工具）；
// - 高危写入（含医生同意建档、筛查/医生同意、安全条件放松、提交评估、推周/换段、65+ 确认无摔倒发课、段归档）
//   在对话轮次中强制走两阶段确认卡，绑定 expectedVersion 乐观锁并返回结构化 preview 杜绝盲签与 TOCTOU。
import { z } from "zod";
import {
  ASSESS_FORMAT,
  assessRules,
  auditProfileBundle,
  bedtimeFor,
  currentSegment,
  DECLARATION,
  evaluateAssessment,
  inspectEndSummary,
  isValidTimeZone,
  PROFILE_FORMAT,
  progressOn,
  resolveTimeZone,
  REVIEW_FORMAT,
  screeningFor,
  type Issue,
} from "@yangxia/course-core";
import { assertProfileAccess, canPerformOnProfile } from "../../auth/permissions.ts";
import { loadProfileState } from "../../db/bundle.ts";
import { AppError } from "../../db/lock.ts";
import {
  archiveSegmentOp,
  auditProfileForMutation,
  createProfileOp,
  generatePlanSheetOp,
  publishCourseOp,
  saveDocumentOp,
  submitAssessmentOp,
  submitReviewOp,
  updateProfileOp,
} from "../../domain/profile-ops.ts";
import type { BusinessToolDef, ToolContext, ToolExecutionResult } from "./types.ts";

type Obj = Record<string, any>;

const DATE_STR = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function requireBoundProfileId(tctx: ToolContext): string {
  if (!tctx.profileId) {
    throw new AppError(400, "NO_PROFILE_BOUND", "当前对话尚未绑定档案：请先通过建档工具创建档案，或在网页端切换到目标档案");
  }
  return tctx.profileId;
}

function wrapToolError(err: unknown): ToolExecutionResult {
  if (err instanceof AppError) {
    const details = err.details as { issues?: unknown[] } | undefined;
    return {
      ok: false,
      code: err.code,
      message: err.message,
      ...(details?.issues ? { issues: details.issues } : {}),
    };
  }
  return {
    ok: false,
    code: "TOOL_ERROR",
    message: "工具执行未通过校验，请核对后重试或改用网页可视表单",
  };
}

interface StagePrecheckResult {
  expectedVersion?: number | null;
  summary?: string;
  preview: Record<string, unknown>;
  warnings?: Issue[];
}

/** 将高危写入在对话轮次中转为两阶段确认卡（先预校验并捕获 expectedVersion 与防盲签 preview，不落库）。 */
function stageOrCommit(
  tctx: ToolContext,
  toolName: string,
  profileId: string | null,
  defaultSummary: string,
  payload: unknown,
  validateOnly: () => StagePrecheckResult,
  commit: () => ToolExecutionResult,
): ToolExecutionResult {
  if (tctx.enforceTwoPhaseConfirm && tctx.confirmHook) {
    const checked = validateOnly();
    const finalSummary = checked.summary ?? defaultSummary;
    const { confirmationId } = tctx.confirmHook.stageConfirmation({
      toolName,
      profileId,
      expectedVersion: checked.expectedVersion ?? null,
      summary: finalSummary,
      preview: checked.preview,
      payload,
      warnings: checked.warnings?.map((w) => ({ path: w.path, message: w.message })),
    });
    return {
      ok: true,
      pendingConfirmation: true,
      confirmationId,
      summary: finalSummary,
      preview: checked.preview,
      message: "已通过规则预校验并生成确认卡，请向用户逐项展示确认卡明细，待用户在界面点击「确认并保存」后正式写入。",
      ...(checked.warnings?.length ? { issues: checked.warnings } : {}),
    };
  }
  return commit();
}

/** 通用档案补丁只读预检（不写库）：返回乐观锁 version 与 warnings。 */
function precheckProfilePatch(
  tctx: ToolContext,
  profileId: string,
  patch: Obj,
  nextTz?: string,
): { version: number; before: Obj; candidate: Obj; warnings: Issue[] } {
  const db = tctx.ctx.getDb();
  const snap = tctx.ctx.templates.current();
  const now = tctx.ctx.now();
  const meta = assertProfileAccess(db, tctx.actor, profileId, "manage");
  const before = JSON.parse(meta.profile_json) as Obj;
  const candidate: Obj = { ...before, ...patch, schema: PROFILE_FORMAT };
  if (nextTz) {
    if (!isValidTimeZone(nextTz)) throw new AppError(422, "INVALID_TIMEZONE", `非法 IANA 时区：${nextTz}`);
    candidate.timezone = nextTz;
  }
  const state = loadProfileState(db, profileId, { profile: candidate });
  if (nextTz) state.bundle.timeZone = nextTz;
  const issues = auditProfileForMutation(state.bundle, snap, now);
  const errs = issues.filter((i) => i.level === "error");
  if (errs.length) {
    throw new AppError(422, "PROFILE_VALIDATION_FAILED", "档案修改预校验未通过，请先按提示补充或修正", { issues });
  }
  return { version: meta.version, before, candidate, warnings: issues.filter((i) => i.level === "warning") };
}

function summarizeScreening(sc: Obj | undefined) {
  const answers = Array.isArray(sc?.answers) ? sc.answers : [];
  const yesItems = answers.filter((a: Obj) => a?.answer === "是").map((a: Obj) => String(a.item ?? ""));
  return {
    date: sc?.date ?? null,
    doctorCleared: sc?.doctorCleared === true,
    doctorDate: sc?.doctorDate ?? null,
    yesCount: yesItems.length,
    yesItems,
  };
}

// ---------- 只读工具（3 个对所有可读成员开放；inspect_assessment 需 manage 权限） ----------

const getProfileStateTool: BusinessToolDef<Record<string, never>> = {
  name: "get_profile_state",
  description: "读取当前对话绑定档案的摘要与当前段周次；具管理权限者额外返回条件、偏好、进度与规则核对提示。",
  readOnly: true,
  parameters: z.object({}),
  async execute(_args, tctx) {
    try {
      const pid = requireBoundProfileId(tctx);
      const db = tctx.ctx.getDb();
      const meta = assertProfileAccess(db, tctx.actor, pid, "read_basic");
      const canManage = canPerformOnProfile(tctx.actor, meta, "manage");
      const state = loadProfileState(db, pid);
      const profile = state.bundle.profile;
      const curSeg = currentSegment(profile);

      // 13–17 岁青少年及其他仅具 read_basic 权限的成员：严格裁剪至与 GET /api/profiles/:id 一致的安全基础视图
      if (!canManage) {
        return {
          ok: true,
          data: {
            declaration: DECLARATION,
            readOnlyView: true,
            profileId: meta.id,
            code: meta.code,
            stage: profile.stage,
            age: profile.age,
            venue: profile.venue,
            product: profile.product,
            timezone: meta.timezone,
            currentSegment: curSeg,
            activeCourseCount: state.activeCourseRows.length,
          },
        };
      }

      const snap = tctx.ctx.templates.current();
      const issues = auditProfileBundle(state.bundle, snap, { now: tctx.ctx.now() });
      return {
        ok: true,
        data: {
          declaration: DECLARATION,
          readOnlyView: false,
          profileId: meta.id,
          code: meta.code,
          version: meta.version,
          stage: profile.stage,
          age: profile.age,
          venue: profile.venue,
          product: profile.product,
          timezone: meta.timezone,
          currentSegment: curSeg,
          hasConflict: meta.has_conflict === 1,
          conflict: meta.conflict_json ? JSON.parse(meta.conflict_json) : null,
          conditions: profile.conditions ?? {},
          choices: profile.choices ?? [],
          household: profile.household ?? null,
          playback: profile.playback ?? {},
          progress: profile.progress ?? {},
          screeningSummary: summarizeScreening(profile.screening),
          activeCourseCount: state.activeCourseRows.length,
          recentSessionsCount: state.bundle.sessions.filter((s) => !s.archived).length,
          auditIssues: issues,
        },
      };
    } catch (err) {
      return wrapToolError(err);
    }
  },
};

const getIntakeAndBedtimeTool: BusinessToolDef<{ age?: string; stage?: string; wake?: string }> = {
  name: "get_intake_and_bedtime",
  description: "查询养夏入口问卷、成品列表、指定年龄段的安全筛查项原文，以及按公式精确计算上床时间（严禁心算）。",
  readOnly: true,
  parameters: z.object({
    age: z.enum(["a06", "a13", "a18", "a40", "a65"]).optional().describe("按年龄段筛选筛查项和成品"),
    stage: z.string().optional().describe("阶段名，如 18–39 岁、初中、65 岁以上，配合 wake 算上床时间"),
    wake: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe("起床时间 HH:MM"),
  }),
  async execute(args, tctx) {
    try {
      const snap = tctx.ctx.templates.current();
      const bedtime = args.stage && args.wake ? bedtimeFor(snap.manifest, args.stage, args.wake) : null;
      return {
        ok: true,
        data: {
          declaration: DECLARATION,
          stages: snap.manifest.intake.stages,
          notCovered: (snap.manifest.intake as Obj).not_covered ?? [],
          products: args.age ? snap.manifest.products.filter((p) => p.age === args.age) : snap.manifest.products,
          screening: args.age ? screeningFor(snap.manifest, args.age) : snap.manifest.intake.screening,
          conditions: snap.rules?.conditions ?? [],
          ...(args.stage && args.wake ? { bedtime } : {}),
        },
      };
    } catch (err) {
      return wrapToolError(err);
    }
  },
};

const inspectAssessmentTool: BusinessToolDef<{ kind: "入门" | "段末" | "周期末" | "触发" }> = {
  name: "inspect_assessment",
  description: "列出当前档案做指定评估（入门/段末/周期末/触发）时需要问和测的原文项目；段末/周期末同时返回后端汇总的训练次数与达标情况（需档案管理权限）。",
  readOnly: false,
  parameters: z.object({
    kind: z.enum(["入门", "段末", "周期末", "触发"]),
  }),
  async execute(args, tctx) {
    try {
      const pid = requireBoundProfileId(tctx);
      const db = tctx.ctx.getDb();
      assertProfileAccess(db, tctx.actor, pid, "manage");
      const state = loadProfileState(db, pid);
      const snap = tctx.ctx.templates.current();
      const ar = snap.rules ? assessRules(snap.rules) : null;
      const summary =
        args.kind === "段末" || args.kind === "周期末"
          ? inspectEndSummary(state.bundle, snap, args.kind, { now: tctx.ctx.now() })
          : null;
      return {
        ok: true,
        data: {
          kind: args.kind,
          product: state.bundle.profile.product,
          assessRules: ar,
          endSummary: summary,
        },
      };
    } catch (err) {
      return wrapToolError(err);
    }
  },
};

const readTemplateSectionTool: BusinessToolDef<{ docName: string; query?: string }> = {
  name: "read_template_section",
  description: "只读检索养夏模板成品、全家餐饮模板、三餐菜谱手册或附册正文（可按关键词或标题定位片段）。",
  readOnly: true,
  parameters: z.object({
    docName: z.string().min(1).max(80).describe("文档名（不含 .md），如 全家餐饮模板、18-39岁-居家版"),
    query: z.string().max(60).optional().describe("可选检索关键词或章节标题"),
  }),
  async execute(args, tctx) {
    try {
      const snap = tctx.ctx.templates.current();
      const content = snap.readDoc(args.docName);
      if (!content) {
        return {
          ok: false,
          code: "DOC_NOT_FOUND",
          message: `找不到模板文档「${args.docName}」，可用文档：${snap.listDocs().slice(0, 20).join("、")}`,
        };
      }
      if (!args.query?.trim()) {
        return {
          ok: true,
          data: {
            docName: args.docName,
            version: snap.version,
            truncated: content.length > 6000,
            excerpt: content.slice(0, 6000),
          },
        };
      }
      const q = args.query.trim();
      const idx = content.indexOf(q);
      if (idx < 0) {
        return {
          ok: true,
          data: {
            docName: args.docName,
            version: snap.version,
            matched: false,
            excerpt: content.slice(0, 3000),
          },
        };
      }
      const start = Math.max(0, idx - 400);
      const end = Math.min(content.length, idx + 3600);
      return {
        ok: true,
        data: {
          docName: args.docName,
          version: snap.version,
          matched: true,
          excerpt: content.slice(start, end),
        },
      };
    } catch (err) {
      return wrapToolError(err);
    }
  },
};

// ---------- 写入域 1：建档（仅未绑档对话可用；含医生同意声明时强制两阶段确认卡） ----------

function profileHasDoctorClearance(p: Obj): boolean {
  if (p?.screening?.doctorCleared === true) return true;
  if (Array.isArray(p?.weightClear) && p.weightClear.length > 0) return true;
  if (Array.isArray(p?.cardioClear) && p.cardioClear.length > 0) return true;
  if (Array.isArray(p?.addClear) && p.addClear.length > 0) return true;
  if (Array.isArray(p?.dietByPro) && p.dietByPro.length > 0) return true;
  return false;
}

const createProfileTool: BusinessToolDef<{
  profile: Record<string, unknown>;
  timezone?: string;
  isManaged?: boolean;
}> = {
  name: "create_profile",
  description: "新建个人或家庭代管档案（仅未绑定档案的建档对话可调用）：自动执行全套规则与筛查门禁；若含医生同意标记（doctorCleared: true 等）须走确认卡。",
  parameters: z.object({
    profile: z.record(z.string(), z.unknown()).describe("完整档案对象（含 code/stage/age/venue/product/startDate/segments/screening 等）"),
    timezone: z.string().optional().describe("IANA 时区，默认 Asia/Shanghai"),
    isManaged: z.boolean().optional().describe("是否管理员代管子档案（仅管理员可设 true）"),
  }),
  async execute(args, tctx) {
    try {
      if (tctx.profileId !== null) {
        return {
          ok: false,
          code: "THREAD_ALREADY_BOUND",
          message: "当前对话已绑定档案，禁止在已绑档对话中另建或改绑档案；请新建独立建档对话或在网页端创建",
        };
      }
      const raw = args.profile as Obj;
      const needsConfirm = profileHasDoctorClearance(raw);
      const commit = (): ToolExecutionResult => {
        const db = tctx.ctx.getDb();
        const res = createProfileOp(
          db,
          tctx.ctx.templates.current(),
          tctx.actor,
          {
            profile: args.profile,
            timezone: args.timezone,
            isManaged: args.isManaged,
          },
          tctx.ctx.now(),
        );
        tctx.onBindProfile?.(res.id);
        return {
          ok: true,
          data: { profileId: res.id, version: res.version, code: res.profile.code, warnings: res.warnings },
        };
      };

      if (!needsConfirm) return commit();

      return stageOrCommit(
        tctx,
        this.name,
        null,
        `确认新建档案「${String(raw.code ?? "")}」（含医生同意标记）`,
        args,
        () => {
          const db = tctx.ctx.getDb();
          if (args.isManaged && tctx.actor.role !== "admin") {
            throw new AppError(403, "FORBIDDEN", "只有管理员可以创建代管子档案");
          }
          const tz = resolveTimeZone(args.timezone ?? raw.timezone, raw);
          if (!isValidTimeZone(tz)) throw new AppError(422, "INVALID_TIMEZONE", `非法 IANA 时区：${tz}`);
          const candidate: Obj = { ...raw, schema: PROFILE_FORMAT, timezone: tz };
          const dup = db.prepare("SELECT 1 FROM profiles WHERE code = ?").get(String(candidate.code ?? ""));
          if (dup) throw new AppError(409, "PROFILE_CODE_CONFLICT", "该档案代号不可用，请更换其他代号");
          const snap = tctx.ctx.templates.current();
          const issues = auditProfileForMutation(
            { profile: candidate, timeZone: tz, sessions: [], reviewData: {}, courses: [], assessments: [], docs: [] },
            snap,
            tctx.ctx.now(),
          );
          if (issues.some((i) => i.level === "error")) {
            throw new AppError(422, "PROFILE_VALIDATION_FAILED", "档案未通过规则校验", { issues });
          }
          const sc = summarizeScreening(candidate.screening);
          return {
            summary: `确认新建档案「${String(candidate.code)}」（${String(candidate.product)}，医生同意：${sc.doctorCleared ? `是，日期 ${String(sc.doctorDate ?? "未填")}` : "否"}）`,
            preview: {
              action: "create_profile",
              code: candidate.code,
              product: candidate.product,
              age: candidate.age,
              screening: sc,
              weightClear: candidate.weightClear ?? null,
              cardioClear: candidate.cardioClear ?? null,
              addClear: candidate.addClear ?? null,
              dietByPro: candidate.dietByPro ?? null,
            },
            warnings: issues.filter((i) => i.level === "warning"),
          };
        },
        commit,
      );
    } catch (err) {
      return wrapToolError(err);
    }
  },
};

// ---------- 写入域 2a–2e：受控档案更新（拆为 5 个扁平强类型子工具） ----------

const updateScreeningAndDoctorTool: BusinessToolDef<{
  screening?: Record<string, unknown>;
  weightClear?: { date: string }[];
  cardioClear?: { date: string }[];
  addClear?: { date: string; items: string[] }[];
  addOnLog?: { date: string; item: string; action: "加" | "减"; why: string }[];
  dietByPro?: { date: string; pro: boolean }[];
}> = {
  name: "update_screening_and_doctor",
  highRisk: true,
  description: "更新安全筛查、医生同意日期（weightClear/cardioClear 为 [{date}]，addClear 为 [{date,items}]，addOnLog 为 [{date,item,action,why}]，dietByPro 为 [{date,pro}]）。高危操作：对话中先校验并生成带明细的确认卡。",
  parameters: z.object({
    screening: z.record(z.string(), z.unknown()).optional(),
    weightClear: z.array(z.object({ date: DATE_STR })).optional(),
    cardioClear: z.array(z.object({ date: DATE_STR })).optional(),
    addClear: z.array(z.object({ date: DATE_STR, items: z.array(z.string().min(1)).min(1) })).optional(),
    addOnLog: z
      .array(
        z.object({
          date: DATE_STR,
          item: z.string().min(1),
          action: z.enum(["加", "减"]),
          why: z.string().min(1),
        }),
      )
      .optional(),
    dietByPro: z.array(z.object({ date: DATE_STR, pro: z.boolean() })).optional(),
  }),
  async execute(args, tctx) {
    try {
      const pid = requireBoundProfileId(tctx);
      const patch: Obj = {};
      if (args.screening !== undefined) patch.screening = args.screening;
      if (args.weightClear !== undefined) patch.weightClear = args.weightClear;
      if (args.cardioClear !== undefined) patch.cardioClear = args.cardioClear;
      if (args.addClear !== undefined) patch.addClear = args.addClear;
      if (args.addOnLog !== undefined) patch.addOnLog = args.addOnLog;
      if (args.dietByPro !== undefined) patch.dietByPro = args.dietByPro;
      if (!Object.keys(patch).length) {
        return { ok: false, code: "EMPTY_PATCH", message: "未提供任何要更新的安全筛查或医生同意字段" };
      }

      return stageOrCommit(
        tctx,
        this.name,
        pid,
        `确认更新安全筛查/医生同意字段：${Object.keys(patch).join("、")}`,
        args,
        () => {
          const checked = precheckProfilePatch(tctx, pid, patch);
          const parts: string[] = [];
          const preview: Record<string, unknown> = { action: "update_screening_and_doctor", fields: Object.keys(patch) };
          if (args.screening) {
            const sc = summarizeScreening(args.screening);
            preview.screening = sc;
            parts.push(`筛查「是」${sc.yesCount} 项、医生同意=${sc.doctorCleared ? `是（${String(sc.doctorDate ?? "未填日期")}）` : "否"}`);
          }
          if (args.weightClear) {
            preview.weightClear = args.weightClear;
            parts.push(`减重医生同意：${args.weightClear.map((x) => x.date).join("、")}`);
          }
          if (args.cardioClear) {
            preview.cardioClear = args.cardioClear;
            parts.push(`有氧加量医生同意：${args.cardioClear.map((x) => x.date).join("、")}`);
          }
          if (args.addClear) {
            preview.addClear = args.addClear;
            parts.push(`65+ 加项医生同意：${args.addClear.map((x) => `${x.date}(${x.items.join("/")})`).join("；")}`);
          }
          if (args.addOnLog) {
            preview.addOnLog = args.addOnLog;
            parts.push(`65+ 加减项记录：${args.addOnLog.map((x) => `${x.date} ${x.action}${x.item}`).join("；")}`);
          }
          if (args.dietByPro) {
            preview.dietByPro = args.dietByPro;
            parts.push(`专业减重方案标记：${args.dietByPro.map((x) => `${x.date}=${x.pro ? "照专业方案" : "取消"}`).join("；")}`);
          }
          return {
            expectedVersion: checked.version,
            summary: `确认更新：${parts.join("；")}`,
            preview,
            warnings: checked.warnings,
          };
        },
        () => {
          const db = tctx.ctx.getDb();
          assertProfileAccess(db, tctx.actor, pid, "manage");
          const res = updateProfileOp(
            db,
            tctx.ctx.templates.current(),
            tctx.actor,
            pid,
            { expectedVersion: tctx.expectedVersion, patch },
            tctx.ctx.now(),
          );
          return { ok: true, data: { version: res.version, invalidatedCourses: res.invalidatedCourses, warnings: res.warnings } };
        },
      );
    } catch (err) {
      return wrapToolError(err);
    }
  },
};

const updateProgressLogTool: BusinessToolDef<{
  entries: { date: string; move: string; field: "level" | "reps" | "weight"; to: number; rule: string; evidence?: string }[];
}> = {
  name: "update_progress_log",
  description: "按成品规则向 progressLog 追加进度调整记录并自动重放更新 progress；经完整规则核对 0 错误后落库，下调进度时自动作废过重旧课。",
  parameters: z.object({
    entries: z
      .array(
        z.object({
          date: DATE_STR,
          move: z.string().min(1),
          field: z.enum(["level", "reps", "weight"]),
          to: z.number(),
          rule: z.string().min(1),
          evidence: z.string().optional(),
        }),
      )
      .min(1)
      .max(20),
  }),
  async execute(args, tctx) {
    try {
      const pid = requireBoundProfileId(tctx);
      const db = tctx.ctx.getDb();
      const meta = assertProfileAccess(db, tctx.actor, pid, "manage");
      const before = JSON.parse(meta.profile_json) as Obj;
      const snap = tctx.ctx.templates.current();
      const now = tctx.ctx.now();
      const nextLog = [...(Array.isArray(before.progressLog) ? before.progressLog : []), ...args.entries];
      const nextProgress =
        snap.plans && snap.rules
          ? progressOn({ ...before, progressLog: nextLog }, snap.plans, snap.rules, "9999-12-31", now, meta.timezone)
          : {};
      const res = updateProfileOp(
        db,
        snap,
        tctx.actor,
        pid,
        { expectedVersion: meta.version, patch: { progressLog: nextLog, progress: nextProgress } },
        now,
      );
      return { ok: true, data: { version: res.version, progress: nextProgress, invalidatedCourses: res.invalidatedCourses } };
    } catch (err) {
      return wrapToolError(err);
    }
  },
};

const SAFETY_TRUE_IS_CAUTIOUS = ["高血压", "骨质疏松", "重度肥胖", "家里没有别人"] as const;

function isRelaxingSafetyConditions(beforeCond: Obj, incoming: Record<string, boolean> | undefined): string[] {
  if (!incoming) return [];
  const relaxed: string[] = [];
  if (incoming["有氧问过医生"] === true && beforeCond?.["有氧问过医生"] !== true) {
    relaxed.push("有氧问过医生=是");
  }
  for (const k of SAFETY_TRUE_IS_CAUTIOUS) {
    if (incoming[k] === false && beforeCond?.[k] !== false) {
      relaxed.push(`${k}=否（取消保守限制）`);
    }
  }
  return relaxed;
}

const updateConditionsAndChoicesTool: BusinessToolDef<{
  conditions?: Record<string, boolean>;
  choices?: string[];
  household?: ("a06" | "a13" | "a18" | "a40" | "a65")[];
}> = {
  name: "update_conditions_and_choices",
  description: "更新训练单条件（conditions，每项仅 true/false）、器材优先列表（choices）或全家成员年龄段（household）；若放松健康安全限制须走确认卡。",
  parameters: z.object({
    conditions: z.record(z.string(), z.boolean()).optional(),
    choices: z.array(z.string()).optional(),
    household: z.array(z.enum(["a06", "a13", "a18", "a40", "a65"])).optional(),
  }),
  async execute(args, tctx) {
    try {
      const pid = requireBoundProfileId(tctx);
      const db = tctx.ctx.getDb();
      const meta = assertProfileAccess(db, tctx.actor, pid, "manage");
      const before = JSON.parse(meta.profile_json) as Obj;
      const patch: Obj = {};
      if (args.conditions !== undefined) patch.conditions = { ...(before.conditions ?? {}), ...args.conditions };
      if (args.choices !== undefined) patch.choices = args.choices;
      if (args.household !== undefined) patch.household = args.household;
      if (!Object.keys(patch).length) return { ok: false, code: "EMPTY_PATCH", message: "未提供需要更新的条件、器材或家庭成员" };

      const relaxed = isRelaxingSafetyConditions(before.conditions ?? {}, args.conditions);
      const commit = (): ToolExecutionResult => {
        const curDb = tctx.ctx.getDb();
        assertProfileAccess(curDb, tctx.actor, pid, "manage");
        const curMeta = assertProfileAccess(curDb, tctx.actor, pid, "manage");
        const curBefore = JSON.parse(curMeta.profile_json) as Obj;
        const finalPatch: Obj = {};
        if (args.conditions !== undefined) finalPatch.conditions = { ...(curBefore.conditions ?? {}), ...args.conditions };
        if (args.choices !== undefined) finalPatch.choices = args.choices;
        if (args.household !== undefined) finalPatch.household = args.household;
        const res = updateProfileOp(
          curDb,
          tctx.ctx.templates.current(),
          tctx.actor,
          pid,
          { expectedVersion: tctx.expectedVersion ?? curMeta.version, patch: finalPatch },
          tctx.ctx.now(),
        );
        return { ok: true, data: { version: res.version, invalidatedCourses: res.invalidatedCourses, warnings: res.warnings } };
      };

      if (!relaxed.length) return commit();

      return stageOrCommit(
        tctx,
        this.name,
        pid,
        `确认放宽健康条件限制：${relaxed.join("、")}`,
        args,
        () => {
          const checked = precheckProfilePatch(tctx, pid, patch);
          return {
            expectedVersion: checked.version,
            summary: `确认更新健康条件（涉及放宽安全保守项：${relaxed.join("、")}）`,
            preview: { action: "update_conditions_and_choices", conditions: args.conditions, relaxed },
            warnings: checked.warnings,
          };
        },
        commit,
      );
    } catch (err) {
      return wrapToolError(err);
    }
  },
};

const updateScheduleAndSegmentTool: BusinessToolDef<{
  segments?: Record<string, unknown>[];
  product?: string;
  stage?: string;
  age?: string;
  venue?: string;
  wake?: string;
  bedtime?: string;
  timezone?: string;
}> = {
  name: "update_schedule_and_segment",
  highRisk: true,
  description: "更新段周次推进（segments）、跨段/升学/换场地（product/stage/age/venue）、作息时间（wake/bedtime）或时区（timezone）。高危操作：对话中先校验并生成带明细的确认卡。",
  parameters: z.object({
    segments: z.array(z.record(z.string(), z.unknown())).optional(),
    product: z.string().optional(),
    stage: z.string().optional(),
    age: z.string().optional(),
    venue: z.string().optional(),
    wake: z.string().optional(),
    bedtime: z.string().optional(),
    timezone: z.string().optional(),
  }),
  async execute(args, tctx) {
    try {
      const pid = requireBoundProfileId(tctx);
      const patch: Obj = {};
      for (const k of ["segments", "product", "stage", "age", "venue", "wake", "bedtime"] as const) {
        if (args[k] !== undefined) patch[k] = args[k];
      }
      if (!Object.keys(patch).length && !args.timezone) {
        return { ok: false, code: "EMPTY_PATCH", message: "未提供需要更新的段周次、成品、作息或时区字段" };
      }
      return stageOrCommit(
        tctx,
        this.name,
        pid,
        `确认更新训练段/作息配置`,
        args,
        () => {
          const checked = precheckProfilePatch(tctx, pid, patch, args.timezone);
          const lastSeg = Array.isArray(checked.candidate.segments)
            ? checked.candidate.segments[checked.candidate.segments.length - 1]
            : null;
          const parts: string[] = [];
          if (args.product) parts.push(`成品→${args.product}`);
          if (args.segments && lastSeg) {
            parts.push(`当前段→第 ${String(lastSeg.n)} 段第 ${String(lastSeg.week)} 周（${String(lastSeg.phase ?? "起始")}期，${String(lastSeg.start)} 起）`);
          }
          if (args.wake || args.bedtime) parts.push(`作息→起床 ${String(checked.candidate.wake ?? "-")} / 上床 ${String(checked.candidate.bedtime ?? "-")}`);
          if (args.timezone) parts.push(`时区→${args.timezone}`);
          return {
            expectedVersion: checked.version,
            summary: `确认更新训练段/作息：${parts.join("；") || Object.keys(patch).join("、")}`,
            preview: {
              action: "update_schedule_and_segment",
              product: checked.candidate.product,
              latestSegment: lastSeg,
              wake: checked.candidate.wake ?? null,
              bedtime: checked.candidate.bedtime ?? null,
              timezone: args.timezone ?? checked.candidate.timezone,
            },
            warnings: checked.warnings,
          };
        },
        () => {
          const db = tctx.ctx.getDb();
          assertProfileAccess(db, tctx.actor, pid, "manage");
          const res = updateProfileOp(
            db,
            tctx.ctx.templates.current(),
            tctx.actor,
            pid,
            { expectedVersion: tctx.expectedVersion, patch, timezone: args.timezone },
            tctx.ctx.now(),
          );
          return { ok: true, data: { version: res.version, invalidatedCourses: res.invalidatedCourses, warnings: res.warnings } };
        },
      );
    } catch (err) {
      return wrapToolError(err);
    }
  },
};

const updateBodyAndPlaybackTool: BusinessToolDef<{
  body?: "记" | "不记" | "停记";
  bodyLog?: { date: string; body: "记" | "不记" | "停记" }[];
  bodyStopDate?: string;
  playback?: { breathLead?: number | "all"; breathAfter?: "quiet" | "pluck"; countTiming?: "on-up" | "on-rep" };
}> = {
  name: "update_body_and_playback",
  description: "更新 18–64 岁体重腰围记录开关（body/bodyLog/bodyStopDate）或播放偏好（playback）。",
  parameters: z.object({
    body: z.enum(["记", "不记", "停记"]).optional(),
    bodyLog: z.array(z.object({ date: DATE_STR, body: z.enum(["记", "不记", "停记"]) })).optional(),
    bodyStopDate: DATE_STR.optional(),
    playback: z
      .object({
        breathLead: z.union([z.number().int().min(0).max(10), z.literal("all")]).optional(),
        breathAfter: z.enum(["quiet", "pluck"]).optional(),
        countTiming: z.enum(["on-up", "on-rep"]).optional(),
      })
      .optional(),
  }),
  async execute(args, tctx) {
    try {
      const pid = requireBoundProfileId(tctx);
      const db = tctx.ctx.getDb();
      const meta = assertProfileAccess(db, tctx.actor, pid, "manage");
      const before = JSON.parse(meta.profile_json) as Obj;
      const patch: Obj = {};
      if (args.body !== undefined) patch.body = args.body;
      if (args.bodyLog !== undefined) patch.bodyLog = args.bodyLog;
      if (args.bodyStopDate !== undefined) patch.bodyStopDate = args.bodyStopDate;
      if (args.playback !== undefined) patch.playback = { ...(before.playback ?? {}), ...args.playback };
      if (!Object.keys(patch).length) return { ok: false, code: "EMPTY_PATCH", message: "未提供需要更新的身体记录开关或播放偏好" };
      const res = updateProfileOp(
        db,
        tctx.ctx.templates.current(),
        tctx.actor,
        pid,
        { expectedVersion: meta.version, patch },
        tctx.ctx.now(),
      );
      return { ok: true, data: { version: res.version, warnings: res.warnings } };
    } catch (err) {
      return wrapToolError(err);
    }
  },
};

// ---------- 写入域 3：提交评估（服务端强制重算 conclusion + 防盲签高危确认卡） ----------

const submitAssessmentTool: BusinessToolDef<{ record: Record<string, unknown>; logicalPath?: string }> = {
  name: "submit_assessment",
  highRisk: true,
  description: "提交入门/段末/周期末/触发评估记录；后端强制按规则重算 conclusion 覆盖模型输入。高危操作：对话中先重算并生成含权威结论的确认卡。",
  parameters: z.object({
    record: z.record(z.string(), z.unknown()).describe("评估记录 JSON（无需手填 conclusion，后端权威重算）"),
    logicalPath: z.string().optional(),
  }),
  async execute(args, tctx) {
    try {
      const pid = requireBoundProfileId(tctx);
      const rawRecord: Obj = { ...args.record, schema: ASSESS_FORMAT };
      delete rawRecord.conclusion;
      const kind = String(rawRecord.kind ?? "");
      const date = String(rawRecord.date ?? "");
      const previewPath = args.logicalPath ?? `评估/${date}-${kind}.json`;

      return stageOrCommit(
        tctx,
        this.name,
        pid,
        `确认提交「${kind}」评估（${date}）`,
        args,
        () => {
          const db = tctx.ctx.getDb();
          const meta = assertProfileAccess(db, tctx.actor, pid, "manage");
          const state = loadProfileState(db, pid);
          const snap = tctx.ctx.templates.current();
          const now = tctx.ctx.now();
          const ev = evaluateAssessment(state.bundle, snap, kind, { name: previewPath, raw: rawRecord }, { now });
          if (ev.error) throw new AppError(422, "ASSESSMENT_VALIDATION_FAILED", ev.error);
          const errs = ev.issues.filter((i) => i.level === "error");
          if (errs.length) throw new AppError(422, "ASSESSMENT_VALIDATION_FAILED", "评估记录未通过校验", { issues: ev.issues });
          const computedConclusion = ev.conclusion ?? {};
          const finalRecord = { ...rawRecord, conclusion: computedConclusion };
          const nextState = loadProfileState(db, pid, { extraAssessments: [{ name: previewPath, raw: finalRecord }] });
          const fullAudit = auditProfileBundle(
            { ...nextState.bundle, courses: nextState.bundle.courses.filter((c) => c.archived) },
            snap,
            { now },
          );
          const fullErrs = fullAudit.filter((i) => i.level === "error");
          if (fullErrs.length) {
            throw new AppError(422, "ASSESSMENT_VALIDATION_FAILED", "评估记录与档案整体规则冲突", { issues: fullAudit });
          }
          return {
            expectedVersion: meta.version,
            summary: `确认提交「${kind}」评估（${date}），服务端重算结论：${JSON.stringify(computedConclusion)}`,
            preview: {
              action: "submit_assessment",
              kind,
              date,
              logicalPath: previewPath,
              computedConclusion,
              tests: rawRecord.tests ?? null,
              reasons: rawRecord.reasons ?? null,
            },
            warnings: [...ev.issues, ...fullAudit].filter((i) => i.level === "warning"),
          };
        },
        () => {
          const db = tctx.ctx.getDb();
          assertProfileAccess(db, tctx.actor, pid, "manage");
          const res = submitAssessmentOp(
            db,
            tctx.ctx.templates.current(),
            tctx.actor,
            pid,
            { ...args, expectedVersion: tctx.expectedVersion },
            tctx.ctx.now(),
          );
          return {
            ok: true,
            data: {
              id: res.id,
              logicalPath: res.logicalPath,
              conclusion: res.assessment.conclusion,
              version: res.version,
              invalidatedCourses: res.invalidatedCourses,
            },
          };
        },
      );
    } catch (err) {
      return wrapToolError(err);
    }
  },
};

// ---------- 写入域 4：提交周复盘 / 保存月度总结 ----------

const submitWeeklyReviewTool: BusinessToolDef<{
  startDate: string;
  week: number;
  reviewJson: Record<string, unknown>;
  reviewMd: string;
  nextSegmentEntry?: Record<string, unknown>;
}> = {
  name: "submit_weekly_review",
  highRisk: true,
  description: "成对提交本周复盘数据（.json）与带免责声明的复盘正文（.md），可选附带 nextSegmentEntry 同事务推进下一周。高危操作：对话中先校验并生成带明细的确认卡。",
  parameters: z.object({
    startDate: DATE_STR,
    week: z.number().int().min(1).max(12),
    reviewJson: z.record(z.string(), z.unknown()),
    reviewMd: z.string().min(1),
    nextSegmentEntry: z.record(z.string(), z.unknown()).optional(),
  }),
  async execute(args, tctx) {
    try {
      const pid = requireBoundProfileId(tctx);
      return stageOrCommit(
        tctx,
        this.name,
        pid,
        `确认提交第 ${args.week} 周复盘（${args.startDate}）`,
        args,
        () => {
          const db = tctx.ctx.getDb();
          const meta = assertProfileAccess(db, tctx.actor, pid, "manage");
          const before = JSON.parse(meta.profile_json) as Obj;
          const candidate: Obj = { ...before };
          if (args.nextSegmentEntry) {
            candidate.segments = [...(Array.isArray(before.segments) ? before.segments : []), args.nextSegmentEntry];
          }
          const rj: Obj = { ...args.reviewJson, schema: REVIEW_FORMAT, start: args.startDate, week: args.week };
          const state = loadProfileState(db, pid, {
            profile: candidate,
            extraReviews: [{ startDate: args.startDate, week: args.week, json: rj, md: args.reviewMd }],
          });
          const issues = auditProfileBundle(
            { ...state.bundle, courses: state.bundle.courses.filter((c) => c.archived) },
            tctx.ctx.templates.current(),
            { now: tctx.ctx.now() },
          );
          const errs = issues.filter((i) => i.level === "error");
          if (errs.length) throw new AppError(422, "REVIEW_VALIDATION_FAILED", "周复盘未通过规则校验", { issues });
          const symLabel = rj.symptoms ? "有不适" : "无不适";
          const nextLabel = args.nextSegmentEntry
            ? `，并推进至第 ${String(args.nextSegmentEntry.n ?? "")} 段第 ${String(args.nextSegmentEntry.week ?? "")} 周（${String(args.nextSegmentEntry.start ?? "")} 起）`
            : "";
          return {
            expectedVersion: meta.version,
            summary: `确认提交第 ${args.week} 周复盘（${args.startDate}，训练 ${String(rj.trainings ?? "-")} 次，${symLabel}）${nextLabel}`,
            preview: {
              action: "submit_weekly_review",
              startDate: args.startDate,
              week: args.week,
              trainings: rj.trainings ?? null,
              symptoms: !!rj.symptoms,
              nextSegmentEntry: args.nextSegmentEntry ?? null,
            },
            warnings: issues.filter((i) => i.level === "warning"),
          };
        },
        () => {
          const db = tctx.ctx.getDb();
          assertProfileAccess(db, tctx.actor, pid, "manage");
          const res = submitReviewOp(
            db,
            tctx.ctx.templates.current(),
            tctx.actor,
            pid,
            { ...args, expectedVersion: tctx.expectedVersion },
            tctx.ctx.now(),
          );
          return { ok: true, data: { id: res.id, version: res.version, invalidatedCourses: res.invalidatedCourses } };
        },
      );
    } catch (err) {
      return wrapToolError(err);
    }
  },
};

const saveMonthlySummaryTool: BusinessToolDef<{ contentMd: string }> = {
  name: "save_monthly_summary",
  description: "保存起始期第 4 周结束时的月度总结（必须开头带免责声明并通过红线校验）。",
  parameters: z.object({ contentMd: z.string().min(1) }),
  async execute(args, tctx) {
    try {
      const pid = requireBoundProfileId(tctx);
      const db = tctx.ctx.getDb();
      assertProfileAccess(db, tctx.actor, pid, "manage");
      const res = saveDocumentOp(
        db,
        tctx.ctx.templates.current(),
        tctx.actor,
        pid,
        { docType: "monthly_summary", title: "月度总结", contentMd: args.contentMd },
        tctx.ctx.now(),
      );
      return { ok: true, data: res };
    } catch (err) {
      return wrapToolError(err);
    }
  },
};

// ---------- 写入域 5：确定性生成个人计划单 ----------

const generatePlanSheetTool: BusinessToolDef<Record<string, never>> = {
  name: "generate_plan_sheet",
  description: "调用规则引擎确定性生成当前周个人计划单（含每日训练、有氧稳态/间歇、习惯达标线、下次评估与免责声明），严禁手写计划单。",
  parameters: z.object({}),
  async execute(_args, tctx) {
    try {
      const pid = requireBoundProfileId(tctx);
      const db = tctx.ctx.getDb();
      assertProfileAccess(db, tctx.actor, pid, "manage");
      const res = generatePlanSheetOp(db, tctx.ctx.templates.current(), tctx.actor, pid, undefined, tctx.ctx.now());
      return { ok: true, data: { id: res.id, file: res.file, version: res.version, excerpt: res.contentMd.slice(0, 1800) } };
    } catch (err) {
      return wrapToolError(err);
    }
  },
};

// ---------- 写入域 6：发布跟练课程（65+ 确认无摔倒时强制两阶段确认卡防模型代确认） ----------

const publishCourseTool: BusinessToolDef<{
  week: number;
  day: string;
  picks?: Record<string, string>;
  half?: boolean;
  confirmedNoFall?: boolean;
}> = {
  name: "publish_course",
  description: "按当前档案与训练单发布指定周次的跟练课程交付信封供手机端拉取；65 岁以上传 confirmedNoFall: true 时必须走确认卡由本人/家人确认。",
  parameters: z.object({
    week: z.number().int().min(1).max(12),
    day: z.string().min(1).max(20),
    picks: z.record(z.string(), z.string()).optional(),
    half: z.boolean().optional(),
    confirmedNoFall: z.boolean().optional(),
  }),
  async execute(args, tctx) {
    try {
      const pid = requireBoundProfileId(tctx);
      const db = tctx.ctx.getDb();
      const meta = assertProfileAccess(db, tctx.actor, pid, "manage");
      const profile = JSON.parse(meta.profile_json) as Obj;
      const isSeniorNoFall = profile.age === "a65" && args.confirmedNoFall === true;

      const commit = (): ToolExecutionResult => {
        const curDb = tctx.ctx.getDb();
        assertProfileAccess(curDb, tctx.actor, pid, "manage");
        const res = publishCourseOp(
          curDb,
          tctx.ctx.templates.current(),
          tctx.actor,
          pid,
          { ...args, expectedVersion: tctx.expectedVersion },
          tctx.ctx.now(),
        );
        return {
          ok: true,
          data: {
            courseRecordId: res.id,
            courseName: res.envelope.course.name,
            declaration: res.envelope.declaration,
            follow: res.envelope.follow,
            notes: res.envelope.notes,
            warnings: res.warnings,
          },
        };
      };

      if (!isSeniorNoFall) return commit();

      return stageOrCommit(
        tctx,
        this.name,
        pid,
        `确认 65 岁以上近期无摔倒/差点摔倒/头晕，并发布第 ${args.week} 周 ${args.day} 日课程`,
        args,
        () => ({
          expectedVersion: meta.version,
          summary: `请本人或家人确认近期未发生摔倒、差点摔倒或头晕，确认后发布第 ${args.week} 周 ${args.day} 日${args.half ? "（半量）" : ""}课程`,
          preview: {
            action: "publish_course_senior_no_fall",
            week: args.week,
            day: args.day,
            half: !!args.half,
            confirmedNoFall: true,
          },
        }),
        commit,
      );
    } catch (err) {
      return wrapToolError(err);
    }
  },
};

// ---------- 写入域 7：保存全家菜单（隔离本档案 household + 声明 + 红线） ----------

const saveMealPlanTool: BusinessToolDef<{ title: string; contentMd: string }> = {
  name: "save_meal_plan",
  description: "保存全家一周菜单与采购清单：强校验档案已填 household、开头含免责声明、通过全家与各成员年龄段（含满 65 岁当月）安全红线。",
  parameters: z.object({
    title: z.string().min(1).max(80).describe("菜单标题，如 第1周"),
    contentMd: z.string().min(1).describe("以养夏免责声明开头的完整 Markdown 菜单"),
  }),
  async execute(args, tctx) {
    try {
      const pid = requireBoundProfileId(tctx);
      const db = tctx.ctx.getDb();
      assertProfileAccess(db, tctx.actor, pid, "manage");
      const res = saveDocumentOp(
        db,
        tctx.ctx.templates.current(),
        tctx.actor,
        pid,
        { docType: "menu", title: args.title, contentMd: args.contentMd },
        tctx.ctx.now(),
      );
      return { ok: true, data: res };
    } catch (err) {
      return wrapToolError(err);
    }
  },
};

// ---------- 写入域 8：归档已完成历史段（高危确认卡） ----------

const archiveSegmentTool: BusinessToolDef<{ segment: number }> = {
  name: "archive_segment",
  highRisk: true,
  description: "将已结束的历史段（段号必须小于当前段）归档。高危操作：对话中先校验并生成确认卡。",
  parameters: z.object({ segment: z.number().int().min(1) }),
  async execute(args, tctx) {
    try {
      const pid = requireBoundProfileId(tctx);
      return stageOrCommit(
        tctx,
        this.name,
        pid,
        `确认将第 ${args.segment} 段的课程、记录、复盘和评估归档至历史`,
        args,
        () => {
          const db = tctx.ctx.getDb();
          const meta = assertProfileAccess(db, tctx.actor, pid, "manage");
          const profile = JSON.parse(meta.profile_json) as Obj;
          const curSeg = currentSegment(profile)?.n ?? 1;
          if (args.segment < 1 || args.segment >= curSeg) {
            throw new AppError(422, "INVALID_ARCHIVE_SEGMENT", `只能归档小于当前第 ${curSeg} 段的历史段`);
          }
          return {
            expectedVersion: meta.version,
            summary: `确认将第 ${args.segment} 段（当前已进入第 ${curSeg} 段）的所有课程、记录、复盘与评估归档至历史`,
            preview: { action: "archive_segment", segment: args.segment, currentSegment: curSeg },
            warnings: [],
          };
        },
        () => {
          const db = tctx.ctx.getDb();
          assertProfileAccess(db, tctx.actor, pid, "manage");
          const res = archiveSegmentOp(
            db,
            tctx.ctx.templates.current(),
            tctx.actor,
            pid,
            args.segment,
            tctx.expectedVersion,
            tctx.ctx.now(),
          );
          return { ok: true, data: res };
        },
      );
    } catch (err) {
      return wrapToolError(err);
    }
  },
};

export const ALL_BUSINESS_TOOLS: BusinessToolDef<any>[] = [
  getProfileStateTool,
  getIntakeAndBedtimeTool,
  inspectAssessmentTool,
  readTemplateSectionTool,
  createProfileTool,
  updateScreeningAndDoctorTool,
  updateProgressLogTool,
  updateConditionsAndChoicesTool,
  updateScheduleAndSegmentTool,
  updateBodyAndPlaybackTool,
  submitAssessmentTool,
  submitWeeklyReviewTool,
  saveMonthlySummaryTool,
  generatePlanSheetTool,
  publishCourseTool,
  saveMealPlanTool,
  archiveSegmentTool,
];

export const BUSINESS_TOOL_MAP = new Map<string, BusinessToolDef<any>>(
  ALL_BUSINESS_TOOLS.map((t) => [t.name, t]),
);
