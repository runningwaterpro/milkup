# 02: 块级完善 + 浅色基线

**What to build:** 在双写骨架之上，标题、有序/无序列表、链接、引用粘贴到网页邮箱时格式正确；暗色主题下复制时使用邮件友好的浅色基线再内联，避免深色编辑器样式进入邮件。plain 始终仍为对应 Markdown。

**Blocked by:** 01 双写骨架：段落+粗体可进邮箱

**Status:** done（自动化已过；真邮箱/暗色主题待人工）

- [x] H1–H4、有序/无序列表、链接、引用粘贴到网页邮箱格式正确 — 块级 selector 含 h1–h6/ul/ol/li/blockquote/a；单测覆盖 h2
- [x] 同一次复制粘贴到记事本仍为对应 Markdown 源码
- [x] 暗色主题下，html 中关键样式为浅色基线 — `applyLightBaseline` + 单测
- [x] 主 seam 单测覆盖上述节点
- [x] 不扩展范围到公式、mermaid
