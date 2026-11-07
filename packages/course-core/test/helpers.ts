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
