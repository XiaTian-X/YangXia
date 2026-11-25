// 评估与复盘：周复盘有不适锁定、不能推周只能重来；个人进度不合规则的被拒、合规则的写入；
// 65 岁以上入门评估（坐站、家人在旁、医生同意、跌倒风险自查问卷和步态）照表单交，结论是人话；页面不出现命令行字样。
import { expect, test, type Page } from "@playwright/test";
import { startLiveTestServer } from "./server.ts";

const CLI = /npm run|档案\.json|course (export|assess|plan)|\{\}/;

async function api<T = any>(page: Page, path: string, body?: unknown): Promise<T> {
  return page.evaluate(async ([p, b]) => {
    const r = await fetch(p as string, {
      method: b === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "X-YangXia-CSRF": "1" },
      body: b === undefined ? undefined : JSON.stringify(b),
      credentials: "include",
    });
    const j = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(j));
    return j;
  }, [path, body] as const) as Promise<T>;
}

async function intakeInput(page: Page, answers: Record<string, any>, extra: Record<string, any>) {
  const f = await api(page, "/api/intake/form", answers);
  const screening = Object.fromEntries((f.form.screening.items as string[]).map((x) => [x, "否"]));
  return { answers: { ...answers, screening }, startDate: "2026-11-02", timezone: "Asia/Shanghai", wake: "07:00", ...extra };
}

