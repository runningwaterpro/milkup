import { describe, expect, it } from 'vitest'
import { buildClipboardPayload } from './clipboardPayload'

function attachParagraph(): HTMLElement {
  document.body.innerHTML = ''
  const p = document.createElement('p')
  p.setAttribute('style', 'color: rgb(51, 51, 51); font-weight: 400; margin: 0px;')
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
    const payload = buildClipboardPayload('**Hello**', p)
    expect(payload.plain).toBe('**Hello**')
  })

  it('emits semantic HTML with inline styles for paragraph and bold', () => {
    const p = attachParagraph()
    const payload = buildClipboardPayload('**Hello**', p)
    expect(payload.html).toContain('<p')
    expect(payload.html).toContain('<strong')
    expect(payload.html).toContain('Hello')
    expect(payload.html).toContain('style=')
  })

  it('returns empty html when there is no selection root', () => {
    const payload = buildClipboardPayload('text', null)
    expect(payload.plain).toBe('text')
    expect(payload.html).toBe('')
  })

  it('keeps table structure in html', () => {
    document.body.innerHTML
      = '<table><tbody><tr><td style="color: rgb(1,2,3);">A</td></tr></tbody></table>'
    const table = document.querySelector('table')!
    const payload = buildClipboardPayload('| A |', table)
    expect(payload.html).toContain('<table')
    expect(payload.html).toContain('<td')
    expect(payload.html).toContain('A')
  })

  it('keeps code block structure in html', () => {
    document.body.innerHTML
      = '<pre style="font-family: monospace;"><code>x = 1</code></pre>'
    const pre = document.querySelector('pre')!
    const payload = buildClipboardPayload('```\nx = 1\n```', pre)
    expect(payload.html).toContain('<pre')
    expect(payload.html).toContain('x = 1')
  })

  it('keeps img src when present', () => {
    document.body.innerHTML
      = '<p><img src="https://example.com/a.png" alt="a"></p>'
    const p = document.querySelector('p')!
    const payload = buildClipboardPayload('![](https://example.com/a.png)', p)
    expect(payload.html).toContain('<img')
    expect(payload.html).toContain('https://example.com/a.png')
  })

  it('applies light color baseline on dark backgrounds (票 02)', () => {
    document.body.innerHTML
      = '<p style="background-color: rgb(30, 30, 30); color: rgb(240, 240, 240);">Dark</p>'
    const p = document.querySelector('p')!
    const payload = buildClipboardPayload('Dark', p)
    expect(payload.html).toMatch(/color:\s*#333333|color:\s*rgb\(51,\s*51,\s*51\)/i)
    expect(payload.html).toMatch(/background-color:\s*(#fff|rgb\(255,\s*255,\s*255\))/i)
  })

  it('keeps heading and list structure (票 02)', () => {
    document.body.innerHTML
      = '<h2 style="font-weight: 700;">T</h2><ul><li style="color: rgb(1,2,3);">item</li></ul>'
    const h2 = document.querySelector('h2')!
    const payload = buildClipboardPayload('## T\n\n- item', h2)
    expect(payload.html).toContain('<h2')
    expect(payload.html).toContain('T')
  })

  it('puts visible borders on table cells for email (网格线)', () => {
    document.body.innerHTML
      = '<table><tbody><tr><td style="color: rgb(1,2,3);">A</td></tr></tbody></table>'
    const table = document.querySelector('table')!
    const payload = buildClipboardPayload('| A |', table)
    expect(payload.html).toMatch(/border(-collapse)?:[^;]*solid|border:\s*1px/i)
    expect(payload.html).toMatch(/border[^;]*1px/i)
  })

  it('forces ordered list start at 1 when start is 0 or missing intent', () => {
    document.body.innerHTML = '<ol start="0"><li>zero</li></ol>'
    const ol = document.querySelector('ol')!
    const payload = buildClipboardPayload('0. zero', ol)
    expect(payload.html).toContain('<ol')
    expect(payload.html).toMatch(/start="1"/)
    expect(payload.html).not.toMatch(/start="0"/)
  })

  it('keeps explicit start when already >= 1', () => {
    document.body.innerHTML = '<ol start="3"><li>x</li></ol>'
    const ol = document.querySelector('ol')!
    const payload = buildClipboardPayload('3. x', ol)
    expect(payload.html).toMatch(/start="3"/)
  })

  it('applies sans-serif font-family fallback on clipboard html', () => {
    document.body.innerHTML = '<p>NoExplicitFont</p>'
    const p = document.querySelector('p')!
    const payload = buildClipboardPayload('NoExplicitFont', p)
    const html = payload.html.toLowerCase()
    expect(html).toMatch(/font-family:|font:/)
    expect(html).toMatch(/sans-serif/)
    expect(html).not.toMatch(/times new roman/)
  })
})
