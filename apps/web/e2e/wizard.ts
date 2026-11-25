// 网页 e2e 共用：照分步建档向导一步一步建档（每一步先断言没有预选、预填）。
import { expect, type Page } from "@playwright/test";

export interface Persona {
  code: string;
  stage: string;
  /** 18–64 岁的场地选项原话。 */
  venue?: string;
  product: string;
  /** 直接进稳定期（有基础）。 */
  direct?: boolean;
  /** 安全筛查里答"是"的项（原话的一部分）；其余答"否"。 */
  screeningYes?: string[];
  /** 医生同意的日期（筛查有"是"或 65 岁以上时）；不写就选"还没问"。 */
  doctorDate?: string;
  /** 训练条件：问法原话的一部分 → 是 / 否（不写的保持"没确认"）。 */
  conditions?: [string, "是" | "否"][];
  /** "重度肥胖"当场算：身高、体重（只在浏览器里算，交的是是 / 否）和应该得出的答案。 */
  bmi?: { height: string; weight: string; expect: "是" | "否" };
  /** 器材：按先后点的名字。 */
  gear?: string[];
  birth?: string;
  school?: { stage: string; entry: string };
  body?: "记" | "不记";
  walkBase?: string;
  focus?: string[];
  wake?: string;
  startDate: string;
  /** 入门评估：在第 7 步里填；"later" 是以后再做。 */
  entry: "later" | ((page: Page) => Promise<void>);
}

const next = (page: Page) => page.getByRole("button", { name: "下一步", exact: true }).click();

export async function createProfileByWizard(page: Page, p: Persona): Promise<void> {
  // 第 1 步：告知 + 代号
  await expect(page.getByRole("heading", { name: "建档之前先说清楚" })).toBeVisible();
  await expect(page.getByRole("button", { name: "下一步", exact: true })).toBeDisabled();
  await page.getByLabel("档案代号").fill(p.code);
  await page.getByLabel("我看过上面四条").check();
  await next(page);

  // 第 2 步：学段（学龄前不能选）、场地
  await expect(page.getByRole("button", { name: /学龄前/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: p.stage, exact: false }).first()).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: new RegExp(`^${p.stage}`) }).click();
  if (p.venue) await page.getByRole("button", { name: p.venue }).click();
  await next(page);

  // 第 3 步：成品（只列起始期，不含附册；推荐只是标出来）
  await expect(page.getByRole("button", { name: /附册/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /稳定期/ })).toHaveCount(0);
  await page.getByRole("button", { name: new RegExp(p.product) }).click();
  if (p.direct) await page.getByLabel("有训练基础，直接从稳定期开始").check();
  await next(page);

  // 第 4 步：安全筛查逐项答（不预选）
  const groups = page.locator('.qbox [role="group"]');
  const n = await groups.count();
  for (let i = 0; i < n; i++) {
    const g = groups.nth(i);
    await expect(g.locator('[aria-pressed="true"]')).toHaveCount(0);
    const label = (await g.getAttribute("aria-label")) ?? "";
    const yes = (p.screeningYes ?? []).some((x) => label.includes(x));
    await g.getByRole("button", { name: yes ? "是" : "否", exact: true }).click();
  }
  if (p.doctorDate) {
    await page.getByRole("button", { name: "同意了" }).click();
    await page.getByLabel("医生同意的日期").fill(p.doctorDate);
  } else if (await page.getByRole("button", { name: "还没问" }).count()) {
    await page.getByRole("button", { name: "还没问" }).click();
  }
  await next(page);

  // 第 5 步：训练条件（默认"没确认"）、器材（不预选）
  for (const [ask, v] of p.conditions ?? []) {
    await page.getByRole("group", { name: new RegExp(ask) }).getByRole("button", { name: v, exact: true }).click();
  }
  if (p.bmi) {
    await page.getByLabel("身高（厘米）").fill(p.bmi.height);
    await page.getByLabel("体重（公斤）").fill(p.bmi.weight);
    await page.getByRole("button", { name: "算一下" }).click();
    await expect(page.getByRole("status")).toContainText(`记"${p.bmi.expect}"`);
    await expect(page.getByRole("group", { name: /BMI 有没有到/ }).getByRole("button", { name: p.bmi.expect, exact: true })).toHaveAttribute("aria-pressed", "true");
  }
  for (const g of p.gear ?? []) await page.getByRole("button", { name: new RegExp(g) }).click();
  await next(page);

  // 第 6 步：基本信息（不预填）
  if (p.birth) {
    await expect(page.getByLabel(/出生年月/)).toHaveValue("");
    await page.getByLabel(/出生年月/).fill(p.birth);
  }
  if (p.school) {
    // 学段就是第 2 步选的，不再问一次
    await expect(page.locator("#wz-ss")).toContainText(p.school.stage);
    await page.locator("#wz-se").fill(p.school.entry);
  }
  if (p.body) await page.getByRole("group", { name: "体重、腰围记不记" }).getByRole("button", { name: p.body, exact: true }).click();
  if (p.walkBase) await page.getByLabel(/现在每天散步大约几分钟/).fill(p.walkBase);
  for (const f of p.focus ?? []) await page.getByRole("group", { name: "想先从哪方面入手" }).getByRole("button", { name: f }).click();
  await page.getByLabel("开始日期").fill(p.startDate);
  if (p.wake) await page.getByLabel("平时几点起床").fill(p.wake);
  await next(page);

  // 第 7 步：入门评估
  if (p.entry === "later") await page.getByLabel(/以后再做/).check();
  else await p.entry(page);
  await next(page);

  // 核对、创建
  await expect(page.getByRole("heading", { name: "核对一遍" })).toBeVisible();
  await page.getByRole("button", { name: "创建档案", exact: true }).click();
  await expect(page.getByText(new RegExp(`已建档「${p.code}」`))).toBeVisible();
}
