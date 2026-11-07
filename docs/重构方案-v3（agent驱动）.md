# 养夏 v3 重构方案：agent 驱动（r6，已过独立审查）

> 目标：把计划模板（现 `guilv-life/`）和课程编排器（现 `keep-course-sequencer.html`）合成一个由 agent 驱动的项目 **养夏**（英文名 YangXia），从**作息、锻炼、饮食**三方面帮人建立习惯。
> 原则：先搭骨架，再扩展模板发布物，再做核心库和编排器，最后加 agent 工作流。每一步都做回归比对，**计划成品的正文不因结构调整而改变**。
> 旧的 `workspace/living`（v1.9）继续原样保留，不动。
>
> 修订记录：r2 编排器改用 TypeScript、新增联动设计；r3 定名（中文「养夏」/ 英文 YangXia）；r4 编排器不兼容旧数据；r5 模板单独建库、定提交和排除规则；**r6 按独立审查意见修订**（见第十二节）。

---

## 一、现状（2026-11-07 核对）

| 部分 | 现在 | 状态 / 问题 |
|---|---|---|
| 计划模板 `guilv-life/` | v2.0，cowork 从 living v1.9 重构而来；10 份成品 + 菜谱手册、87 张动图、PDF 手册、`manifest.json`；独立 git 仓库（`main`，1 次提交） | `python3 guilv.py all` 本机 0 错误 0 警告；构建 1.3 秒、校验 0.3 秒 |
| 课程编排器 `keep-course-sequencer.html` | Gemini 仿 Keep 做的单文件网页：6838 行；能导出跟练视频（WebM）、音频（WAV）、字幕（SRT） | 见下 |
| 根目录 | `新项目架构方案.md`（v2.0 方案，已执行完）、本方案 | 不是 git 仓库 |

**编排器的问题：**
1. **带着 Keep 的名字**，共 117 处。Keep 是别人的商标，要换成本项目自己的名字和说法。
2. **核心逻辑和界面绑死**：`buildTimeline()` 直接读页面上的下拉框、勾选框，没法脱离浏览器测试，agent 和别的项目也没法调用。
3. **跟模板对不上**：节奏只有四种，表达不了"下放 3 秒""顶点停 3 秒"；没有"每侧""几轮循环"；导入时超范围的值被悄悄改掉；呼吸提示不分人群；动作跟模板没有关联。
4. **内置语音只认固定词表**：自带的合成语音约 35 个音节，只能说数字、"开始""本组完成""深吸气"等 20 来个词，词表外的话会被读成"一"。所以"别把气停住"这类按人群的提示**只能显示在字幕和画面上**。
5. **有两处随机数**（语音里的气声噪声），每次导出的音频略有不同。
6. **没有测试。**

**模板的问题：**
- 本机 Python 3.14 重建时，`d-circuit-bw.svg`、`d-circuit-home.svg` 各有一个坐标末位差 0.1：计算结果刚好落在四舍五入的边界上，换 Python 版本或系统数学库都可能翻到另一边。（已还原，没有留下改动。）
- 「规律生活」不在 10 份成品正文里，只出现在 PDF 手册、manifest、README、维护指南、架构说明、`guilv.py` 说明里。

---

## 二、名称

**规则：给人看的用中文「养夏」，给程序读的用英文 YangXia。**

- **用中文**：显示名、页面标题和界面文字、PDF 手册、manifest 里给人看的名字、成品和文档的文件名、编排器导出的文件名。
- **用英文**：目录、命令、npm 包名（只能小写，写 `@yangxia/…`）、数据格式标识、本地存储键、git 标签、仓库名。

