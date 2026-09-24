import { cloneWithInlineStyles } from './inlineStyles'

export interface ClipboardPayload {
  plain: string
  html: string
}

/**
 * 顶层块选择器：不含 li/td/th/tr，避免同一列表/表格被拆成多段。
 */
const BLOCK_SELECTOR
  = 'p,h1,h2,h3,h4,h5,h6,blockquote,pre,table,ul,ol,hr'

/** 邮件友好浅色基线（票 02）。 */
const LIGHT_COLOR = '#333333'
const LIGHT_BG = 'rgb(255, 255, 255)'

/** 邮件安全无衬线栈（避免落入 Times 等衬线缺省）。 */
const SANS_STACK
  = 'Helvetica Neue, Helvetica, Arial, sans-serif'

const MONO_HINT = /monospace|consolas|courier new|menlo/i
const BORDER_COLOR = '#cccccc'

/**
 * 主 seam：选区 Markdown + 选区根 → `{ plain, html }`。
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
  applyEmailTableBorders(host)
  applyOrderedListsStartFromOne(host)
  applySansFontFallback(host)
  return { plain, html: host.innerHTML }
}

/** 从编辑器 DOM + Selection 收集相交的顶层块。 */
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
  applyEmailTableBorders(host)
  applyOrderedListsStartFromOne(host)
  applySansFontFallback(host)
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

function applyLightBaseline(root: HTMLElement): void {
  const nodes = [root, ...root.querySelectorAll<HTMLElement>('*')]
  for (const el of nodes) {
    const bg = el.style.backgroundColor || getComputedStyle(el).backgroundColor
    const color = el.style.color || getComputedStyle(el).color
    if (isDark(bg))
      el.style.backgroundColor = LIGHT_BG
    if (isVeryLight(color))
      el.style.color = LIGHT_COLOR
  }
}

/** 邮箱里表格常丢网格：强制 table/th/td 内联边框。 */
function applyEmailTableBorders(root: HTMLElement): void {
  root.querySelectorAll('table').forEach((table) => {
    table.style.borderCollapse = 'collapse'
    table.style.border = `1px solid ${BORDER_COLOR}`
  })
  root.querySelectorAll('th,td').forEach((cell) => {
    cell.style.border = `1px solid ${BORDER_COLOR}`
    if (!cell.style.padding)
      cell.style.padding = '4px 8px'
  })
}

/** 有序列表：start 缺失或 <=0 时改为 1（用户显式 >=1 保留）。 */
function applyOrderedListsStartFromOne(root: HTMLElement): void {
  root.querySelectorAll('ol').forEach((ol) => {
    const raw = ol.getAttribute('start')
    if (raw === null || raw.trim() === '') {
      ol.setAttribute('start', '1')
      return
    }
    const n = Number(raw)
    if (Number.isFinite(n) && n <= 0)
      ol.setAttribute('start', '1')
  })
}

/** 无衬线兜底：根与非等宽元素补 Helvetica/Arial 栈。 */
function applySansFontFallback(root: HTMLElement): void {
  root.style.fontFamily = SANS_STACK
  const nodes = root.querySelectorAll<HTMLElement>('*')
  for (const el of nodes) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'pre' || tag === 'code' || tag === 'kbd' || tag === 'samp')
      continue
    const ff = el.style.fontFamily || getComputedStyle(el).fontFamily
    const isSans = /sans-serif/i.test(ff)
    const isMono = MONO_HINT.test(ff)
    if (!isSans && !isMono)
      el.style.fontFamily = SANS_STACK
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
