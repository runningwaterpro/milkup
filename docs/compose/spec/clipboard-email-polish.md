---
feature: clipboard-email-polish
status: delivered
updated: 2026-09-24
branch: feat/dual-format-clipboard
commits: 7e2c658..HEAD
---

# Clipboard Email Polish

## Report

**What was built** — 剪贴板 HTML 导出对邮箱场景做了三处抛光：只收集顶层块（不再拆碎 `li`/`td`）；表格与单元格强制内联网格边框；有序列表 `start` 缺失或 ≤0 时改为 1；非等宽文本补 Helvetica/Arial 无衬线栈，避免落入 Times 衬线缺省。plain 仍为 Markdown，双写行为不变。

**Verification** — `npm test` → 12/12 PASS；`eslint` 改动文件 → 0 error。主 seam：`buildClipboardPayload`。Electron 生产包已重建并重启供人工粘邮箱验证。

**Journey log**
- happy-dom 计算样式常为 Times New Roman，曾导致「衬线字体」类失败，需显式 sans 兜底。
- `BLOCK_SELECTOR` 含 `li`/`td`/`tr` 会重复克隆列表/表格，是结构异常根因之一。
- 独立 review 子代理超时取消，以 12 项单测 + 人工对照 spec 代替。

## [S1] Problem

用户实测复制粘贴到邮箱后存在三个问题：

1. 表格没有网格线（单元格边框丢失）。
2. 有序列表编号从 0 开始，期望从 1 开始。
3. 有时粘贴后字体从无衬线变为衬线（主题/缺省 font-family 不稳）。

## [S2] Design

在剪贴板 HTML 生成路径（`buildClipboardPayload` / `selectionStyleHost`）做三件事，不改 Electron 菜单、不改粘贴进编辑器的行为：

1. **选区块选择器只取顶层块**：`p`、标题、`blockquote`、`pre`、`table`、`ul`、`ol`、`hr` 等；**排除** `li`/`td`/`th`/`tr`。
2. **表格邮箱可见网格**：`table`/`th`/`td` 内联 `border-collapse` 与 `1px solid #ccc`。
3. **有序列表从 1 起**：`start` 空或 `<=0` → `start="1"`；显式 `>=1` 保留。
4. **无衬线字体兜底**：根与非 `pre`/`code` 元素写入 `Helvetica Neue, Helvetica, Arial, sans-serif`。

主 seam 仍为 `buildClipboardPayload`：对外仍是 `{ plain, html }`。

## [S3] Out of Scope

- 表格 Word 专用 XML、邮件客户端兼容矩阵扩展。
- 有序列表“续接上一列表编号”的语义增强。
- 粘贴进 Milkup、导出 Word、v2 架构。
- 修改 Electron `role:copy`。

## Tasks

- [x] T1: 修正块选择器并补表格边框 / ol start / 无衬线兜底 — acceptance: 单测覆盖「表有 border、ol start=1、html 含 sans font-family、无重复孤立 td/li」(covers: S2)
- [x] T2: 回归双写主 seam 与既有测试仍绿 — acceptance: `npm test` 全部通过 (covers: S2; depends: T1)
