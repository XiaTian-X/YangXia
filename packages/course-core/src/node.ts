// 只在 Node 里用：按 scripts/templates-path.mjs 的规则找模板仓库，只读完整 templates/dist/ 发布目录
// （manifest、训练单、规则、动图与片段级哈希、成品与附册 .md、img/*.svg）以及课程包工具（package.ts 仅从这里导出）。
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MOTIONS_FORMAT, type MotionClip, type MotionsData } from "./figure-motion.ts";
import { type Manifest, MANIFEST_FORMAT } from "./manifest.ts";
import { PLANS_FORMAT, type PlansData, RULES_FORMAT, type RulesData } from "./plan.ts";

export { PACKAGE_FORMAT, packageInfo, packCourse, unpackCourse, type PackageInfo } from "./package.ts";

const REPO_ROOT = new URL("../../../", import.meta.url);

export async function templatesDir(): Promise<string | null> {
  const mod = (await import(new URL("scripts/templates-path.mjs", REPO_ROOT).href)) as { templatesDir: () => string | null };
  return mod.templatesDir();
}

/** 打包好的编排器（课程包从它出）：环境变量 YANGXIA_SEQUENCER，没设就用 apps/sequencer/dist/养夏跟练编排器.html。 */
export function sequencerPath(): string {
  return process.env.YANGXIA_SEQUENCER
    ? resolve(process.env.YANGXIA_SEQUENCER)
    : join(fileURLToPath(REPO_ROOT), "apps", "sequencer", "dist", "养夏跟练编排器.html");
}

/** 编排器打包标记的算法（scripts/sequencer-stamp.mjs，打包时和这里共用）。 */
export async function sequencerStamp(): Promise<{ sourceHash: () => string | null; motionsHash: (text: string) => string }> {
  return (await import(new URL("scripts/sequencer-stamp.mjs", REPO_ROOT).href)) as { sourceHash: () => string | null; motionsHash: (text: string) => string };
}

export interface MotionIndexEntry {
  id: string;
  clip: MotionClip;
  hash: string;
  sizeBytes: number;
}

