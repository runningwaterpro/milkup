import { cloneWithInlineStyles } from './inlineStyles'

export interface ClipboardPayload {
  plain: string
  html: string
}

/** 选区相关的块级标签（票 01–03 范围；公式/mermaid 不在列）。 */
const BLOCK_SELECTOR
  = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,table,td,th,tr,ul,ol,hr'

/** 邮件友好浅色基线（票 02）：暗色主题下覆盖易翻车的颜色。 */
const LIGHT_COLOR = '#333333'
const LIGHT_BG = 'rgb(255, 255, 255)'

/**
 * 主 seam：选区 Markdown + 选区根（或编辑器内选中块宿主）→ 双格式载荷。
 * plain = Markdown 源码；html = 语义结构 + 内联样式（邮箱可消费）。
 */
export function buildClipboardPayload(
  markdown: string,
  selectionRoot: HTMLElement | null,
): ClipboardPayload {
  const plain = markdown
  if (!selectionRoot)
    return { plain, html: '' }

  const host = document.createElement('div')
  if (selectionRoot.matches('[data-clipboard-host]')) {
    host.innerHTML = selectionRoot.innerHTML
  } else if (selectionRoot.matches(BLOCK_SELECTOR)) {
    host.appendChild(cloneWithInlineStyles(selectionRoot))
  } else {
    for (const child of Array.from(selectionRoot.children)) {
      if (child instanceof HTMLElement)
        host.appendChild(cloneWithInlineStyles(child))
    }
    if (!host.childElementCount && selectionRoot instanceof HTMLElement) {
      host.appendChild(cloneWithInlineStyles(selectionRoot))
    }
  }

  stripEditorChrome(host)
  applyLightBaseline(host)
  return { plain, html: host.innerHTML }
}

/** 从编辑器 DOM + 当前 Selection 收集相交块，克隆为带样式的宿主。 */
export function selectionStyleHost(editorDom: HTMLElement): HTMLElement | null {
  const sel = globalThis.getSelection?.()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed)
    return null

  const range = sel.getRangeAt(0)
  const host = document.createElement('div')
  host.setAttribute('data-clipboard-host', '')

  for (const block of editorDom.querySelectorAll(BLOCK_SELECTOR)) {
    if (block instanceof HTMLElement && range.intersectsNode(block))
      host.appendChild(cloneWithInlineStyles(block))
  }

  if (!host.childElementCount) {
    const node = range.commonAncestorContainer
    const el = node instanceof Element ? node : node.parentElement
    if (el && editorDom.contains(el) && el instanceof HTMLElement)
      host.appendChild(cloneWithInlineStyles(el))
  }

  if (!host.childElementCount)
    return null

  stripEditorChrome(host)
  applyLightBaseline(host)
  return host
}

function stripEditorChrome(root: HTMLElement): void {
  root.querySelectorAll(
    '.milkdown-block-handle,.crepe-drop-cursor,.milkdown-toolbar,.milkdown-link-preview,.milkdown-link-edit,.milkdown-slash-menu,[data-ignore]',
  ).forEach(n => n.remove())
  root.querySelectorAll('[contenteditable]').forEach((n) => {
    n.removeAttribute('contenteditable')
  })
}

/** 暗底/亮字 → 浅色邮件基线；已在浅色上的不动。 */
function applyLightBaseline(root: HTMLElement): void {
  const nodes = [root, ...root.querySelectorAll<HTMLElement>('*')]
  for (const el of nodes) {
    // 克隆宿主可能未挂载：优先读已写入的内联样式
    const bg = el.style.backgroundColor || getComputedStyle(el).backgroundColor
    const color = el.style.color || getComputedStyle(el).color
    if (isDark(bg))
      el.style.backgroundColor = LIGHT_BG
    if (isVeryLight(color))
      el.style.color = LIGHT_COLOR
  }
}

function parseRgb(value: string): [number, number, number] | null {
  const m = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  if (!m)
    return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function luminance([r, g, b]: [number, number, number]): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

function isDark(color: string): boolean {
  const rgb = parseRgb(color)
  if (!rgb)
    return false
  // 透明/近白背景不算暗
  if (color.includes('rgba') && color.includes(', 0)'))
    return false
  return luminance(rgb) < 0.2
}

function isVeryLight(color: string): boolean {
  const rgb = parseRgb(color)
  if (!rgb)
    return false
  return luminance(rgb) > 0.85
}
