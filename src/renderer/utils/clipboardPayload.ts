import { cloneWithInlineStyles } from './inlineStyles'

export interface ClipboardPayload {
  plain: string
  html: string
}

/** 顶层块：不含 li/td/tr，避免拆碎列表/表格。 */
const BLOCK_SELECTOR
  = 'p,h1,h2,h3,h4,h5,h6,blockquote,pre,table,ul,ol,hr'

/**
 * 邮件安全无衬线：CJK 必须在前，否则中文落到宋体。
 * ponytail: 不做主题跟随字体，邮件场景固定这一栈。
 */
const SANS_STACK
  = '"Microsoft YaHei", "PingFang SC", "Helvetica Neue", Helvetica, Arial, sans-serif'

const MONO_HINT = /monospace|consolas|courier new|menlo|var\(/i
const LIGHT_COLOR = '#333333'
const LIGHT_BG = 'rgb(255, 255, 255)'
const BORDER = '1px solid #cccccc'

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

  return { plain, html: finalizeEmailHtml(host) }
}

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

  return host.childElementCount ? host : null
}

/**
 * 唯一出口：编辑器 HTML → 邮件可用 HTML。
 * 字体/表格线/列表起号都在这里做一次，避免调用方漏挂。
 */
function finalizeEmailHtml(host: HTMLElement): string {
  stripEditorChrome(host)
  applyLightBaseline(host)

  // 表格：编辑器常靠 class 画线，计算样式无 border → 必须写死
  for (const table of host.querySelectorAll('table')) {
    table.style.borderCollapse = 'collapse'
    table.style.border = BORDER
  }
  for (const cell of host.querySelectorAll('th,td')) {
    cell.style.border = BORDER
    if (!cell.style.padding)
      cell.style.padding = '4px 8px'
  }

  for (const ol of host.querySelectorAll('ol')) {
    const raw = ol.getAttribute('start')
    const n = raw === null || raw.trim() === '' ? 1 : Number(raw)
    ol.setAttribute('start', String(Number.isFinite(n) && n > 0 ? n : 1))
  }

  // 字体：一律换成 CJK 优先 sans（含原本已是 Helvetica sans 的，否则中文仍宋体）
  host.style.fontFamily = SANS_STACK
  for (const el of host.querySelectorAll<HTMLElement>('*')) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'pre' || tag === 'code' || tag === 'kbd' || tag === 'samp')
      continue
    const ff = el.style.fontFamily || ''
    if (MONO_HINT.test(ff) && !/sans-serif/i.test(ff))
      continue
    el.style.fontFamily = SANS_STACK
  }

  // innerHTML 会丢掉 host 自身 style → 包一层保证根上有字体
  return `<div style="font-family: ${SANS_STACK};">${host.innerHTML}</div>`
}

function stripEditorChrome(root: HTMLElement): void {
  root.querySelectorAll(
    '.milkdown-block-handle,.crepe-drop-cursor,.milkdown-toolbar,.milkdown-link-preview,.milkdown-link-edit,.milkdown-slash-menu,[data-ignore]',
  ).forEach(n => n.remove())
  root.querySelectorAll('[contenteditable]').forEach(n => n.removeAttribute('contenteditable'))
}

function applyLightBaseline(root: HTMLElement): void {
  for (const el of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
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
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function luminance([r, g, b]: [number, number, number]): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

function isDark(color: string): boolean {
  if (color.includes('rgba') && color.includes(', 0)'))
    return false
  const rgb = parseRgb(color)
  return !!rgb && luminance(rgb) < 0.2
}

function isVeryLight(color: string): boolean {
  const rgb = parseRgb(color)
  return !!rgb && luminance(rgb) > 0.85
}
