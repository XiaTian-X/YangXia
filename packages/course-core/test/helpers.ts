import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "../src/manifest.ts";
import type { Course } from "../src/types.ts";

export const FIX = new URL("../../../contracts/fixtures/", import.meta.url).pathname;
export const CONTRACTS = new URL("../../../contracts/", import.meta.url).pathname;

export const readJson = <T = unknown>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

export function courseFixtures(prefix: "ok-" | "bad-"): [string, unknown][] {
  return readdirSync(join(FIX, "courses"))
    .filter((f) => f.startsWith(prefix))
    .sort()
    .map((f) => [f, readJson(join(FIX, "courses", f))]);
}

export const okCourse = (name: string) => readJson<Course>(join(FIX, "courses", name));
export const fixtureManifest = () => readJson<Manifest>(join(FIX, "manifest.json"));

export function fixtureReadProduct(name: string): string | null {
  const f = join(FIX, "products", `${name}.md`);
  return existsSync(f) ? readFileSync(f, "utf8") : null;
}

export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

import type { PlansData, RulesData } from "../src/plan.ts";
export const fixturePlans = () => readJson<PlansData>(join(FIX, "data", "plans.json"));
export const fixtureRules = () => readJson<RulesData>(join(FIX, "data", "rules.json"));

/** 按年龄段补齐跨段推算要用的资料：成年人的出生年月、未成年人的学段（测试用的虚构值）。 */
export function fitAge(p: Record<string, any>, age: string, stage?: string): Record<string, any> {
  delete p.birth;
  delete p.school;
  if (age === "a06") p.school = { stage: "小学", entry: 2023 };
  else if (age === "a13") p.school = stage === "高中" ? { stage: "高中", entry: 2025 } : { stage: "初中", entry: 2025 };
  else p.birth = { a18: "1996-05", a40: "1976-05", a65: "1956-05" }[age];
  if (age !== "a18" && age !== "a40") delete p.body;
  if (age === "a65") p.habitBase = { 散步: 20 };
  else delete p.habitBase;
  return p;
}
