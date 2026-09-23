# CONTEXT — Milkup 双格式剪贴板（对齐 Typora 出口）

## 领域术语（Ubiquitous language）

| 术语 | 含义 |
|------|------|
| 双格式剪贴板 | 一次复制同时写入 `text/plain` 与 `text/html` |
| 纯文本载荷 / plain | `text/plain`：选区 Markdown 源码 |
| 渲染载荷 / rich HTML | `text/html`：所见渲染的语义 HTML + 内联样式 |
| CF_HTML | Windows 对 `text/html` 的外壳格式；由系统/`clipboardData` 打包 |
| 选区 DOM | 编辑器内当前选区对应的已渲染节点 |
| 邮箱安全收敛 | 去掉仅编辑器使用的样式、暗色主题有害样式，保证邮件/Word 可用 |
| 浅色基线 | 暗色主题下复制时强制使用的邮件友好浅色计算样式底 |
| 双写 | 默认 `Ctrl+C`/剪切同时写 plain + html |
| 第一版 / MVP | 三张垂直切片票完成后达到 B5-b DoD |
| 主仓库 / 上游 | `Auto-Plugin/milkup` |
| 工作仓库 / fork | 贡献者自己的 GitHub fork；先改 fork，验证后再向上游提 PR |

## 已定决策（摘要）

- 对齐 Typora **复制出口**，不强制 Typora 私有 `md-*` 属性。
- 主路径：选区渲染 DOM → HTML，而非 Markdown 再解析。
- 落点：先 main + Milkdown/Crepe；v2 后移植。
- 交互：编辑器内默认双写；不改 Electron 菜单 `role:copy`（除非实测丢 HTML）。
- 图片：保留 `img` + 可访问 src；失败不删节点。
- 发布流程：贡献在 **fork** 上进行，通过后向 **上游** 提 PR。
- 票据：先本地 `.scratch`，人工确认后再上 GitHub（B7-c）。

详细决策见 ADR-0001 与 issue #258。