test("周复盘有不适锁定、个人进度照规则写；65 岁以上入门评估照表单交", async ({ page }) => {
  const srv = await startLiveTestServer();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(srv.baseUrl);
    await page.locator('input[name="setupCode"]').fill(srv.setupCode);
    await page.locator('input[name="password"]').fill("AdminPass123!");
    await page.locator('input[name="confirmPassword"]').fill("AdminPass123!");
    await page.getByRole("button", { name: "创建管理员并进入" }).click();
    await expect(page.getByRole("heading", { name: "尚未建立或选择档案" })).toBeVisible();

    // 准备：居家版一份（入门评估一起交）、发布 A 日、手机回传一条带头晕的记录
    const home = await intakeInput(page, { stage: "18–39 岁", venue: "home", product: "18-39岁-居家版", conditions: { 高血压: false } },
      { code: "复盘甲", birth: "1995-05", body: "不记", choices: ["table-row"] });
    const created = await api(page, "/api/profiles/from-intake", {
      input: home,
      initialAssessment: { schema: "yangxia.assessment" + "/1", date: "2026-11-02", kind: "入门", base: 0, tests: [{ id: "pushup-test", level: 2, value: 8 }] },
    });
    const pub = await api(page, `/api/profiles/${created.id}/courses/publish`, { week: 1, day: "A" });
    const course = pub.envelope.course;
    await api(page, "/api/mobile/sessions", {
      profileId: created.id,
      session: {
        schema: "yangxia.session" + "/1", course: { id: course.id, name: course.name, source: course.source },
        startedAt: "2026-11-02T01:00:00.000Z", endedAt: "2026-11-02T01:20:00.000Z",
        items: [{ exercise: course.blocks[0].items[0].exercise, setsPlanned: 2, setsDone: 2, feel: "能做到下限，最后两下有点难" }],
        feeling: "正好", symptoms: { pain: false, dizzy: true, chest: false },
      },
    });

    // 这一周结束以后做复盘
    srv.setNow(new Date("2026-11-09T02:00:00.000Z"));
    await page.reload();
    await page.getByRole("button", { name: "评估与复盘" }).click();
    await expect(page.getByRole("heading", { name: "第 1 段第 1 周复盘" })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("头晕");
    await expect(page.getByText("有 · 记录里写了，不能取消")).toBeVisible();
    await expect(page.getByLabel("这一周练了几次")).toHaveValue("1");
    await expect(page.getByRole("button", { name: /推到第 2 周/ })).toBeDisabled();
    // 习惯不填不能保存
    await page.getByRole("button", { name: /第 1 周重来一次/ }).click();
    await expect(page.getByRole("button", { name: "保存复盘" })).toBeDisabled();
    await page.getByLabel(/散步：这一周达标几天/).fill("3");
    await page.getByLabel(/冥想：这一周达标几天/).fill("0");
    await expect(page.getByLabel("写给自己看的几句：这一周怎么样、下周注意什么")).toHaveValue(/^未经专业审核，不是医学建议/);
    await page.getByRole("button", { name: "保存复盘" }).click();
    await expect(page.getByText(/已保存第 1 周复盘，第 1 周重来一次/)).toBeVisible();

    // 个人进度：有不适时往上加的规则灰掉；写一条不合规则的被拒（报错是人话），再写一条合规则的
    const firstChange = page.getByRole("row", { name: /徒手深蹲/ }).getByRole("button", { name: "改" });
    await firstChange.click();
    await page.getByRole("group", { name: "照哪条规则改" }).getByRole("button", { name: "减量" }).click();
    const pickLevel = async () => {
      const which = page.getByRole("group", { name: "改哪一项" });
      if (await which.count()) await which.getByRole("button", { name: "难度级" }).click();
    };
    await pickLevel();
    await page.getByLabel("改成").selectOption({ index: 1 });
    await page.getByLabel("哪天改的").fill("2026-11-09");
    await page.getByRole("button", { name: "照规则核对后写入" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /未通过规则校验/ })).toBeVisible();
    expect(await page.getByRole("alert").filter({ hasText: /未通过规则校验/ }).innerText()).not.toMatch(CLI);
    await page.getByRole("group", { name: "照哪条规则改" }).getByRole("button", { name: "建档" }).click();
    await pickLevel();
    await page.getByLabel("改成").selectOption({ index: 1 });
    await page.getByLabel("哪天改的").fill("2026-11-02");
    await page.getByRole("button", { name: "照规则核对后写入" }).click();
    await expect(page.getByText(/已照"建档"改了「徒手深蹲」/)).toBeVisible();
    expect(await page.locator("main").innerText()).not.toMatch(CLI);

    // 65 岁以上：建档时没做入门评估，现在照表单交（含跌倒风险自查）
    const senior = await intakeInput(page, { stage: "65 岁以上", product: "65岁以上-椅子辅助版" },
      { code: "夏老", birth: "1950-05", walkBase: 20, doctorCleared: true, doctorDate: "2026-11-02" });
    await api(page, "/api/profiles/from-intake", { input: senior });
    await page.reload();
    const seniorId = await page.getByLabel("切换当前档案").locator("option", { hasText: "夏老" }).getAttribute("value");
    await page.getByLabel("切换当前档案").selectOption(seniorId!);
    await page.getByRole("button", { name: "评估与复盘" }).click();
    await page.getByRole("tab", { name: "评估", exact: true }).click();
    await expect(page.getByRole("heading", { name: "入门评估" })).toBeVisible();
    await page.getByLabel("哪天做的").fill("2026-11-02");
    const yn = async (q: RegExp | string, a: string) => page.getByRole("group", { name: q }).getByRole("button", { name: a, exact: true }).click();
    await yn("测试时有家人在旁边", "是");
    await yn("医生同意做这些测试了吗", "是");
    await page.getByLabel("医生同意的日期").fill("2026-11-02");
    await page.getByLabel(/30 秒做了几次/).fill("10");
    await yn("用手的方式", "扶椅子");
    await yn("30 秒做完了吗", "是");
    await page.getByLabel("问卷做的日期").fill("2026-11-02");
    await yn(/你是否跌倒过/, "否");
    await expect(page.getByText(/跌倒的次数是否大于等于 2 次/)).toHaveCount(0);
    await yn(/站立或行走时感到不稳/, "说不清");
    await expect(page.getByText(/跌倒的次数是否大于等于 2 次/).first()).toBeVisible(); // 说不清：接着问严重程度
    await yn(/站立或行走时感到不稳/, "否");
    await yn(/你是否担心跌倒/, "否");
    await yn("在家走路也要扶墙或用助行器", "否");
    await yn("扶着椅子也很难自己站起来", "否");
    await yn("经常头晕，或者站起来时眼前发黑", "否");
    for (const [title, secs] of [["4 米走", "3.6"], ["起立行走", "9.8"]] as const) {
      const box = page.locator(".stack", { has: page.getByRole("group", { name: new RegExp(`${title}.*测了没有`) }) }).last();
      await box.getByRole("button", { name: "测了", exact: true }).click();
      await box.getByLabel(/用时/).fill(secs);
      await box.getByLabel("测的日期").fill("2026-11-02");
      await box.getByLabel(/场地防滑/).check();
      const chair = box.getByLabel(/椅子有扶手和靠背/);
      if (await chair.count()) await chair.check();
    }
    await expect(page.getByText("还要填")).toBeVisible();
    await page.getByRole("button", { name: "提交，由服务端重算结论" }).click();
    await expect(page.getByRole("heading", { name: "结论" })).toBeVisible();
    await expect(page.getByText(/跌倒风险自查：低/).first()).toBeVisible();
    expect(await page.locator("main").innerText()).not.toMatch(CLI);
  } finally {
    await srv.close();
  }
});
