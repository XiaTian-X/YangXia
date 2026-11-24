// 服务端集成测试助手：内存 SQLite + 低成本测试 scrypt + 可注入时钟 + 真模板/离线样例自动加载。
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROFILE_FORMAT,
  type Manifest,
  type MotionsData,
  type PlansData,
  type RulesData,
} from "@yangxia/course-core";
import { templatesDir } from "@yangxia/course-core/node";
import { createApp } from "../src/app.ts";
import { createTrustedProxyMatcher, type ServerConfig } from "../src/config.ts";
import { createServerContext, type ServerContext } from "../src/context.ts";
import { openDatabase } from "../src/db/database.ts";
import { TemplatesManager, type TemplatesSnapshot } from "../src/templates/manager.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const FIX = join(REPO_ROOT, "contracts", "fixtures");

export const FAST_SCRYPT = { N: 1024, r: 8, p: 1, keylen: 64 };

function loadFixtureSnapshot(): TemplatesSnapshot {
  const manifest = JSON.parse(readFileSync(join(FIX, "manifest.json"), "utf8")) as Manifest;
  const plans = JSON.parse(readFileSync(join(FIX, "data", "plans.json"), "utf8")) as PlansData;
  const rules = JSON.parse(readFileSync(join(FIX, "data", "rules.json"), "utf8")) as RulesData;
  const motions = JSON.parse(readFileSync(join(FIX, "data", "motions.json"), "utf8")) as MotionsData;
  const motionIndex = Object.fromEntries(
    Object.entries(motions.clips).map(([id, clip]) => [id, { id, clip, hash: `fix-${id}`, sizeBytes: JSON.stringify(clip).length }]),
  );
  const motionHashes = Object.fromEntries(Object.keys(motions.clips).map((id) => [id, `fix-${id}`]));
  return {
    manifest,
    plans,
    rules,
    motions,
    readProduct: () => null,
    version: manifest.version,
    dir: FIX,
    templateHash: "fixture-template-hash",
    motionIndex,
    motionHashes,
    loadedAt: new Date().toISOString(),
    listDocs: () => [],
    readDoc: () => null,
    resolveImage: () => null,
  };
}

let cachedRealManager: TemplatesSnapshot | null = null;
async function getSnapshot(preferReal = true): Promise<TemplatesSnapshot> {
  if (preferReal && (await templatesDir())) {
    if (!cachedRealManager) {
      const mgr = await TemplatesManager.create();
      cachedRealManager = mgr.current();
    }
    return cachedRealManager;
  }
  return loadFixtureSnapshot();
}

export interface TestResponse extends Response {
  json(): Promise<any>;
}

export interface TestServerHandle {
  app: ReturnType<typeof createApp>;
  ctx: ServerContext;
  tempDir: string;
  setNow(d: Date): void;
  getNow(): Date;
  req(path: string, init?: RequestInit & { token?: string; cookie?: string; csrf?: boolean; origin?: string; remoteIp?: string }): Promise<TestResponse>;
  cleanup(): void;
}

