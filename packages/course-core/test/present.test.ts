import { describe, expect, it } from "vitest";
import { checkProfileWithTemplates, cleanText, presentIssue, type Issue } from "../src/index.ts";
import { fixtureManifest } from "./helpers.ts";

const CLI = /npm run|档案\.json|\.json\b|\.md\b|course (export|assess|plan)/;

describe("presentIssue：命令行的说法换成界面说法", () => {
  it("有代号的按代号换", () => {
    const entry: Issue = { level: "error", path: "评估/", code: "ENTRY_ASSESSMENT_MISSING",
      message: "第一段（2026-11-02 起）之前要有入门评估：评估/<日期>-入门.json（用 npm run course -- assess 列出要问、要测的项）" };
    expect(presentIssue(entry)).toEqual({ level: "error", path: "评估/", code: "ENTRY_ASSESSMENT_MISSING",
      message: "第一段（2026-11-02 起）开始之前要先做入门评估：到「评估与复盘」填写" });
    const sheet = presentIssue({ level: "error", path: "计划/第1段-第2周.md", code: "SHEET_REGENERATE",
      message: "这一周从 2026-11-09 开始，这张计划单是按 2026-11-02 开始的那一周生成的：重新生成（npm run course -- plan），不手改" });
    expect(sheet.path).toBe("第 1 段第 2 周的计划单");
    expect(sheet.message).toBe("这一周从 2026-11-09 开始，这张计划单是按 2026-11-02 开始的那一周生成的：在「排课中心」重新生成计划单，不手改");
    const bed = presentIssue({ level: "error", path: "bedtime", code: "BEDTIME_MISMATCH",
      message: "18–39 岁、07:00 起床，按公式上床时间是 22:45，档案写的是 23:00（用 npm run course -- bedtime 算）" });
    expect(bed.message).toBe("18–39 岁、07:00 起床，按公式上床时间是 22:45，档案写的是 23:00：在「家庭与档案」按公式重新计算");
    const course = presentIssue({ level: "error", path: "source.plan", code: "COURSE_NOT_EXPORTED", message: "这份课程不是用 course export 从训练单导出的……" });
    expect(course.message).not.toMatch(CLI);
  });

  it("没有代号的去掉命令和文件名", () => {
    expect(cleanText("档案.json focus：直接进稳定期的人方向要含\"训练\"")).toBe("档案 focus：直接进稳定期的人方向要含\"训练\"");
    expect(cleanText("评估/2026-11-02-入门.json tests[0]")).toBe("2026-11-02 的入门评估 tests[0]");
    expect(cleanText("复盘/2026-11-02-第1周.json 缺少 trainings")).toBe("2026-11-02 起第 1 周的复盘 缺少 trainings");
  });

  it("真实的档案检查报错换完以后不留命令行字样", () => {
    const m = fixtureManifest();
    const issues = checkProfileWithTemplates({ stage: "学龄前", age: "a06", product: "不存在", wake: "07:00", bedtime: "20:00", screening: { answers: [] } }, m);
    expect(issues.length).toBeGreaterThan(0);
    for (const i of issues.map(presentIssue)) expect(`${i.path} ${i.message}`).not.toMatch(CLI);
  });
});
