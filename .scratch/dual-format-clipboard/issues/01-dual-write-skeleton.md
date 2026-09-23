# 01: 双写骨架：段落+粗体可进邮箱

**What to build:** 在编辑器内复制或剪切后，剪贴板同时含有 Markdown 纯文本与渲染 HTML。用户选中「段落 + 粗体」内容：粘贴到网页邮箱显示格式；粘贴到记事本仍是 Markdown 源码。实现主 seam 为纯函数 payload（选区 → `{ plain, html }`），并从现有导出能力薄抽共用内联逻辑（不改变导出对外行为）。

**Blocked by:** None (can start immediately).

**Status:** done（自动化已过；邮箱/记事本待人工）

- [x] 复制/剪切后，剪贴板同时存在 plain（Markdown）与 html（语义标签 + 内联样式）— 代码路径 + 单测
- [x] 段落与粗体粘贴到网页邮箱后格式正确 — **单测断言 html 含 p/strong/style**；真邮箱待人工
- [x] 同一次复制粘贴到记事本为 Markdown 源码 — plain 单测
- [x] 主 seam 单测通过：`buildClipboardPayload`（8 tests）
- [ ] 导出 HTML / PDF / Word 抽查无回归 — **待人工**（薄抽共用，行为未改）
- [x] 不修改 Electron 应用菜单 `role:copy`
