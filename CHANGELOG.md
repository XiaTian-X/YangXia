# 更新记录（主仓库 YangXia）

模板仓库（YangXia-templates）的改动记在 `templates/CHANGELOG.md`。重构方案和每个阶段的验收标准见 `docs/重构方案-v3（agent驱动）.md`。

## 未发布 · 2026-11-08

按重构方案 r6（经独立审查）实施阶段 0–4。

### 阶段 0：骨架
- 新建主仓库：AGENTS.md / CLAUDE.md / README、`.gitignore`（`/templates/`、`/profiles/`、构建产物、导出媒体、密钥等）、`.ignore`（让搜索能看到 templates/）。
- 提交前检查 `.githooks/pre-commit`（和模板仓库同一份），`npm run setup` 同时启用两个仓库。
- `scripts/templates-path.mjs`：找模板仓库的唯一规则（`YANGXIA_TEMPLATES` 或 `./templates`）。
- `.claude/settings.json`：禁止 `git commit --no-verify` / `-n`。

### 阶段 2：养夏课程核心库
- `contracts/`：课程 `yangxia.course/1`、练习记录 `yangxia.session/1`、个人档案 `yangxia.profile/1` 的 JSON Schema，模板 manifest 格式约定。
- `packages/course-core`：节奏（秒为单位，和原版四种节奏一一对应）、时间轴（计时规则照原版移植）、SRT、课程检查（原文逐字、周次、数字出处、区间取较轻松一端、节奏、字幕红线、语音词表、安全筛查）。
- 样例覆盖 8 份训练成品。

### 阶段 3：养夏跟练编排器
- TypeScript + Vite + Preact，打包成单个离线 HTML `养夏跟练编排器.html`。
- 内置语音合成和原版逐采样一致；4 个样例课程的时间轴和原版一致；Playwright 冒烟测试覆盖导入、跟练、导出 WAV / SRT / WebM、练习记录。
- 去掉 Keep 品牌、旧数据兼容、实时录制兜底和透明背景；对照见 `docs/编排器功能清单.md`。

### 阶段 4：agent 工作流
- skills：onboard、course-export、weekly-review、meal-plan、sequencer-dev（模板仓库里另有 template-maintain）。
- 命令：`npm run course -- intake / bedtime / moves`、`npm run profile -- check`。
- Stop hook（`scripts/stop-check.mjs`）：模板有改动就跑 `tpl.py all`，主仓库有改动就跑单元测试；有错就让 agent 先修。
- 用虚构档案走通"建档 → 导出第 1 周 A 日 → 编排器跟练并导出练习记录 → 周复盘"；筛查有"是"的档案、13–17 岁复盘里写"体重"都被拦下。
- 已知限制：左右交替的动作（死虫式、平板肩点）暂不导出；课程检查核对不出原文是不是"这一天"的动作。
