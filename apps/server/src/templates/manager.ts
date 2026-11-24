// 模板快照只读管理器与原子热重载（先构造不可变快照校验通过再替换指针，随后逐档案独立检测作废课程）。
import type { DatabaseSync } from "node:sqlite";
import {
  detectInvalidatedCourses,
  MANIFEST_FORMAT,
  PLANS_FORMAT,
  RULES_FORMAT,
  type TemplateBundle,
} from "@yangxia/course-core";
import { loadTemplates, type MotionIndexEntry, type Templates } from "@yangxia/course-core/node";
import { writeAuditLog } from "../db/audit.ts";
import { loadProfileState } from "../db/bundle.ts";
import { AppError, withProfileLock } from "../db/lock.ts";

export interface TemplatesSnapshot extends TemplateBundle {
  version: string;
  dir: string;
  templateHash: string;
  motionIndex: Record<string, MotionIndexEntry>;
  motionHashes: Record<string, string>;
  loadedAt: string;
  listDocs: () => string[];
  readDoc: (name: string) => string | null;
  resolveImage: (file: string) => string | null;
}

function toSnapshot(loaded: Templates, loadedAt: string): TemplatesSnapshot {
  if (loaded.manifest?.format !== MANIFEST_FORMAT) {
    throw new AppError(500, "TEMPLATE_INVALID", `模板 manifest 格式不匹配：${loaded.manifest?.format}`);
  }
  if (!loaded.plans || loaded.plans.format !== PLANS_FORMAT) {
    throw new AppError(500, "TEMPLATE_INVALID", "模板缺少合法的 plans.json");
  }
  if (!loaded.rules || loaded.rules.format !== RULES_FORMAT) {
    throw new AppError(500, "TEMPLATE_INVALID", "模板缺少合法的 rules.json");
  }
  return {
    manifest: loaded.manifest,
    readProduct: loaded.readProduct,
    plans: loaded.plans,
    rules: loaded.rules,
    motions: loaded.motions,
    version: loaded.manifest.version,
    dir: loaded.dir,
    templateHash: loaded.templateHash,
    motionIndex: loaded.motionIndex,
    motionHashes: loaded.motionHashes,
    loadedAt,
    listDocs: loaded.listDocs,
    readDoc: loaded.readDoc,
    resolveImage: loaded.resolveImage,
  };
}

export interface ReloadResult {
  previousVersion: string;
  version: string;
  templateHash: string;
  profilesChecked: number;
  coursesInvalidated: number;
}

export class TemplatesManager {
  private snapshot: TemplatesSnapshot;
  private readonly explicitDir?: string;
  private readonly customLoader?: () => Promise<TemplatesSnapshot>;

  constructor(initial: TemplatesSnapshot, opts?: { explicitDir?: string; customLoader?: () => Promise<TemplatesSnapshot> }) {
    this.snapshot = initial;
    this.explicitDir = opts?.explicitDir;
    this.customLoader = opts?.customLoader;
  }

  static async create(explicitDir?: string): Promise<TemplatesManager> {
    const loaded = await loadTemplates(explicitDir);
    return new TemplatesManager(toSnapshot(loaded, new Date().toISOString()), { explicitDir });
  }

  current(): TemplatesSnapshot {
    return this.snapshot;
  }

  /**
   * 原子重载模板快照，随后逐档案独立加锁执行 detectInvalidatedCourses（避免长事务锁整库；
   * 通过 getDb 延迟取连接，避免 await 期间发生在线恢复热替换导致持旧句柄）。
   */
  async reload(
    getDb: () => DatabaseSync,
    actor: { userId: string; sessionId: string },
    now = new Date(),
  ): Promise<ReloadResult> {
    const prev = this.snapshot;
    const next = this.customLoader
      ? await this.customLoader()
      : toSnapshot(await loadTemplates(this.explicitDir), now.toISOString());

    // 校验通过后原子替换全局只读指针
    this.snapshot = next;

    const db = getDb();
    const profileIds = (db.prepare("SELECT id FROM profiles").all() as { id: string }[]).map((r) => r.id);
    let coursesInvalidated = 0;

    for (const pid of profileIds) {
      const curDb = getDb();
      const count = withProfileLock(curDb, pid, undefined, () => {
        const state = loadProfileState(curDb, pid);
        if (!state.activeCourseItems.length) return 0;
        const invalid = detectInvalidatedCourses(state.bundle, next, state.activeCourseItems, { now });
        if (!invalid.length) return 0;

        const byName = new Map(state.activeCourseItems.map((c) => [c.name, c.rowId]));
        let hit = 0;
        for (const inv of invalid) {
          const rowId = byName.get(inv.name);
          if (!rowId) continue;
          curDb.prepare(
            "UPDATE courses SET status = 'invalidated', invalidated_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'",
          ).run(inv.reason, now.toISOString(), rowId);
          hit += 1;
        }
        if (hit > 0) {
          curDb.prepare("UPDATE profiles SET version = version + 1, updated_at = ? WHERE id = ?").run(now.toISOString(), pid);
          writeAuditLog(curDb, {
            actorUserId: actor.userId,
            actorSessionId: actor.sessionId,
            profileId: pid,
            action: "courses.invalidated_by_template_reload",
            fields: ["courses.status"],
            ruleOrReason: `templates:${next.version}`,
            now,
          });
        }
        return hit;
      });
      coursesInvalidated += count;
    }

    writeAuditLog(getDb(), {
      actorUserId: actor.userId,
      actorSessionId: actor.sessionId,
      profileId: null,
      action: "templates.reload",
      fields: ["template_version", "template_hash"],
      ruleOrReason: `${prev.version}->${next.version}`,
      now,
    });

    return {
      previousVersion: prev.version,
      version: next.version,
      templateHash: next.templateHash,
      profilesChecked: profileIds.length,
      coursesInvalidated,
    };
  }
}