| 部分 | 中文名 | 目录 | 英文标识 |
|---|---|---|---|
| 项目（主仓库） | **养夏** | `YangXia/` | 仓库名 `YangXia` |
| 计划模板（模板仓库） | **养夏计划模板**（原「规律生活」） | `YangXia/templates/`（原 `guilv-life/`） | 仓库名 `YangXia-templates`；命令 `tpl.py`（原 `guilv.py`） |
| 课程核心库 | **养夏课程核心库** | `packages/course-core/` | `@yangxia/course-core` |
| 跟练编排器 | **养夏跟练编排器** | `apps/sequencer/` | `@yangxia/sequencer`；成品 `养夏跟练编排器.html` |
| 数据格式 | 模板清单 / 课程 / 练习记录 / 个人档案 | — | `yangxia.manifest/1`、`yangxia.course/1`、`yangxia.session/1`、`yangxia.profile/1` |

---

## 三、两个仓库

| 仓库 | 本地位置 | 内容 |
|---|---|---|
| **YangXia**（主仓库） | `YangXia/` | agent 层、课程核心库、跟练编排器、数据约定、项目文档 |
| **YangXia-templates**（模板仓库） | `YangXia/templates/`（由 `guilv-life/` 改名，沿用原有历史） | 养夏计划模板 |

- 模板仓库放在主仓库目录里，主仓库 `.gitignore` 用 `/templates/` 排除它，两边各提交各的；都只在本地，不推远程。
- **分支**：模板仓库在 `v3-refactor` 分支上改，验收后由你决定是否合并回 `main`、打 `v2.1` 标签；主仓库是新建的，直接在 `main` 上提交。

### 1. 依赖只有一个方向：主仓库读模板，模板不知道主仓库

- 模板的构建、校验不读主仓库的任何文件，单独克隆也能完整运行。
- 主仓库的**用户工作流**（核心库、用户用的 skill）只读模板的**发布物**：`dist/` 里的成品和 `dist/manifest.json`。
- **维护模板的工作流属于模板仓库**：`template-maintain` skill 放在 `templates/.claude/skills/`，跟着模板仓库走。
- 找模板只有一套规则：环境变量 `YANGXIA_TEMPLATES`，没设就用 `./templates`。核心库、hook、setup 脚本都用它（`scripts/templates-path.mjs`）；找不到时，需要模板的步骤跳过并醒目提示。

### 2. manifest 要补齐 agent 需要的东西

现在 skill 要用的问卷、筛查、分流规则在 README 和历史设计方案里，不在发布物中。补进 manifest：

| 字段 | 来源（模板 `content/`） | 用途 |
|---|---|---|
| `format: "yangxia.manifest/1"` | 构建写入 | 核心库按格式号判断能不能用，不按版本号 |
| `version` | **改成取 CHANGELOG 第一条 `## vX · 日期`**（只此一个来源；每份成品自己的版本仍在 `products[].version`） | 记录课程出自哪版模板 |
| `intake` | 新增 `入口问卷.md`：问题、各年龄段安全筛查项、分流表、作息公式和目标睡眠 | `onboard` 建档；`check.py` 核对它和 README 的筛查清单一致 |
| `exercises` | 新增 `动作索引.md` | 课程里的动作必须来自这里 |
| `redlines` | 新增 `params/红线词.md`（从 `check.py` 搬出：禁用词、否定语境白名单、必备项、**校验样例**） | 核心库和 `check.py` 用同一份词表、跑同一批样例 |

### 3. 版本和日期

- 开发期间 CHANGELOG 最上面写 `## 未发布`（构建只认 `## vX · 日期`，这一行会被跳过），封面日期和版本不变；验收后改成 `## v2.1 · 日期`。
- 核心库核对 `format`，不核对最低版本，所以开发期间不会因为版本号没升而报错。

---

## 四、两个仓库提交什么、排除什么

**原则：只提交"别人拿到仓库后需要、而且不能自动生成"的文件。**例外是模板的成品：它本身就是交付物，`git diff dist/` 是审查改动的固定步骤，照旧提交。

### 1. 两个仓库都排除

