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
- `npm run e2e`：打包单文件，再用 Playwright 跑一遍导入、跟练、导出 WAV / SRT / WebM。

三条都过了才算改完。每轮结束时的 hook 会自动跑单元测试。

## 规则

- **课程格式** `contracts/course.schema.json` 是唯一定义。
  - 改了格式，要同步 `packages/course-core/src/types.ts` 和 `validate.ts`，再加合格和不合格样例到 `contracts/fixtures/courses/`。
  - 破坏性改动才升大版本（`yangxia.course/2`），读的一方要能把上一版升上来。
- **课程检查**是防止 agent 自编处方的唯一关口。
  - 只能加严，不能为了让某个课程通过而放松。
  - 加了规则就加一条"被拦下"的测试（`packages/course-core/test/check.test.ts`）。
- **和原版的一致性**：改了时间轴或语音合成，导致 `test/original.test.ts` 不再一致的，先确认是有意的改动，在 `docs/编排器功能清单.md` 写明原因，再更新测试。
- **模板更新后**重新生成离线样例：`node packages/course-core/test/make-fixtures.ts`。
- **不再出现 Keep**（标题、选项、文件名、存储键、视频元数据）；冒烟测试会查。
- **依赖**：选发布超过两周的稳定版本，写死版本号，`package-lock.json` 一起提交。
- **构建产物**（`apps/sequencer/dist/`）和导出的媒体不提交。
- 新功能、去掉的功能，记进 `docs/编排器功能清单.md`。
