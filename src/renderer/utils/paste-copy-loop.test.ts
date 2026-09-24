/**
 * 反馈环：对「Typora→粘贴后序号0」与「复制后邮箱三件套缺失」变红。
 * 命令: npm test -- src/renderer/utils/paste-copy-loop.test.ts
 */
import { Crepe } from '@milkdown/crepe'
import { editorViewCtx, editorViewOptionsCtx } from '@milkdown/kit/core'
import { Plugin } from '@milkdown/prose/state'
import { $prose } from '@milkdown/utils'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildClipboardPayload,
  normalizeOlStartHtml,
} from './clipboardPayload'

/** Typora 风格：有序列表 + 表格 + 中文（无 start 或 start 非法时易变 0） */
const TYPORA_HTML = `
<div xmlns="http://www.w3.org/1999/xhtml">
  <ol start="0">
    <li><p>第一项</p></li>
    <li><p>第二项</p></li>
  </ol>
  <table>
    <thead><tr><th>模块</th><th>状态</th></tr></thead>
    <tbody><tr><td>合同</td><td>进行中</td></tr></tbody>
  </table>
  <p><strong>加粗标题</strong></p>
</div>
`

async function createEditor(markdown = '# 临时\n\n正文') {
  document.body.innerHTML = '<div id="milkdown"></div>'
  const crepe = new Crepe({
    root: document.getElementById('milkdown')!,
    defaultValue: markdown,
  })
  const editor = crepe.editor
  // 与 MilkdownEditor.vue 相同：$prose 在 create 期间写入 options
  editor.use($prose((ctx) => {
    ctx.update(editorViewOptionsCtx, prev => ({
      ...prev,
      transformPastedHTML: (html: string, view: never) => {
        const prevFn = prev.transformPastedHTML
        const out = prevFn ? prevFn.call(view, html, view as never) : html
        return normalizeOlStartHtml(out)
      },
    }))
    return new Plugin({})
  }))
  await crepe.create()
  return { crepe, editor, view: editor.ctx.get(editorViewCtx) }
}

function firstOrderedListOrder(view: ReturnType<typeof createEditor> extends Promise<infer T> ? T extends { view: infer V } ? V : never : never): number {
  let order = Number.NaN
  view.state.doc.descendants((node) => {
    if (node.type.name === 'ordered_list' && Number.isNaN(order))
      order = Number(node.attrs.order)
  })
  return order
}

describe('paste-copy feedback loop', () => {
  let editor: Awaited<ReturnType<typeof createEditor>>

  beforeAll(async () => {
    editor = await createEditor()
  })

  it('rED: pasting Typora HTML must not leave ordered_list order < 1', async () => {
    const view = editor.view
    const transform = view.someProp('transformPastedHTML', f => f)
    expect(typeof transform).toBe('function')

    const html = transform
      ? transform(TYPORA_HTML, view)
      : TYPORA_HTML
    expect(html).toMatch(/<ol[^>]*start="1"/)
    expect(html).not.toMatch(/start="0"/)
  })

  it('rED: copy payload after paste-like content has YaHei, border, start>=1', () => {
    document.body.innerHTML = `
      <div data-clipboard-host>
        <ol start="0"><li>一</li></ol>
        <table><tbody><tr><td>A</td></tr></tbody></table>
        <p style="font-family: Times New Roman, serif;">中文正文</p>
      </div>`
    const host = document.querySelector('[data-clipboard-host]') as HTMLElement
    const payload = buildClipboardPayload('1. 一\n\n| A |\n\n中文正文', host)

    expect(payload.html).toMatch(/Microsoft YaHei/)
    expect(payload.html).toMatch(/1px solid/)
    expect(payload.html).not.toMatch(/start="0"/)
    expect(payload.html).toMatch(/start="1"/)
    expect(payload.html.toLowerCase()).not.toContain('times new roman')
  })

  it('control: normalizeOlStartHtml alone is not enough if view hook missing', () => {
    expect(normalizeOlStartHtml('<ol start="0">')).toContain('start="1"')
  })
})
