// JSON Schema（contracts/course.schema.json）和 TypeScript 结构校验，对同一批样例要给出同样的判断。
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { validateCourse } from "../src/validate.ts";
import { CONTRACTS, courseFixtures, readJson } from "./helpers.ts";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const schema = ajv.compile(readJson(`${CONTRACTS}course.schema.json`) as object);

describe("课程格式：Schema 和 TS 校验一致", () => {
  for (const [name, course] of courseFixtures("ok-")) {
    it(`合格样例 ${name}`, () => {
      expect(schema(course), JSON.stringify(schema.errors)).toBe(true);
      expect(validateCourse(course).issues.filter((i) => i.level === "error")).toEqual([]);
    });
  }
  for (const [name, course] of courseFixtures("bad-")) {
    it(`不合格样例 ${name}`, () => {
      expect(schema(course)).toBe(false);
      expect(validateCourse(course).course).toBeNull();
    });
  }
});