| 类别 | 规则 |
|---|---|
| 系统、编辑器 | `.DS_Store`、`Thumbs.db`、`.idea/`、`.vscode/`、`*.swp`、`*~` |
| 临时、缓存 | `__pycache__/`、`*.pyc`、`.pytest_cache/`、`.cache/`、`tmp/`、`*.tmp`、`*.log` |
| 密钥、凭据 | `.env`、`.env.*`（`!.env.example`）、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`*.keystore`、`id_rsa*`、`id_ed25519*`、`credentials*.json`、`*.secret`、`secrets.*`、`.secrets/`、`.npmrc`、`.netrc` |
| Claude Code 个人设置 | `.claude/settings.local.json`、`CLAUDE.local.md` |
| 压缩包 | `*.zip`、`*.tar.gz`、`*.7z` |

### 2. 主仓库另外排除

| 类别 | 规则 |
|---|---|
| 模板仓库 | `/templates/`（开头的 `/` 表示只排除根目录这一个，不误伤 `.claude/skills/*/templates/` 之类） |
| 个人健康数据 | `/profiles/` |
| 依赖和构建产物 | `node_modules/`、`apps/*/dist/`、`packages/*/dist/`、`*.tsbuildinfo`、`coverage/`、`test-results/`、`playwright-report/` |
| 编排器导出的媒体 | `*.webm`、`*.wav`、`*.mp4`、`*.srt`；测试样例例外：`!contracts/fixtures/**`、`!**/test/fixtures/**` |

编排器成品 `养夏跟练编排器.html` 是构建产物，不提交；`package-lock.json` 要提交。

另放一个 `.ignore`，内容 `!/templates/`：Claude Code 的搜索（ripgrep）默认遵守 `.gitignore`，实测从根目录搜不到 `templates/`；加了这个文件就能搜到，`profiles/` 仍然搜不到（个人数据只按文件名明确读取）。

### 3. 模板仓库另外排除

`.venv/`、`dist/manual.html`。`dist/` 里的成品、`img/`、`manifest.json`、PDF 手册照旧提交。

### 4. 提交前检查

- 两个仓库各有一个 `.githooks/pre-commit`（Python 写，只用标准库）。主仓库 `npm run setup`、模板仓库 `python3 tpl.py setup` 负责执行 `git config core.hooksPath .githooks`。
- 用 `git diff --cached --name-only -z` 取文件名（默认输出会把中文路径转成 `"\345…"`，按前缀匹配会漏掉）。
- 拒绝提交的情况：
  - 路径落在 `profiles/`、`.env*`（`.env.example` 除外）或密钥类后缀上；
  - 内容含私钥头（`BEGIN … PRIVATE KEY`）或常见令牌格式（`sk-…`、`ghp_…`、`github_pat_…`、`AKIA…`）；
  - 内容含 `yangxia.profile/1` 或 `yangxia.session/1`，但不在 `contracts/fixtures/` 下（防止有人把个人档案挪到别的目录提交）；
  - 单个文件超过 5 MB（模板 PDF 手册例外）。
- `--no-verify` 会跳过检查：AGENTS.md 规定 agent 不准用，`.claude/settings.json` 里再用权限规则禁止 `git commit --no-verify`。
- **验收**：`git check-ignore --no-index` 逐条测忽略规则；再用 `git add -f .env`、`git add -f profiles/测试/档案.md` 试提交，确认被拦住。

---

## 五、编排器：留在浏览器，改用 TypeScript

### 1. 技术栈

| 层 | 用什么 | 说明 |
|---|---|---|
| 课程核心 `@yangxia/course-core` | **TypeScript，零运行时依赖** | 课程格式校验、节奏、时间轴、SRT 字幕、背景音乐压低的时间窗、课程检查命令。浏览器、Node、小程序、以后的服务器都能用 |
| 编排器 `apps/sequencer` | **TypeScript + Vite + Preact** | 音频、画面、导出不用框架；控制面板用 Preact |
| 打包 | `vite-plugin-singlefile` | 输出单个 `养夏跟练编排器.html`，双击打开、离线可用 |
| 测试 | Vitest（核心库）+ Playwright（编排器冒烟测试） | |
| 包管理 | npm workspaces | 根目录统一命令：`npm test`、`npm run build`、`npm run setup`、`npm run course -- check …` |

