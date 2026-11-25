// 阶段 4 网页管理端端到端测试（桌面 1440×900 + 平板 820×1180）：
// 覆盖首次初始化、无大模型全流程闭环（分步建档/扫码本地 SVG 二维码/评估/计划单/排课发布/菜单红线/模板阅读）、
// Agent SSE 流式回复 + 高危两阶段确认卡、管理员加密配置与备份导出，并强断言 0 外部网络请求。
import { existsSync, statSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { startLiveTestServer } from "./server.ts";
import { createProfileByWizard } from "./wizard.ts";

test("桌面 1440×900 与平板 820×1180：无大模型全闭环 + Agent SSE 确认卡 + 0 外部请求", async ({ page }) => {
  const srv = await startLiveTestServer();
  const externalRequests: string[] = [];

  page.on("request", (req) => {
    const url = req.url();
    if (url.startsWith("blob:") || url.startsWith("data:")) return;
    if (!url.startsWith(srv.baseUrl)) {
      externalRequests.push(url);
    }
  });

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(srv.baseUrl);

    // 1. 首次初始化管理员
    await expect(page.getByRole("heading", { name: "首次初始化管理员" })).toBeVisible();
    await expect(page.getByText("未经专业审核，不是医学建议，不能替代医生的判断")).toBeVisible();
    // 初始化口令：没带、带错都进不去；口令文件只有本机能读，用过就删
    expect(statSync(srv.setupPath).mode & 0o777).toBe(0o600);
    await page.locator('input[name="password"]').fill("AdminPass123!");
    await page.locator('input[name="confirmPassword"]').fill("AdminPass123!");
    await page.locator('input[name="setupCode"]').fill("WRONG-CODE-0000");
    await page.getByRole("button", { name: "创建管理员并进入" }).click();
    await expect(page.getByRole("alert")).toContainText("初始化口令不对");
    await page.locator('input[name="setupCode"]').fill(srv.setupCode.toLowerCase());
    await page.getByRole("button", { name: "创建管理员并进入" }).click();
    await expect(page.getByRole("heading", { name: "尚未建立或选择档案" })).toBeVisible();
    expect(existsSync(srv.setupPath)).toBe(false);

    // 2. 家庭与档案：分步建档向导（不预选、不预填；入门评估在向导最后一步一起交）
    await page.getByRole("button", { name: "前往可视向导建档" }).click();
    await createProfileByWizard(page, {
      code: "小夏E2E",
      stage: "18–39 岁",
      venue: "家里有 2.5kg 哑铃和动感单车",
      product: "18-39岁-居家版",
      conditions: [["有没有高血压", "否"]],
      gear: ["桌下反向划船"],
      birth: "1995-05",
      body: "不记",
      wake: "07:00",
      startDate: "2026-11-02",
      entry: async (pg) => {
        await pg.getByRole("group", { name: "最近 3 个月平均每周几天力量练习" }).getByRole("button", { name: "0 天" }).click();
        await pg.getByLabel("做的是第几级").selectOption({ label: "第 2 级 · 上斜俯卧撑" });
        await pg.getByLabel("做了几次").fill("8");
      },
    });

    // 扫码绑定弹窗：本地 SVG 二维码渲染正常且 0 外部请求
    await page.getByRole("button", { name: "手机扫码绑定" }).click();
    const qrSvg = page.getByRole("img", { name: "手机扫码配对二维码" });
    await expect(qrSvg).toBeVisible();
    const pathD = await qrSvg.locator("path").getAttribute("d");
    expect(pathD && pathD.length > 100).toBe(true);
    await page.getByRole("button", { name: "关闭" }).click();

    // 4. 排课中心：生成本周计划单 + 发布第 1 周 A 日课程
    await page.getByRole("button", { name: "排课中心" }).click();
    await page.getByRole("button", { name: "生成 / 更新本周计划单" }).click();
    await expect(page.getByText(/已确定性生成本周个人计划单/)).toBeVisible();
    await page.getByRole("button", { name: /发布第 1 周 .* 日课程/ }).click();
    await expect(page.getByText(/已发布跟练课程/)).toBeVisible();
    await expect(page.getByText("当前可跟练课程（1）")).toBeVisible();

    // 5. 饮食与模板阅读：先在档案设置里记下家里一起吃饭的人（菜单按每个人的红线检查），再存菜单 + 红线拦截
    await page.getByRole("button", { name: "家庭与档案" }).click();
    const household = page.getByRole("group", { name: "家里一起吃饭的还有谁" });
    await household.getByRole("button", { name: "18–39 岁" }).click();
    await household.getByRole("button", { name: "6–12 岁" }).click();
    await page.getByRole("button", { name: "保存设置" }).click();
    await expect(page.getByText("档案设置已保存")).toBeVisible();
    await page.getByRole("button", { name: "饮食与模板" }).click();
    await page.getByRole("button", { name: "校验红线并保存菜单" }).click();
    await expect(page.getByText(/已通过免责声明与全家安全红线校验/)).toBeVisible();

    // 触发儿童青少年热量/减肥红线拦截
    await page.locator("textarea").fill("未经专业审核，不是医学建议，不能替代医生的判断\n\n每天控制 1200 千卡减肥");
    await page.getByRole("button", { name: "校验红线并保存菜单" }).click();
    await expect(page.getByRole("alert")).toBeVisible();

    // 6. 养夏助手：SSE 流式输出 + 高危两阶段确认卡
    await page.getByRole("button", { name: "养夏助手" }).click();
    await expect(page.getByText("隐私披露与模型说明")).toBeVisible();
    await page.getByPlaceholder(/输入问题或指令/).fill("请登记医生同意有氧加量");
    await page.getByRole("button", { name: "发送" }).click();
    const confirmCard = page.getByTestId("agent-confirm-card");
    await expect(confirmCard).toBeVisible();
    await expect(confirmCard).toContainText("cardioClear");
    await confirmCard.getByRole("button", { name: "确认并保存" }).click();
    await expect(confirmCard).toBeHidden();
    await expect(page.getByText(/用户已确认并完成写入/)).toBeVisible();

    // 7. 系统管理：加密存 API Key（永不明文回显）+ 模板热重载 + 导出加密备份
    await page.getByRole("button", { name: "系统管理" }).click();
    const dummyKey = ["fake", "e2e", "secret", "key", "abcdef1234567890"].join("-");
    await page.getByPlaceholder(/填写外部模型 API Key/).fill(dummyKey);
    await page.getByRole("button", { name: "保存模型配置" }).click();
    await expect(page.getByText("API Key 已加密存储")).toBeVisible();
    expect(await page.content()).not.toContain(dummyKey);

    await page.getByRole("button", { name: "重新加载模板" }).click();
    await expect(page.getByText(/已原子热重载模板/)).toBeVisible();

    await page.getByPlaceholder("设置备份口令（至少 8 位）").fill("MyBackupPass123!");
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出 .yxbackup" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.yxbackup$/);

    // 8. 三种宽度：没有横向滚动；页面上不出现命令行和内部术语；手机宽度用底部 4 项加"更多"
    const JARGON = /--half|Skill|Tool Calling|JSON Schema|npm run|档案\.json|\.json \+ \.md/;
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    for (const [w, h] of [[1440, 900], [820, 1180]] as const) {
      await page.setViewportSize({ width: w, height: h });
      for (const tab of ["排课中心", "评估与复盘", "家庭与档案", "饮食与模板", "养夏助手"]) {
        await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: tab }).click();
        await expect(page.locator("main")).toBeVisible();
        expect(await overflow(), `${w}×${h} ${tab}`).toBe(false);
        expect(await page.locator("main").innerText(), `${w}×${h} ${tab}`).not.toMatch(JARGON);
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const phoneNav = page.getByRole("navigation", { name: "手机导航" });
    await expect(page.getByRole("navigation", { name: "主导航" })).toBeHidden();
    await expect(phoneNav.getByRole("button")).toHaveCount(4);
    for (const tab of ["排课", "评估复盘", "档案"]) {
      await phoneNav.getByRole("button", { name: tab }).click();
      expect(await overflow(), `390 ${tab}`).toBe(false);
      await expect(phoneNav.getByRole("button", { name: tab })).toBeInViewport();
    }
    await phoneNav.getByRole("button", { name: "更多" }).click();
    const sheet = page.getByRole("dialog", { name: "更多" });
    await expect(sheet.getByRole("button", { name: "饮食与模板" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "退出登录" })).toBeVisible();
    await sheet.getByRole("button", { name: "饮食与模板" }).click();
    await expect(sheet).toBeHidden();
    expect(await overflow(), "390 饮食与模板").toBe(false);

    // 强断言：全程 0 个外部网络请求！
    expect(externalRequests).toEqual([]);
  } finally {
    await srv.close();
  }
});
