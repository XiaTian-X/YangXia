// 评估页的四种（修复方案 P0-3 验收）：健身房段末（重量那一项用中文名）、直接进稳定期的周期末、65 岁以上摔倒的触发评估（多个日期）、
// 6–12 岁入门。档案和每周复盘用接口准备，页面上不出现英文编号、年龄段代号、英文字段名、原始 JSON、命令行字样。
import { expect, test, type Page } from "@playwright/test";
import { startLiveTestServer } from "./server.ts";

const PROFILE = "yangxia.profile" + "/1";
const ASSESS = "yangxia.assessment" + "/1";
const REVIEW = "yangxia.review" + "/1";
const DECL = "未经专业审核，不是医学建议，不能替代医生的判断";
const LEAK = /[a-z]{2,}-[a-z0-9-]+|(?<![A-Za-z0-9])a(06|13|18|40|65)(?![A-Za-z0-9])|doctorRestart|eatingCheck|\bgoals?\b|\bvalue\b|[{}]|npm run|档案\.json|course (export|assess|plan)/;

async function api<T = any>(page: Page, path: string, body?: unknown): Promise<T> {
  return page.evaluate(async ([p, b]) => {
    const r = await fetch(p as string, {
      method: b === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "X-YangXia-CSRF": "1" },
      body: b === undefined ? undefined : JSON.stringify(b),
      credentials: "include",
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`${p} ${JSON.stringify(j)}`);
    return j;
  }, [path, body] as const) as Promise<T>;
}

const relogin = (page: Page) => api(page, "/api/auth/login", { username: "admin", password: "AdminPass123!" });

async function screeningNo(page: Page, answers: Record<string, unknown>) {
  const f = await api(page, "/api/intake/form", answers);
  return (f.form.screening.items as string[]).map((item) => ({ item, answer: "否" }));
}

/** 这一周练一次：发这一周的 A 日，手机回传一条练完的记录（不然断了几周就要先做中断的触发评估）。 */
async function train(page: Page, pid: string, start: string, week: number) {
  const pub = await api(page, `/api/profiles/${pid}/courses/publish`, { week, day: "A" });
  const c = pub.envelope.course;
  const at = new Date(Date.parse(`${start}T01:00:00.000Z`) + 86_400_000);
  await api(page, "/api/mobile/sessions", {
    profileId: pid,
    session: {
      schema: "yangxia.session" + "/1", course: { id: c.id, name: c.name, source: c.source },
      startedAt: at.toISOString(), endedAt: new Date(at.getTime() + 30 * 60_000).toISOString(),
      items: c.blocks.flatMap((b: any) => b.items.map((it: any) => {
        const n = b.kind === "circuit" ? b.rounds : it.sets ?? 1;
        return { exercise: it.exercise, setsPlanned: n, setsDone: n, skipped: false };
      })),
      feeling: "正好", symptoms: { pain: false, dizzy: false, chest: false },
    },
  });
}

/** 这一周的复盘：必填的照最小值填（只为让档案往前走），不适没有。 */
async function review(page: Page, pid: string, start: string, week: number, next: "advance" | "end") {
  const { form } = await api(page, `/api/profiles/${pid}/reviews/form`, { symptoms: false });
  const rec: Record<string, any> = { schema: REVIEW, start, week, trainings: form.minTrainings, symptoms: false, moves: [] };
  const habits: Record<string, number> = {};
  for (const f of form.sections.flatMap((s: any) => s.fields)) {
    if (!f.required || f.readonly || f.key === "trainings" || f.key === "symptoms") continue;
    const v = f.input.type === "yesno" ? false : f.input.type === "enum" ? f.input.options[0].value : f.input.min ?? 0;
    if (f.key.startsWith("habits.")) habits[f.key.slice(7)] = v;
    else rec[f.key] = v;
  }
  if (Object.keys(habits).length) rec.habits = habits;
  await api(page, `/api/profiles/${pid}/reviews`, { startDate: start, week, reviewJson: rec, reviewMd: `${DECL}\n\n第 ${week} 周`, next });
}

const day = (n: number) => new Date(Date.UTC(2026, 10, 2 + n)).toISOString().slice(0, 10);

async function openAssess(page: Page, code: string, kind: string) {
  await page.reload();
  const sel = page.getByLabel("切换当前档案");
  await sel.selectOption((await sel.locator("option", { hasText: code }).getAttribute("value"))!);
  await page.getByRole("button", { name: "评估与复盘" }).click();
  await page.getByRole("tab", { name: "评估", exact: true }).click();
  await page.getByRole("tablist", { name: "评估种类" }).getByRole("tab", { name: kind, exact: true }).click();
  await expect(page.getByRole("heading", { name: `${kind}评估` })).toBeVisible();
}

