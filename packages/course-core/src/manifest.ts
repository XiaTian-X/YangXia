// 模板 manifest（yangxia.manifest/1）里课程核心库用到的部分。完整字段见模板 docs/架构说明.md 第十节。
import type { RedlineRules } from "./redlines.ts";

export const MANIFEST_FORMAT = "yangxia.manifest/1";

export interface ManifestProduct {
  file: string;
  name: string;
  age: string;
  venue: string;
}

export interface ExerciseUse {
  product: string;
  code: string;
  title: string;
  prescription: string;
  breathing: string;
  line: number;
}

export interface ManifestExercise {
  id: string;
  name: string;
  aliases: string[];
  short: string;
  mode: "reps" | "timed";
  per_side: boolean;
  figure: string;
  used: string[];
  used_in: ExerciseUse[];
}

export interface IntakeScreening {
  age: string;
  product: string;
  heading: string;
  kind: "any" | "all";
  rule: string;
  items: string[];
}

export interface Manifest {
  format: string;
  version: string;
  products: ManifestProduct[];
  exercises: ManifestExercise[];
  redlines: RedlineRules;
  intake: {
    screening: IntakeScreening[];
    stages: { stage: string; age: string | null; sleep_hours?: number }[];
    bedtime: { buffer_minutes: number };
  };
}

export function productCode(p: ManifestProduct): string {
  return `${p.age}·${p.venue}`;
}