依赖选发布超过两周的稳定版本，写死版本号，`package-lock.json` 一起提交。模板部分仍然只用 Python 标准库。

### 2. 去品牌、不做兼容

- 所有"Keep 原版 / Keep 经典"换成描述性说法；下载文件名、本地存储键、JSON 标识全部换新。
- 没有历史编排数据，不做旧格式导入、不迁移本地存储。
- 不再提供"实时录制"兜底（原版在浏览器不支持 WebCodecs 时用它，比如透明背景模式）：新版要求浏览器支持 WebCodecs，不支持时明确提示。透明背景模式一并去掉，抠像用绿幕或品红幕。

### 3. 怎么保证移植没走样

原版就是基准，不需要先做一个中间版：
- **先给原版建基线**：用 Playwright 打开原版，选"只用内置语音"，把两处随机数固定住，对几个短课程记下**总时长、每次报数的起点、SRT 最后一条的时间**。
- **新版对同样的课程逐项比**：只比两边都能表达的课程（如原版 `1-2` 节奏、60 BPM = 新版发力 1 秒、下放 2 秒）。
- **功能清单逐项确认**：导出 WebM / WAV / SRT、绿幕和品红抠像、语音报数、领呼、鼓点、背景音乐自动压低、自定义背景音乐、录制自己的报数声、路线图跳转……去掉的功能写明原因。
- 新版语音的随机噪声也能注入种子，测试时结果固定。

### 4. Playwright 冒烟测试

- 无头浏览器里没有系统语音，测试一律用"只用内置语音"。
- 样例课程要短（30 秒内），断言 WAV 时长、SRT 最后一条的时间，不只看"导出成功"。
- WebM（VP8/VP9 + Opus）在 Chromium 里可用；MP4 不在本次范围（Playwright 自带的 Chromium 不一定有 H.264/AAC 编码器）。

---

## 六、课程格式和联动

### 1. 原则

- **一份约定、多种语言**：`contracts/course.schema.json` 是唯一定义；TypeScript 类型由它生成；别的语言可以用 quicktype 之类的工具生成代码。
- **共享样例**：`contracts/fixtures/` 放合格 / 不合格的课程样例、一份模板 manifest 样例；核心库的单元测试只依赖这些样例，**安全相关测试不因模板缺失而跳过**。
- **内容和外观分开**："练什么"和"编排器怎么播"分成两块，别的项目只读第一块。
- **能回溯**：每个课程带 `id`、格式版本、出处（成品、模板版本、第几周哪天、原文）。
- **向前兼容**：读的一方忽略不认识的字段；破坏性改动才升大版本。

### 2. 课程格式 `yangxia.course/1`（草案）

```json
{
  "schema": "yangxia.course/1",
  "id": "c_2f9a…",
  "name": "18-39 居家 · 第 3 周 · A 日",
  "age": "a18",
  "source": {"product": "18-39岁-居家版", "templates": "v2.1", "week": 3, "day": "A"},
  "blocks": [
    {"kind": "sets", "items": [
      {"exercise": "split-squat-bw", "name": "分腿蹲", "mode": "reps", "sets": 3, "reps": 10,
       "perSide": true, "tempo": {"up": 1, "top": 0, "down": 3, "bottom": 0}, "rest": 90,
       "quote": "3 组 × 每侧 10 次，下放 3 秒"}
    ]},
    {"kind": "circuit", "rounds": 3, "restBetweenRounds": 60, "items": [
      {"exercise": "plank", "name": "平板支撑", "mode": "timed", "duration": 30, "rest": 15,
       "quote": "平板支撑 30 秒"}
    ]}
  ],
  "presentation": {"sequencer": {"bpm": 60, "…": "音色、鼓点、画面等"}}
}
```