test("评估页：健身房段末、直接进稳定期的周期末、65 岁以上摔倒触发、6–12 岁入门都不露英文编号和字段名", async ({ page }) => {
  test.setTimeout(180_000);
  const srv = await startLiveTestServer();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(srv.baseUrl);
    await page.locator('input[name="setupCode"]').fill(srv.setupCode);
    await page.locator('input[name="password"]').fill("AdminPass123!");
    await page.locator('input[name="confirmPassword"]').fill("AdminPass123!");
    await page.getByRole("button", { name: "创建管理员并进入" }).click();
    await expect(page.getByRole("heading", { name: "尚未建立或选择档案" })).toBeVisible();

    // 健身房（起始期）：入门只问基础；建档记一个重量，段末那一项照它显示
    const gymAnswers = { stage: "18–39 岁", venue: "gym", product: "18-39岁-健身房版" };
    const gym = await api(page, "/api/profiles", {
      profile: {
        schema: PROFILE, code: "健身己", stage: "18–39 岁", age: "a18", venue: "gym", product: "18-39岁-健身房版", birth: "1995-05", body: "不记",
        timezone: "Asia/Shanghai", startDate: "2026-11-02", segments: [{ n: 1, type: "标准", week: 1, start: "2026-11-02", product: "18-39岁-健身房版" }],
        screening: { answers: await screeningNo(page, gymAnswers), doctorCleared: false, date: "2026-11-02" }, conditions: { 高血压: false }, progress: {}, progressLog: [],
      },
      initialAssessment: { schema: ASSESS, date: "2026-11-02", kind: "入门", base: 1, conclusion: {} },
    });
    const pf = await api(page, `/api/profiles/${gym.id}/progress/form`);
    const weighted = pf.form.moves.find((m: any) => m.fields.includes("weight"));
    await api(page, `/api/profiles/${gym.id}/progress-log`, { entries: [{ date: "2026-11-02", move: weighted.move, field: "weight", to: 20, rule: "建档" }] });

    // 纯徒手、有基础：直接进稳定期（入门评估当场达线）
    const bwAnswers = { stage: "18–39 岁", venue: "bw", product: "18-39岁-纯徒手版" };
    const stable = "18-39岁-纯徒手版（稳定期）";
    const bw = await api(page, "/api/profiles", {
      profile: {
        schema: PROFILE, code: "稳定庚", stage: "18–39 岁", age: "a18", venue: "bw", product: stable, birth: "1995-05", body: "不记", focus: { areas: ["训练"] },
        timezone: "Asia/Shanghai", startDate: "2026-11-02", segments: [{ n: 1, type: "标准", phase: "稳定", week: 1, start: "2026-11-02", product: stable }],
        screening: { answers: await screeningNo(page, bwAnswers), doctorCleared: false, date: "2026-11-02" }, conditions: { 高血压: false, 没地方跳: false },
        choices: ["table-row"], progress: {}, progressLog: [],
      },
      initialAssessment: { schema: ASSESS, date: "2026-11-02", kind: "入门", base: 2, tests: [{ id: "pushup-test", level: 3, value: 10 }, { id: "wallsit-test", value: 40 }], conclusion: {} },
    });

    // 一周一周往前走：健身房 4 周到段末，纯徒手 12 周到周期末
    for (let w = 1; w <= 12; w++) {
      srv.setNow(new Date(`${day(7 * w)}T02:00:00.000Z`));
      await relogin(page);
      await train(page, bw.id, day(7 * (w - 1)), w);
      await review(page, bw.id, day(7 * (w - 1)), w, w < 12 ? "advance" : "end");
      if (w <= 4) {
        await train(page, gym.id, day(7 * (w - 1)), w);
        await review(page, gym.id, day(7 * (w - 1)), w, w < 4 ? "advance" : "end");
      }
    }

    await openAssess(page, "健身己", "段末");
    await expect(page.getByText(/这一段的汇总/)).toBeVisible();
    await expect(page.getByText(/现在的重量/).first()).toBeVisible();
    expect(await page.locator("main").innerText()).not.toMatch(LEAK);

    await openAssess(page, "稳定庚", "周期末");
    await expect(page.getByText(/这个周期的汇总/)).toBeVisible();
    expect(await page.locator("main").innerText()).not.toMatch(LEAK);

    // 65 岁以上：摔倒的触发评估，一周里摔了两次各写一个日期
    const seniorAnswers = { stage: "65 岁以上", product: "65岁以上-椅子辅助版" };
    const sItems = (await api(page, "/api/intake/form", seniorAnswers)).form.screening.items as string[];
    await api(page, "/api/profiles/from-intake", {
      input: {
        answers: { ...seniorAnswers, screening: Object.fromEntries(sItems.map((x) => [x, "否"])), conditions: { 家里没有别人: false } },
        code: "夏老辛", startDate: day(77), timezone: "Asia/Shanghai", wake: "07:00", birth: "1950-05", walkBase: 20, doctorCleared: true, doctorDate: day(77),
      },
    });
    await openAssess(page, "夏老辛", "触发");
    await page.getByRole("button", { name: "摔倒", exact: true }).click();
    const dates = page.getByLabel(/摔倒的日期/);
    await expect(dates.first()).toBeVisible();
    expect(await page.locator("main").innerText()).not.toMatch(LEAK);

    // 6–12 岁家长版：入门评估页不谈体重、热量、减肥
    const kidAnswers = { stage: "小学", product: "6-12岁-户外与游戏版（家长版）" };
    const kItems = (await api(page, "/api/intake/form", kidAnswers)).form.screening.items as string[];
    await api(page, "/api/profiles/from-intake", {
      input: {
        answers: { ...kidAnswers, screening: Object.fromEntries(kItems.map((x) => [x, "否"])) },
        code: "小宝壬", startDate: day(77), timezone: "Asia/Shanghai", wake: "07:00", school: { stage: "小学", entry: 2024 },
      },
    });
    await openAssess(page, "小宝壬", "入门");
    const kidText = await page.locator("main").innerText();
    expect(kidText).not.toMatch(LEAK);
    expect(kidText).not.toMatch(/体重|热量|减肥|排名/);
  } finally {
    await srv.close();
  }
});
