# ADR-0001: 复制时双写 plain Markdown 与渲染 HTML

## 状态

已接受（grilling 共识，2026-09）

## 背景

在 Milkup 编辑器复制后粘贴到邮箱/Word，仅得到 Markdown 源码。Typora 等编辑器一次复制提供两份数据，目标应用各取所需。上游 issue #258；表格相关 #252。

## 决策

1. 编辑器内复制/剪切 **默认双写**：
   - `text/plain`：选区 **Markdown** 源码（与今日纯文本行为一致）；
   - `text/html`：**选区渲染 DOM** 序列化 HTML，并做内联样式。
2. HTML 样式：以计算样式为底 + **邮箱安全收敛**；暗色主题使用 **浅色基线**。
3. 不依赖 Typora 私有 `mdtype` / `md-inline` 等属性（可选增强，非门槛）。
4. 优先在 **main（Milkdown/Crepe）** 实现；贡献经 **fork → 上游 PR**。
5. 实现时优先从现有导出能力 **薄抽**共用“克隆/内联”逻辑，不重构导出行为。

## 后果

- 邮箱、Word 走 HTML；记事本、md 编辑器走 plain。
- 需覆盖表格与代码块以达 DoD（含 Word 真表格）。
- 不处理“粘贴进 Milkup”的富文本解析（另 issue）。
