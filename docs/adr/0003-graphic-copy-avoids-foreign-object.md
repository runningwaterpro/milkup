# 复制用的图形要避开 foreignObject

Chromium 会把含 `foreignObject` 的 SVG 判为污染画布，`canvas.toDataURL()` 直接抛 SecurityError。而 mermaid 默认用 HTML 标签渲染，标签就落在 `foreignObject` 里，所以照着屏幕上的 SVG 导不出位图。决定：复制时用 `htmlLabels: false` 重新渲染一份 mermaid，标签变成 SVG 文本，再栅格化成 PNG；屏幕上的渲染保持 `htmlLabels: true` 不变。

## Consequences

- 复制出来的图与屏幕上的图不完全一样：标签排版按 SVG 文本算；留白与文字对比度仍按屏幕上的规则补齐。
- 仓库里原有的 PNG 兜底（`rasterizeElement`）对含 `foreignObject` 的内容同样导不出，它只对纯 SVG 生效。
- 数学公式这类只有 HTML 渲染结果的图形走不了同一条路，需要另外的产出方式。