- **`age`**：沿用模板的年龄段代码（`a13` `a18` `a40` `a65`），和 manifest 里的 `age` 字段一致。
- **节奏以秒为单位**：`up`（发力）、`top`（顶点停）、`down`（下放）、`bottom`（底部停）。BPM 只管背景鼓点，不影响动作时长。原版的四种节奏都能表达（`1-2` 在 60 BPM = 1/0/2/0）。
- **`perSide`**：每侧各做一遍；字幕和画面提示"左侧 / 右侧"（内置语音没有这两个字）。
- **`blocks`**：`sets` 是做完一个动作的所有组再换下一个；`circuit` 是几个动作轮流做几轮。
- **区间取较轻松的一端**：次数、组数、动作时长取下限，休息时间取上限（如"12–15 次"取 12，"休息 45–60 秒"取 60）；以后加量由周复盘按成品规则决定。检查命令会核对这一点。
- **`quote`**：每一项都带成品里的原文。

### 3. 课程检查命令（防止 agent 自编处方）

`npm run course -- check <课程.json> [--profile <档案目录>]`：
- 格式、数值范围（按模板实际需要放宽，超出就报错，不悄悄改）；
- 动作必须在 manifest 的动作索引里，而且适用于这个年龄段和场地；
- **每项的 `quote` 必须逐字出现在这份成品里、而且出现在 `source` 指定的那一周（或不分周的动作库、训练流程章节）里**，课程里的组数、次数、秒数必须和原文一致（区间按上面的规则取）；不允许把第 4 周的处方抄进第 1 周；
- 所有字幕和画面文字过一遍这个年龄段的红线词；语音只能用内置词表里的说法；
- 带 `--profile` 时：档案里安全筛查有任何一项"是"，直接拒绝。
- 只导出 **8 份训练成品**（18–39、40–64 各三份、13–17 岁、65 岁以上）；6–12 岁版写明"不用组数、不用次数"，全家餐饮模板没有训练，都不导出。

### 4. 练完的记录要回来

`yangxia.session/1`：哪个课程、开始和结束时间、每项完成几组、跳过了哪些、主观感受（轻松 / 正好 / 吃力）、有没有疼痛或头晕。编排器练完可以导出，放进 `profiles/<代号>/打卡/`，周复盘读它。

### 5. 由浅到深的四种接法

| 层 | 怎么接 | 什么时候做 |
|---|---|---|
| ① 文件 | 课程 JSON 进；WAV / SRT / 视频 + 练习记录出 | 本次 |
| ② 代码包 | 别的 JS / TS 项目直接用 `@yangxia/course-core` | 核心库稳定后发布 |
| ③ 嵌入 | iframe + `postMessage` 发课程、收事件 | 有需求时 |
| ④ 服务 | TypeScript（Node）+ Hono + SQLite；同一套代码给 App 提供 HTTP 接口、给 agent 提供 MCP | 确实需要多设备同步时 |

其他：作息和训练日导出 `.ics`（含作息，属于个人数据，放进 `profiles/`）；手机先做 PWA；健康数据最后考虑。

---

## 七、隐私

- **如实说明**：agent 读档案、打卡时，这些内容会作为对话内容发给模型服务（Anthropic）处理。除此之外，不发往任何别的地址，不放进链接参数。
- **少记**：档案用代号不用真名；安全筛查只记"是 / 否"，不记具体病名、用药；打卡只记模板要求的项。
- **不提交**：`profiles/` 被忽略，提交前检查再按路径和格式标识兜底。
- 第 ④ 层服务上线前单独评估。

---

## 八、agent 层

| 层 | 放什么 |
|---|---|
| **AGENTS.md + docs** | 项目定位、安全底线、隐私、目录地图、命令、约定（150 行内）；模板仓库另有一份只讲维护规则 |
| **Skills** | 可重复的工作流 |
| **代码里的硬校验** | 红线词、必备项、数值范围、处方原文、安全筛查、数据格式 |

### agent 的边界（写进 AGENTS.md，能用代码查的都由代码查）