export interface Templates {
  dir: string;
  manifest: Manifest;
  readProduct: (name: string) => string | null;
  /** 训练单、规则参数（模板 dist/data/）。模板还没有这两个文件时是 null（v4 之前的模板）。 */
  plans: PlansData | null;
  rules: RulesData | null;
  /** 动作示意动图（dist/data/motions.json）。可选：v3.4 及以前的模板没有。 */
  motions: MotionsData | null;
  /** 模板核心发布物内容哈希（manifest + plans + rules + motions），用于版本兼容与缓存校验。 */
  templateHash: string;
  /** 按片段 ID 索引的动图及其内容哈希（供服务端增量下发）。 */
  motionIndex: Record<string, MotionIndexEntry>;
  /** 片段 ID → SHA-256 哈希映射（供 CourseDeliveryEnvelope 使用）。 */
  motionHashes: Record<string, string>;
  /** 列出 dist/ 下所有可读的成品/附册/菜谱 .md 文件名（不含扩展名）。 */
  listDocs: () => string[];
  /** 安全读取 dist/<name>.md（防路径穿越）。 */
  readDoc: (name: string) => string | null;
  /** 安全解析 dist/img/<file> 的真实路径（防路径穿越和符号链接逃逸）；不存在或越界返回 null。 */
  resolveImage: (file: string) => string | null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function safeChildPath(baseDirReal: string, candidate: string): string | null {
  if (!existsSync(candidate)) return null;
  try {
    const real = realpathSync(candidate);
    if (real === baseDirReal || !real.startsWith(baseDirReal + sep)) return null;
    if (!statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

/** 从指定模板目录（或默认 templatesDir）加载完整模板只读发布物快照。 */
export async function loadTemplates(explicitDir?: string): Promise<Templates> {
  const dir = explicitDir ? resolve(explicitDir) : await templatesDir();
  if (!dir) {
    throw new Error("没找到模板仓库：把 YangXia-templates 放在 templates/，或设置环境变量 YANGXIA_TEMPLATES");
  }
  const distDir = join(dir, "dist");
  const path = join(distDir, "manifest.json");
  if (!existsSync(path)) throw new Error(`模板还没构建：${path} 不存在，先在模板仓库运行 python3 tpl.py all`);
  const distReal = realpathSync(distDir);
  const imgDir = join(distDir, "img");
  const imgReal = existsSync(imgDir) ? realpathSync(imgDir) : null;

  const manifestText = readFileSync(path, "utf8");
  const manifest = JSON.parse(manifestText) as Manifest;
  if (manifest.format !== MANIFEST_FORMAT) {
    throw new Error(`模板 manifest 的格式是「${manifest.format ?? "（没有）"}」，需要 ${MANIFEST_FORMAT}：请先更新模板仓库`);
  }

  const hashAcc = createHash("sha256");
  hashAcc.update("manifest\0").update(manifestText).update("\0");

  const readData = <T extends { format: string }>(file: string, format: string): { data: T; text: string } | null => {
    const f = join(distDir, "data", file);
    if (!existsSync(f)) return null;
    const text = readFileSync(f, "utf8");
    const d = JSON.parse(text) as T;
    if (d.format !== format) throw new Error(`模板 ${file} 的格式是「${d.format}」，需要 ${format}：请先更新模板仓库`);
    return { data: d, text };
  };

  const plansRes = readData<PlansData>("plans.json", PLANS_FORMAT);
  const rulesRes = readData<RulesData>("rules.json", RULES_FORMAT);
  if (plansRes) hashAcc.update("plans\0").update(plansRes.text).update("\0");
  if (rulesRes) hashAcc.update("rules\0").update(rulesRes.text).update("\0");

  // 动图是可选的：格式不认识时只是没有动图，不影响导出和检查
  let motions: MotionsData | null = null;
  const motionIndex: Record<string, MotionIndexEntry> = {};
  const motionHashes: Record<string, string> = {};
  try {
    const mr = readData<MotionsData>("motions.json", MOTIONS_FORMAT);
    if (mr) {
      motions = mr.data;
      hashAcc.update("motions\0").update(mr.text).update("\0");
      for (const [id, clip] of Object.entries(motions.clips ?? {})) {
        const serialized = JSON.stringify(clip);
        const h = sha256(serialized);
        motionIndex[id] = { id, clip, hash: h, sizeBytes: Buffer.byteLength(serialized, "utf8") };
        motionHashes[id] = h;
      }
    }
  } catch {
    motions = null;
  }

  const readDoc = (name: string): string | null => {
    if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) return null;
    const fileName = name.endsWith(".md") ? name : `${name}.md`;
    const safe = safeChildPath(distReal, join(distDir, fileName));
    return safe ? readFileSync(safe, "utf8") : null;
  };
  const readProduct = (name: string) => readDoc(name);

  const listDocs = (): string[] => {
    return readdirSync(distDir)
      .filter((f) => f.endsWith(".md") && safeChildPath(distReal, join(distDir, f)) !== null)
      .map((f) => f.slice(0, -3))
      .sort();
  };

  const resolveImage = (file: string): string | null => {
    if (!imgReal || !file || file.includes("/") || file.includes("\\") || file.includes("..")) return null;
    return safeChildPath(imgReal, join(imgDir, file));
  };

  return {
    dir,
    manifest,
    readProduct,
    plans: plansRes?.data ?? null,
    rules: rulesRes?.data ?? null,
    motions,
    templateHash: hashAcc.digest("hex"),
    motionIndex,
    motionHashes,
    listDocs,
    readDoc,
    resolveImage,
  };
}

/** 训练单和规则参数：导出课程、核对进度要用，没有就提示先更新模板。 */
export function requirePlans(t: Templates): { plans: PlansData; rules: RulesData } {
  if (!t.plans || !t.rules) throw new Error("模板还没有训练单（dist/data/plans.json、rules.json）：先把模板仓库更新到 v4 阶段 1 之后，再运行 python3 tpl.py all");
  return { plans: t.plans, rules: t.rules };
}
