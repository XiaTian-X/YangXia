# 养夏

帮人从**作息、锻炼、饮食**三方面建立习惯的项目，由 AI agent 驱动。

> 这些计划**不是医学建议，不能替代医生的判断**。有慢性病、伤病、怀孕等情况，先问医生。

## 由什么组成

| 部分 | 是什么 | 在哪 |
|---|---|---|
| **养夏计划模板** | 按年龄段和场地分的四周计划（运动、三餐、睡眠），10 份成品 + 菜谱手册 + 动作图解 | `templates/`（独立仓库 YangXia-templates），用法见 `templates/README.md` |
| **养夏跟练编排器** | 把一天的训练编成带语音报数、呼吸提示的跟练音频、视频和字幕 | `apps/sequencer/`（重构中；重构前的版本在 `apps/sequencer/reference/原版.html`） |
| **养夏课程核心库** | 课程格式、时间轴、字幕、课程检查，编排器和别的项目共用 | `packages/course-core/`（待建） |
| **agent 工作流** | 建档、导出跟练课程、周复盘、排菜单 | `AGENTS.md`、`.claude/skills/`（待建） |

## 开始

需要 Node 22 以上、Python 3.9 以上、git。

1. 把模板仓库放在 `templates/`，或者设置环境变量 `YANGXIA_TEMPLATES` 指向它。
2. 启用两个仓库的提交前检查：

   ```bash
   npm run setup
   ```

3. 只想看计划：直接打开 `templates/dist/` 里的成品，先读 `templates/README.md` 选对版本。

## 文档

- `AGENTS.md`：给 AI agent 看的总纲（安全底线、隐私、提交规则）。
- `docs/重构方案-v3（agent驱动）.md`：现在的重构方案和进度。
- `docs/history/`：历史方案。

## 个人数据

档案、打卡、练习记录只放在本地的 `profiles/`，不进 git；提交前检查也会拦截。