- ✅ 按问卷选版本；按作息公式算上床时间；按成品的升级规则决定下周加不加；把成品里某一天的训练导出成课程；按成品的人数换算规则排菜单。
- ❌ 自己编组数、次数、强度、官方数字（课程检查核对原文）；跳过安全筛查；给筛查有"是"的人出计划（检查命令直接拒绝，只能建议先问医生）；对 6–12 / 13–17 岁谈体重热量，对 65 岁以上安排跳跃、闭眼（红线检查）。
- 打卡或练习记录里有疼痛、头晕、胸闷：停止加量，按成品"疼了怎么办"处理，必要时建议就医。
- agent 写进 `profiles/` 的周复盘、菜单，按年龄段过一遍红线检查（`npm run profile -- check`）。

### Skills

| Skill | 放在 | 做什么 |
|---|---|---|
| `onboard` 建档 | 主仓库 | 按 manifest 的 `intake`：年龄段 → 安全筛查（任一"是"就停）→ 场地 → 起床时间；选成品、算上床时间，写档案 |
| `weekly-review` 周复盘 | 主仓库 | 读打卡和练习记录 → 按成品的达标线和升级规则判断 → 写下周安排 |
| `course-export` 导出跟练 | 主仓库 | 成品 + 周 + 天 → 生成课程（每项带原文）→ 课程检查 → 告诉用户在编排器里导入 |
| `meal-plan` 排菜单 | 主仓库 | 按全家餐饮模板的成员表、份量和人数换算规则排菜单、算采购量；`tpl.py meal` 写死了 4 口之家，只供模板维护用 |
| `sequencer-dev` 改编排器 | 主仓库 | 改源码 → `npm test` → `npm run build` → 冒烟测试 |
| `template-maintain` 改模板 | **模板仓库** | 改 `content/` → `tpl.py all` → `git diff dist/` → 记 CHANGELOG → 在模板仓库提交 |

### Hook

主仓库 `.claude/settings.json` 配"每轮结束时"检查（脚本只用 Node 自带功能）：
- 模板仓库的 `content/`、`figures/`、`tools/` 有未提交改动 → 跑 `tpl.py all`（共约 2 秒）；
- 主仓库的 `packages/`、`apps/` 有改动 → 跑单元测试（不跑 Playwright）；
- 有错就交回给 agent 修；输入里 `stop_hook_active` 为真时不再拦，避免死循环；模板不在就跳过。

---

## 九、新目录

```
YangXia/                              ← 主仓库
├── AGENTS.md  CLAUDE.md  README.md
├── package.json  package-lock.json
├── .gitignore  .ignore  .githooks/pre-commit
├── templates/                        ← 模板仓库（独立 git，主仓库忽略）
│   ├── AGENTS.md  CLAUDE.md  tpl.py
│   ├── .gitignore  .githooks/pre-commit
│   ├── .claude/skills/template-maintain/
│   ├── content/入口问卷.md  content/动作索引.md  content/params/红线词.md   ← 新增
│   └── content/ figures/ tools/ dist/ docs/
├── packages/course-core/             @yangxia/course-core
│   ├── src/  test/
├── apps/sequencer/                   @yangxia/sequencer
│   ├── src/audio/ hud/ export/ ui/
│   ├── reference/原版.html  e2e/
│   └── dist/                         构建产物（不提交）
├── contracts/
│   ├── course.schema.json  session.schema.json  profile.schema.json
│   ├── templates.json                需要的 manifest 格式号
│   └── fixtures/                     课程、档案、manifest 样例
├── profiles/                         个人数据（不提交）
├── scripts/                          setup、templates-path、hook 脚本
├── docs/
│   ├── agent 工作流.md  数据约定.md  联动接口.md  编排器功能清单.md
│   ├── 重构方案-v3（agent驱动）.md
│   └── history/新项目架构方案（v2.0）.md
└── .claude/settings.json  .claude/skills/
```

---