export async function createTestServer(opts: {
  now?: Date;
  trustedProxies?: string;
  migrateDir?: string;
  fileBackedDb?: boolean;
  masterKey?: Buffer;
  customReloadLoader?: () => Promise<TemplatesSnapshot>;
} = {}): Promise<TestServerHandle> {
  const tempDir = mkdtempSync(join(tmpdir(), "yangxia-srv-test-"));
  const dbPath = opts.fileBackedDb ? join(tempDir, "yangxia.sqlite") : ":memory:";
  const db = openDatabase(dbPath);
  let curNow = opts.now ?? new Date("2026-11-02T03:00:00.000Z");

  const snap = await getSnapshot(true);
  const templates = new TemplatesManager(snap, { customLoader: opts.customReloadLoader });

  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir: tempDir,
    dbPath,
    masterKeyPath: join(tempDir, "master.key"),
    backupDir: join(tempDir, "backups"),
    migrateDir: opts.migrateDir,
    trustedProxies: createTrustedProxyMatcher(opts.trustedProxies),
    backupPassphrase: "auto-backup-passphrase-1234",
    defaultTimezone: "Asia/Shanghai",
  };

  const ctx = createServerContext({
    db,
    config,
    templates,
    masterKey: opts.masterKey ?? randomBytes(32),
    scrypt: FAST_SCRYPT,
    now: () => curNow,
  });

  const app = createApp(ctx);

  async function req(
    path: string,
    init: RequestInit & { token?: string; cookie?: string; csrf?: boolean; origin?: string; remoteIp?: string } = {},
  ): Promise<TestResponse> {
    const headers = new Headers(init.headers);
    if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
    if (init.cookie) headers.set("Cookie", init.cookie);
    if (init.csrf) headers.set("X-YangXia-CSRF", "1");
    if (init.origin) headers.set("Origin", init.origin);
    const url = path.startsWith("http") ? path : `http://localhost${path}`;
    const env = init.remoteIp ? { incoming: { socket: { remoteAddress: init.remoteIp } } } : { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
    return (await app.request(url, { ...init, headers }, env)) as TestResponse;
  }

  return {
    app,
    ctx,
    tempDir,
    setNow(d: Date) {
      curNow = d;
    },
    getNow() {
      return curNow;
    },
    req,
    cleanup() {
      ctx.close();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

export function extractSessionCookie(res: Response): string {
  const sc = res.headers.get("set-cookie") ?? "";
  const m = /yx_session=([^;]+)/.exec(sc);
  if (!m) throw new Error(`未找到 yx_session Cookie：${sc}`);
  return `yx_session=${m[1]}`;
}

export function screeningAllNo(manifest: Manifest, age: string, date = "2026-11-02", doctorCleared = false) {
  const items = manifest.intake.screening.find((s) => s.age === age)?.items ?? ["心脏病"];
  return {
    answers: items.map((item) => ({ item, answer: "否" as const })),
    doctorCleared,
    date,
    ...(doctorCleared ? { doctorDate: date } : {}),
  };
}

export function makeA18HomeProfile(manifest: Manifest, code = "测试甲", patch: Record<string, any> = {}) {
  return {
    schema: PROFILE_FORMAT,
    code,
    stage: "18–39 岁",
    age: "a18",
    venue: "home",
    product: "18-39岁-居家版",
    birth: "1995-05",
    body: "不记",
    timezone: "Asia/Shanghai",
    startDate: "2026-11-02",
    segments: [{ n: 1, type: "标准", week: 1, start: "2026-11-02", product: "18-39岁-居家版" }],
    screening: screeningAllNo(manifest, "a18", "2026-11-02", false),
    conditions: { 高血压: false, 没地方跳: false },
    choices: ["table-row"],
    progress: {},
    progressLog: [],
    ...patch,
  };
}

export function makeA13Profile(manifest: Manifest, code = "测试青", patch: Record<string, any> = {}) {
  return {
    schema: PROFILE_FORMAT,
    code,
    stage: "初中",
    age: "a13",
    venue: "bw",
    product: "13-17岁-纯徒手版",
    school: { stage: "初中", entry: 2025 },
    timezone: "Asia/Shanghai",
    startDate: "2026-11-02",
    segments: [{ n: 1, type: "标准", week: 1, start: "2026-11-02", product: "13-17岁-纯徒手版" }],
    screening: screeningAllNo(manifest, "a13", "2026-11-02", false),
    conditions: { 家长在旁边: true },
    choices: ["table-row"],
    progress: {},
    progressLog: [],
    ...patch,
  };
}

export function makeA65Profile(manifest: Manifest, code = "测试长", patch: Record<string, any> = {}) {
  return {
    schema: PROFILE_FORMAT,
    code,
    stage: "65 岁以上",
    age: "a65",
    venue: "chair",
    product: "65岁以上-椅子辅助版",
    birth: "1956-05",
    habitBase: { 散步: 20 },
    timezone: "Asia/Shanghai",
    startDate: "2026-11-02",
    segments: [{ n: 1, type: "标准", week: 1, start: "2026-11-02", product: "65岁以上-椅子辅助版" }],
    screening: screeningAllNo(manifest, "a65", "2026-11-02", true),
    conditions: { 家里没有别人: false },
    progress: {},
    progressLog: [],
    ...patch,
  };
}

export function makeA06Profile(manifest: Manifest, code = "测试童", patch: Record<string, any> = {}) {
  return {
    schema: PROFILE_FORMAT,
    code,
    stage: "小学",
    age: "a06",
    venue: "play",
    product: "6-12岁-户外与游戏版（家长版）",
    school: { stage: "小学", entry: 2023 },
    timezone: "Asia/Shanghai",
    startDate: "2026-11-02",
    segments: [{ n: 1, type: "标准", week: 1, start: "2026-11-02", product: "6-12岁-户外与游戏版（家长版）" }],
    screening: screeningAllNo(manifest, "a06", "2026-11-02", false),
    ...patch,
  };
}
