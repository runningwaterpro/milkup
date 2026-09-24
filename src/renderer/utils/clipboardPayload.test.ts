import { describe, expect, it } from 'vitest'
import { buildClipboardPayload, normalizeOlStartHtml } from './clipboardPayload'

function attachParagraph(): HTMLElement {
  document.body.innerHTML = ''
  const p = document.createElement('p')
  p.setAttribute('style', 'color: rgb(51, 51, 51); font-weight: 400;')
  const strong = document.createElement('strong')
  strong.setAttribute('style', 'font-weight: 700;')
  strong.textContent = 'Hello'
  p.appendChild(strong)
  document.body.appendChild(p)
  return p
}

describe('buildClipboardPayload', () => {
  it('keeps Markdown as plain text', () => {
    const p = attachParagraph()
    expect(buildClipboardPayload('**Hello**', p).plain).toBe('**Hello**')
  })

  it('emits semantic HTML with inline styles', () => {
    const p = attachParagraph()
    const html = buildClipboardPayload('**Hello**', p).html
    expect(html).toContain('<p')
    expect(html).toContain('<strong')
    expect(html).toContain('style=')
  })

  it('returns empty html when no selection root', () => {
    const payload = buildClipboardPayload('text', null)
    expect(payload.plain).toBe('text')
    expect(payload.html).toBe('')
  })

  it('forces table cell borders for email grid lines', () => {
    document.body.innerHTML
      = '<table><tbody><tr><td style="color: rgb(1,2,3);">A</td></tr></tbody></table>'
    const html = buildClipboardPayload('| A |', document.querySelector('table')!).html
    expect(html).toContain('<table')
    expect(html).toMatch(/1px solid/)
  })

  it('forces ordered list start at 1 when start is 0', () => {
    document.body.innerHTML = '<ol start="0"><li>zero</li></ol>'
    const html = buildClipboardPayload('0. zero', document.querySelector('ol')!).html
    expect(html).toMatch(/start="1"/)
    expect(html).not.toMatch(/start="0"/)
  })

  it('keeps explicit start when >= 1', () => {
    document.body.innerHTML = '<ol start="3"><li>x</li></ol>'
    const html = buildClipboardPayload('3. x', document.querySelector('ol')!).html
    expect(html).toMatch(/start="3"/)
  })

  it('uses CJK-first sans stack so Chinese is not 宋体', () => {
    // 即便源上已是 Helvetica sans-serif（无雅黑），也必须换成 CJK 栈
    document.body.innerHTML
      = '<p style="font-family: Helvetica Neue, Helvetica, Arial, sans-serif;">中文</p>'
    const html = buildClipboardPayload('中文', document.querySelector('p')!).html
    expect(html).toContain('Microsoft YaHei')
    expect(html).toContain('sans-serif')
    // 根包装也带上字体（innerHTML 会丢 host 自身 style）
    expect(html).toMatch(/^<div style="font-family:/)
  })

  it('keeps pre/code monospace', () => {
    document.body.innerHTML = '<pre style="font-family: monospace;"><code>x</code></pre>'
    const html = buildClipboardPayload('```\nx\n```', document.querySelector('pre')!).html
    expect(html).toContain('<pre')
    expect(html.toLowerCase()).not.toMatch(/microsoft yahei[^<]*monospace/)
  })

  it('keeps heading structure', () => {
    document.body.innerHTML = '<h2 style="font-weight: 700;">T</h2>'
    const html = buildClipboardPayload('## T', document.querySelector('h2')!).html
    expect(html).toContain('<h2')
  })

  it('keeps img src', () => {
    document.body.innerHTML = '<p><img src="https://example.com/a.png" alt="a"></p>'
    const html = buildClipboardPayload('![](https://example.com/a.png)', document.querySelector('p')!).html
    expect(html).toContain('https://example.com/a.png')
  })

  it('applies light baseline on dark backgrounds', () => {
    document.body.innerHTML
      = '<p style="background-color: rgb(30, 30, 30); color: rgb(240, 240, 240);">Dark</p>'
    const html = buildClipboardPayload('Dark', document.querySelector('p')!).html
    expect(html).toMatch(/color:\s*#333333|color:\s*rgb\(51/i)
    expect(html).toMatch(/background-color:\s*(?:#fff|rgb\(255)/i)
  })

  it('normalizeOlStartHtml clamps invalid start to 1', () => {
    expect(normalizeOlStartHtml('<ol start="0"><li>a</li></ol>')).toContain('start="1"')
    expect(normalizeOlStartHtml('<ol start=""><li>a</li></ol>')).toContain('start="1"')
    expect(normalizeOlStartHtml('<ol><li>a</li></ol>')).toContain('start="1"')
    expect(normalizeOlStartHtml('<ol start="3"><li>a</li></ol>')).toContain('start="3"')
  })
})
