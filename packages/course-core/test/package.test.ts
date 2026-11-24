// 课程包（v4 阶段 8c）：把课程嵌进打包好的编排器、读出来一字不差；标记、嵌入块恰好一个；对已经嵌过的再嵌报错。
import { describe, expect, it } from "vitest";
import { PACKAGE_FORMAT, packageInfo, packCourse, unpackCourse } from "../src/package.ts";

const META = (o: Partial<Record<string, string>> = {}) =>
  `<meta name="yangxia-package" content="format=${o.format ?? PACKAGE_FORMAT};motions=${o.motions ?? "v3.4"};motionsHash=${o.motionsHash ?? "aaa"};source=${o.source ?? "bbb"}">`;
const BLOCK = '<script type="application/json" id="yangxia-course"></script>';
const page = (head = META(), body = BLOCK) => `<!doctype html><html><head><meta charset="UTF-8">${head}<title>养夏 · 跟练编排器</title></head><body><div id="app"></div><script type="module">const a=1;</script>${body}</body></html>`;

const course = {
  schema: "yangxia.course/1", id: "c_pkgtest01", name: "第 1 周 · A 日 </script><!-- $& $' $` 😀",
  source: { product: "18-39岁-居家版", week: 1 },
  blocks: [{ kind: "sets", items: [{ exercise: "squat", name: "深蹲<b>", quote: ["</SCRIPT>原文 \u2028 换行\u2029"] }] }],
};

describe("课程包", () => {
  it("读打包标记", () => {
    expect(packageInfo(page()).info).toEqual({ format: PACKAGE_FORMAT, motions: "v3.4", motionsHash: "aaa", source: "bbb" });
    expect(packageInfo(page("")).info).toBeNull();
    expect(packageInfo(page(META() + META())).error).toMatch(/不止一个/);
    expect(packageInfo(page('<meta name="yangxia-package" content="format=yangxia.package/1">')).error).toMatch(/缺项/);
  });

  it("嵌进去、读出来一字不差：</script>、<!--、$&、$'、U+2028、表情都截不断", () => {
    const r = packCourse(page(), course, "2026-11-24");
    expect(r.error).toBeUndefined();
    const html = r.html!;
    // 嵌入块之外原样不动
    expect(html.startsWith(page().slice(0, page().indexOf(BLOCK)))).toBe(true);
    expect(html.endsWith("</body></html>")).toBe(true);
    // 嵌的内容里没有生的 <，页面里 </script> 只有原来那几个
    const inner = html.slice(html.indexOf('id="yangxia-course"'), html.lastIndexOf("</script>"));
    expect(inner.slice(inner.indexOf(">") + 1)).not.toContain("<");
    expect(html.split("</script>").length).toBe(page().split("</script>").length);
    const u = unpackCourse(html);
    expect(u.error).toBeUndefined();
    expect(u.course).toEqual(course);
    expect(u.exported).toBe("2026-11-24");
  });

  it("普通编排器：嵌入块是空的", () => {
    expect(unpackCourse(page())).toMatchObject({ course: null, empty: true });
  });

  it("对已经嵌过课程的再嵌、两个嵌入块、没有嵌入块、没有标记、格式不认识：都报错", () => {
    const once = packCourse(page(), course, "2026-11-24").html!;
    expect(packCourse(once, course, "2026-11-25").error).toMatch(/已经嵌了课程/);
    expect(packCourse(page(META(), BLOCK + BLOCK), course, "2026-11-24").error).toMatch(/不止一个/);
    expect(unpackCourse(page(META(), BLOCK + BLOCK)).error).toMatch(/不止一个/);
    expect(packCourse(page(META(), ""), course, "2026-11-24").error).toMatch(/没有嵌入块/);
    expect(packCourse(page(""), course, "2026-11-24").error).toMatch(/没有打包标记/);
    expect(packCourse(page(META({ format: "yangxia.package/9" })), course, "2026-11-24").error).toMatch(/只认/);
    expect(packCourse(page(), course, "11-24").error).toMatch(/YYYY-MM-DD/);
  });

  it("嵌入块被改过：有生的 <、不是 JSON", () => {
    const raw = page().replace(BLOCK, '<script type="application/json" id="yangxia-course">{"a":"<b>"}</script>');
    expect(unpackCourse(raw).error).toMatch(/没转义/);
    const bad = page().replace(BLOCK, '<script type="application/json" id="yangxia-course">{坏</script>');
    expect(unpackCourse(bad).error).toMatch(/不是合格的 JSON/);
  });
});
