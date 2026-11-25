// 分步建档：方案验收里的几种人各建一次（不预选、不预填；条件只列这份成品的；器材按"家长在旁边"分组；
// 有基础的人直接进稳定期、入门评估当场核对；65 岁以上医生同意、入门评估可以以后做；请求里没有身高体重以外的身体数字）。
import { expect, test, type Page } from "@playwright/test";
import { startLiveTestServer } from "./server.ts";
import { createProfileByWizard } from "./wizard.ts";

async function init(page: Page, srv: Awaited<ReturnType<typeof startLiveTestServer>>) {
  await page.goto(srv.baseUrl);
  await page.locator('input[name="setupCode"]').fill(srv.setupCode);
  await page.locator('input[name="password"]').fill("AdminPass123!");
  await page.locator('input[name="confirmPassword"]').fill("AdminPass123!");
  await page.getByRole("button", { name: "创建管理员并进入" }).click();
  await page.getByRole("button", { name: "前往可视向导建档" }).click();
}

const newProfile = (page: Page) => page.getByRole("button", { name: "新建档案", exact: true }).click();

test("分步建档：18–39 有基础直接进稳定期、40–64 健身房、13–17 岁、65 岁以上", async ({ page }) => {
  const srv = await startLiveTestServer();
  const external: string[] = [];
  page.on("request", (r) => { if (!r.url().startsWith(srv.baseUrl) && !r.url().startsWith("data:")) external.push(r.url()); });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await init(page, srv);

    // 18–39 纯徒手、有基础：直接进稳定期，入门评估当场达线
    await createProfileByWizard(page, {
      code: "直进甲", stage: "18–39 岁", venue: "什么器械都没有", product: "18-39岁-纯徒手版", direct: true,
      conditions: [["有没有高血压", "否"]], gear: ["桌下反向划船"], birth: "1996-05", body: "不记", focus: ["训练"], wake: "07:00", startDate: "2026-11-02",
      entry: async (pg) => {
        await pg.getByRole("group", { name: "最近 3 个月平均每周几天力量练习" }).getByRole("button", { name: "2 天及以上" }).click();
        await pg.getByLabel("做的是第几级").selectOption({ label: "第 3 级 · 跪姿俯卧撑" });
        await pg.getByLabel("做了几次").fill("10");
        await pg.getByLabel("坚持了几秒").fill("40");
      },
    });
    await expect(page.locator(".card .muted", { hasText: "18-39岁-纯徒手版（稳定期）" })).toBeVisible();

    // 40–64 健身房：问开工前提；选了"记"才问身高体重腰围；不问"没地方跳"
    await newProfile(page);
    await createProfileByWizard(page, {
      code: "健身乙", stage: "40–64 岁", venue: "健身房", product: "40-64岁-健身房版",
      conditions: [["有没有高血压", "否"], ["骨量低或者骨质疏松", "否"]], birth: "1980-05", body: "记", startDate: "2026-11-02",
      entry: async (pg) => {
        await expect(pg.getByText("没地方跳")).toHaveCount(0);
        await pg.getByRole("group", { name: "近一年内做过体检吗" }).getByRole("button", { name: "是", exact: true }).click();
        await pg.getByRole("group", { name: /量过血压/ }).getByRole("button", { name: "是", exact: true }).click();
        await pg.getByRole("group", { name: "最近 3 个月平均每周几天力量练习" }).getByRole("button", { name: "1 天" }).click();
        await pg.getByLabel("身高（厘米）").fill("170");
        await pg.getByLabel("体重（公斤）").fill("65");
        await pg.getByLabel("腰围（厘米）").fill("80");
      },
    });

    // 13–17 岁：器材按"家长在旁边"分两组，门框划船两组都能用；不问身体数据
    await newProfile(page);
    await page.getByLabel("档案代号").fill("初中丙");
    await page.getByLabel("我看过上面四条").check();
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await page.getByRole("button", { name: /^初中/ }).click();
    await expect(page.getByText("能用的场地", { exact: false })).toHaveCount(0);
    await page.getByRole("button", { name: "上一步" }).click();
    await page.getByRole("button", { name: "收起" }).click();
    await newProfile(page);
    await createProfileByWizard(page, {
      code: "初中丙", stage: "初中", product: "13-17岁-纯徒手版",
      conditions: [["家长能不能在旁边", "否"], ["能跳的地方", "否"]], gear: ["门框划船"], school: { stage: "初中", entry: "2025" }, startDate: "2026-11-02",
      entry: async (pg) => {
        await expect(pg.getByText(/体重|热量|减肥/)).toHaveCount(0);
        await pg.getByRole("group", { name: "最近 3 个月平均每周几天力量练习" }).getByRole("button", { name: "0 天" }).click();
      },
    });

    // 13–17 岁、家长能在旁边：桌下划船那一组能用
    await newProfile(page);
    await createProfileByWizard(page, {
      code: "初中丁", stage: "初中", product: "13-17岁-纯徒手版",
      conditions: [["家长能不能在旁边", "是"], ["能跳的地方", "否"]], gear: ["桌下反向划船", "门框划船"], school: { stage: "初中", entry: "2025" }, startDate: "2026-11-02",
      entry: "later",
    });

    // 40–64 纯徒手、筛查 BMI ≥ 28 答"是"：问"重度肥胖"，身高体重当场算，请求里没有这两个数
    const bodies: string[] = [];
    page.on("request", (r) => { if (r.url().startsWith(`${srv.baseUrl}/api/`)) bodies.push(`${r.url()} ${r.postData() ?? ""}`); });
    await newProfile(page);
    await createProfileByWizard(page, {
      code: "居家戊", stage: "40–64 岁", venue: "什么器械都没有", product: "40-64岁-纯徒手版", screeningYes: ["BMI"], doctorDate: "2026-11-02",
      conditions: [["有没有高血压", "否"], ["骨量低或者骨质疏松", "否"]], bmi: { height: "171.3", weight: "88.8", expect: "否" }, gear: ["门框划船"],
      birth: "1975-05", body: "不记", startDate: "2026-11-02", entry: "later",
    });
    expect(bodies.some((b) => b.includes("/api/profiles/from-intake") && b.includes("重度肥胖"))).toBe(true);
    expect(bodies.filter((b) => b.includes("171.3") || b.includes("88.8"))).toEqual([]);

    // 65 岁以上：筛查都答"否"也要先问医生；散步分钟自己填；入门评估以后（家人在场）做
    await newProfile(page);
    await createProfileByWizard(page, {
      code: "夏老", stage: "65 岁以上", product: "65岁以上-椅子辅助版", doctorDate: "2026-11-02",
      conditions: [["家里只有你一个人", "否"]], birth: "1950-05", walkBase: "20", startDate: "2026-11-02",
      entry: "later",
    });

    expect(external).toEqual([]);
  } finally {
    await srv.close();
  }
});
