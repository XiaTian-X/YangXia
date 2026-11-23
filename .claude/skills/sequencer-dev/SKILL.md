---
name: sequencer-dev
description: 维护养夏跟练编排器和课程核心库（apps/sequencer、packages/course-core）：改代码、跑测试、和原版比对、打包单文件。改编排器的声音、画面、导出、界面，或者改课程格式、时间轴、课程检查时用。
---

# 改编排器和课程核心库

## 每次改完

```bash
npm test
npm run typecheck
npm run e2e
```

- `npm test`：单元测试。包括和原版比对：内置语音逐采样、语音长度、4 个样例课程的时间轴。
- `npm run e2e`：用离线样例的动图打包到 `dist-e2e/`，再用 Playwright 跑一遍导入、跟练（暂停、跳段）、练完、导出 WAV / SRT / WebM，动作示意的显示、节拍和视频读回，以及五种尺寸的排版（`layout.spec.ts`）。按界面操作的共用步骤在 `e2e/ui.ts`。

三条都过了才算改完。每轮结束时的 hook 会自动跑单元测试。

## 规则

- **课程格式** `contracts/course.schema.json` 是唯一定义。
  - 改了格式，要同步 `packages/course-core/src/types.ts` 和 `validate.ts`，再加合格和不合格样例到 `contracts/fixtures/courses/`。
  - 破坏性改动才升大版本（`yangxia.course/2`），读的一方要能把上一版升上来。
- **课程检查**是防止 agent 自编处方的唯一关口。
  - 只能加严，不能为了让某个课程通过而放松。
  - 加了规则就加一条"被拦下"的测试（`packages/course-core/test/check.test.ts`）。
- **和原版的一致性**：改了时间轴或语音合成，导致 `test/original.test.ts` 不再一致的，先确认是有意的改动，在 `docs/编排器功能清单.md` 写明原因，再更新测试。v4 阶段 8 起，原版比对用时间轴的兼容开关 `legacy: true` 加原版的报法（做完时报数、领 2 次 + 提示音）；新的默认报法、"一，吸"拼句不进原版比对。
- **模板更新后**重新生成离线样例：`node packages/course-core/test/make-fixtures.ts`。
- **不再出现 Keep**（标题、页面文字、选项、文件名、存储键、视频元数据）；冒烟测试会查。打包进来的第三方库和授权全文不算。
- **动作示意**：编排器只认课程的 `figure`，帧号由核心库 `motionAt` 算，实时和导出都走 `src/figure/hud.ts`，不要各写一套。动图引擎必须先 `setWasmUrl` 指向内嵌文件；页面的内容安全策略不放行任何外部地址。升级依赖时同步 `docs/第三方授权.md`。
- **依赖**：选发布超过两周的稳定版本，写死版本号，`package-lock.json` 一起提交。
- **构建产物**（`apps/sequencer/dist/`、`dist-e2e/`）和导出的媒体不提交。
- 新功能、去掉的功能，记进 `docs/编排器功能清单.md`。
- **界面**（v4 阶段 8b）：照设计画布 <https://claude.ai/artifact/RmVjkphomSGpQ3xd7qAMSE> 还原，颜色、字号都是 `src/styles.css` 开头的变量；改界面先出设计稿再实施。页面在 `src/ui/`（`App.tsx` 接线，`Today`、`LiveView`、`DoneView`、`Settings`、`MoreView`），跟练页显示什么由纯函数 `src/live/view.ts` 算（有单元测试），不在组件里拼。跟练页和导出的视频画面（`src/hud/draw.ts`）分开，视频画面不随界面改。五种尺寸（390×844、844×390、360×800、820×1180、1440×900）和几种手机浏览器带工具栏的实际可视高度都要过 `layout.spec.ts`（跟练页各块两两不重叠）。跟练页的呼吸环按中间一格剩下的空间缩放（`--info-h` 由 `LiveView` 量），不要写死高度。跟练页的声明写全文（未经专业审核、不是医学建议、不能替代医生的判断；疼、头晕、胸闷马上停下）。
