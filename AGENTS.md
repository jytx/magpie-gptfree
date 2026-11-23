# Notes for coding agents

## 修复与功能的提交时机

- 修复 BUG 或新增功能并验证通过（测试 / `npm run check` / 实际运行）后，**必须第一时间 commit 并 push 到 dev 分支**，不允许改动停留在未提交状态。
- 原因：本仓库是 magpie 的 git 依赖（`https://github.com/jytx/magpie-gptfree#dev`）。magpie 侧每次 `bun install` / 插件更新都会对安装目录 `reset --hard`，未提交的改动会被直接清掉——2026-11 的 GUI 端口保活修复就因此被抹掉过一次，导致问题复发。
- 提交规范：
  - 信息格式 `feat:` / `fix:` / `refactor:` 前缀 + 中文描述，禁止任何 AI 助手署名；
  - 一次提交只做一件事，暂存区只放本次相关内容，无关文件（如临时调研文档）绝不混入；
  - 改动推送到 `origin/dev` 后，magpie 下次安装/更新拿到的即是修复后的代码。

## 代码与测试

- 提交前至少跑通：`node --check` 覆盖改动文件、`node --test test/*.test.mjs` 中与改动相关的用例。
- 注释使用中文，函数保持功能单一、参数显式声明。