## 十、模板这边的具体改动

- **改名**：目录、命令、PDF 手册、manifest、README、维护指南、架构说明里的「规律生活」和 `guilv` 全部换掉（CHANGELOG 和 `docs/history/` 里的历史记录不改）。
- **红线词搬家**：`check.py` 里的禁用词、白名单、必备项搬到 `content/params/红线词.md`，一行一条（白名单短语里有"、"，不能用分隔符拼在一格里）；表上写明"示意图文字不用白名单"。验收：新表解析出的集合和 `git show HEAD:tools/check.py` 里的常量完全相等。
- **红线样例**：表里另有一节"校验样例"（文本、年龄段、应该通过还是拦下），`check.py` 和核心库都跑这批样例，保证两份实现判断一致。
- **跨 Python 版本一致**：坐标先加一个极小的偏移再四舍五入（让恰好落在 x.x5 上的值稳定地进位）；`verify` 加 `--svg-tol 0.1`，SVG 里的数字差 0.1 以内算一致（比较时留浮点余量，`78.2 − 78.1` 在计算机里是 0.10000000000000853）；CHANGELOG 记下构建用的 Python 版本。这只能让常见情况稳定，不能从数学上保证。

---

## 十一、分阶段推进

| 阶段 | 做什么 | 怎么算完成 |
|---|---|---|
| **0 两个仓库和骨架** | 模板仓库：开 `v3-refactor`；改名；坐标修正和 `--svg-tol`；`.gitignore`、提交前检查、`tpl.py setup`、短 AGENTS.md；CHANGELOG 写 `## 未发布`。主仓库：`git init`；`.gitignore`、`.ignore`、提交前检查、AGENTS.md、CLAUDE.md、README、根 `package.json`、`npm run setup`、`scripts/templates-path.mjs`；文档归位；原编排器移到 `apps/sequencer/reference/` | `tpl.py all` 0 错误 0 警告；`verify --ignore-version --svg-tol 0.1` 对改动前的成品全部一致；忽略规则和提交前检查按第四节验收；两个仓库提交的文件逐个过目 |
| **1 模板发布物** | `红线词.md`（含白名单、必备项、样例）、`动作索引.md`（8 份训练成品里的动作）、`入口问卷.md`；`check.py` 改读这些表；manifest 加 `format`、`intake`、`exercises`、`redlines`，`version` 改取 CHANGELOG | 新表解析结果和原常量完全相等；成品逐字节不变；`check.py` 新增的核对通过 |
| **2 课程核心库** | `yangxia.course/1`、`session/1`、`profile/1` 的格式和样例；节奏、时间轴、SRT、压低时间窗、语音词表、红线检查；课程检查命令 | 单元测试全部通过（只用 fixtures）；8 份训练成品各导出一天课程并通过检查；故意写错原文、超出区间、筛查为"是"的样例都被拦下 |
| **3 编排器** | 原版 Playwright 基线；**先移植内置语音合成**，固定随机种子后和原版逐个采样比对波形，一致了再继续；然后按模块移植音效、画面、导出，**每个模块单独提交**；Preact 界面；去品牌；练习记录导出；单文件打包 | 冒烟测试通过；同样的课程，总时长、报数起点、SRT 末条时间和原版基线一致；功能清单逐项确认 |
| **4 agent 工作流** | 6 个 skill、hook、权限规则、档案红线检查 | 用一个虚构档案走通：建档 → 导出第 1 周课程 → 编排器导出练习记录 → 周复盘；筛查为"是"的虚构档案被拒绝 |
| **5 对外联动（按需）** | 发布核心库、嵌入、MP4、PWA、日历、服务 + MCP | 有具体对象再开 |

每个阶段结束都在对应仓库提交一次。模板仓库合并回 `main`、CHANGELOG 改成 `## v2.1 · 日期`、打标签，等你确认后再做。

---

## 十二、独立审查记录（r5 → r6）

