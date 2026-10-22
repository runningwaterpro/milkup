# 落点唯一：1.0.18 主树（src/core）

双格式剪贴板最初在 0.4.8 的 Crepe 树（分支 `feat/dual-format-clipboard`）上开发，该分支落后主树 251 个提交；同一功能已以 PR #259 进入上游主树的 `src/core/clipboard.ts`。决定：新功能只在主树上做，旧分支不移植、归档冻结；旧分支唯一未进主树的改动（stdout 管道关闭时忽略 EPIPE）单独移植。这样避免把已被更大重构取代的旧编辑器与半成品 store 层塞回新架构。

## Considered Options

- **把旧分支的 26 个提交移植进主树**：旧分支多出的 12 个提交是同一功能的早期实现，其余是旧 Crepe 架构的组件搬移与 store 化改造。主树走 hooks 路线且功能等价，移植等于产品倒退。
- **两棵树同时做**：同一功能两套实现、两套剪贴板底座，后续无法收敛。

## Consequences

- 旧分支的 store 化改造（`src/renderer/stores/modules/*`、`services/deprecated`）不再演进，视为废弃方向。
- 旧分支的 `feat/dual-format-clipboard` 分支在功能对账清零后删除；其 EPIPE 守卫需单独移植，否则删除即丢失。