审查结论：方向可行，7 条"必须改"都是规则、文字和阶段顺序，改完可以开始阶段 0。逐条处理：

| # | 审查意见 | 处理 |
|---|---|---|
| 必须 1 | `templates/`、`profiles/` 会误伤同名子目录；媒体规则会排除测试样例 | 改成 `/templates/`、`/profiles/`；加 fixtures 例外（第四节） |
| 必须 2 | 提交前检查遇到中文路径会漏；模板仓库单独克隆时没人设置 hook；`--no-verify` | 用 `-z` 取路径；加 `tpl.py setup`；权限规则禁止 `--no-verify`；用 `git add -f` 验收（第四节） |
| 必须 3 | CHANGELOG 新条目会改封面日期；`version` 两个来源；开发期最低版本核对会一直报错 | 开发期写 `## 未发布`；`version` 只取 CHANGELOG；核心库核对 `format` 不核对版本（第三节） |
| 必须 4 | 问卷不在发布物里；`tpl.py meal` 写死 4 口之家；改模板的 skill 和"只读发布物"矛盾；hook 写死路径 | `intake` 进 manifest；排菜单按成品的换算规则；`template-maintain` 放进模板仓库；统一的路径查找（第三、八节） |
| 必须 5 | 阶段顺序颠倒（核心库要用的数据在后面的阶段才有） | 模板发布物提到阶段 1；核心库测试只依赖 fixtures（第十一节） |
| 必须 6 | 6–12 岁和全家餐饮不能导出课程；`audience` 字段名用错 | 改成"8 份训练成品"；字段改为 `age`（第六节） |
| 必须 7 | "不发往任何外部地址"不符合实际 | 如实写明会发给模型服务；少记；按格式标识兜底（第七节） |
| 建议 1 | 课程格式缺"每侧""循环""区间""顶点停"；节奏单位不清；动作索引不该用图号当键 | 加 `perSide`、`blocks`、区间取下限；节奏改成秒；动作索引用自己的 ID，图号作为可选列 |
| 建议 2 | "不自编处方"没有代码兜底 | 每项带原文，检查命令逐字核对；筛查为"是"直接拒绝；档案写入过红线 |
| 建议 3 | 白名单和必备项也要搬；验收应比解析集合 | 照做，另加两边共用的红线样例 |
| 建议 4 | 语音说不出人群提示；先原样移植再重构；听感对比改成可检验 | 人群提示只走字幕和画面；随机数可注入种子；改为对比总时长、报数起点、SRT 末条。**没有采纳"先做一个原样移植的中间版"**：原版本身就能用 Playwright 建基线，效果相同，省一次移植 |
| 建议 5 | Playwright 的语音、时长断言、MP4 | 照做；MP4 不在本次范围 |
| 建议 6 | 两段舍入不能保证一致 | 改为偏移舍入 + `verify --svg-tol`，并如实写明局限 |
| 建议 7 | 文档里残留旧名；搜索看不到 `templates/`；hook 只跑单测 | 改名范围扩大到文档；加 `.ignore`（已实测）；hook 不跑 Playwright |
| 可以不管 | `secrets*` 误伤文件名等 | 顺手改成 `secrets.*`、`.secrets/`、`*.secret` |

**复核（r6）**：7 条必须改全部解决；接受"用原版建基线、不做中间版"，条件是编排器按模块分次提交、先移植语音合成并逐采样比对。复核新提出 1 条必须改和 2 条提醒，已处理：

| 意见 | 处理 |
|---|---|
| 必须：休息也取下限，等于休息最短、强度最高 | 改成"取较轻松的一端"：次数、时长取下限，休息取上限（第六节） |
| 建议：原文核对要限定在指定的那一周 | 已加（第六节第 3 条） |
| 提醒：权限规则拦不住 `git commit -n` 等写法 | 权限规则同时禁止 `-n`；但它只是辅助，主要靠 AGENTS.md 和提交前检查 |
| 提醒：`--svg-tol` 要留浮点余量 | 已写明（第十节） |
