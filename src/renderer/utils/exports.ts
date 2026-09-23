import type { Block, ExportPDFOptions } from '@/main/types'
import { cloneWithInlineStyles } from './inlineStyles'

/**
 * 导出选定元素为一个带样式和图片的独立 HTML 文件
 * @param element - 要导出的元素
 * @param filename - 导出文件名（默认为 export.html）
 */
export async function exportElementWithStylesAndImages(
  element: HTMLElement,
  filename: string = 'export.html',
): Promise<void> {
  // 克隆元素并应用内联样式
  const cloned = cloneWithInlineStyles(element)

  // 将 <img> 转为 base64
  await inlineImages(cloned)

  // 生成完整 HTML
  const html = `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        min-width: 1100px;
        height: auto;
      }
      .export-container {
        box-sizing: border-box;
        display: flex;
        justify-content: center;
      }
      .export-container > #milkdown {
        width: 100%!important;
      }
      .export-container > #milkdown .milkdown,.export-container > #milkdown .milkdown > div[contenteditable="true"] {
        width: 100%!important;
      }
      p {
        word-break: break-word;
        width: 100%!important;
      }
    </style>
  </head>
  <body>
    <div class="export-container">${cloned.outerHTML}</div>
  </body>
  </html>`

  // 下载文件
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)

  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()

  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * 将元素中的所有 <img> src 转换为 base64（data URL）
 * @param root - 要处理的根元素
 */
async function inlineImages(root: HTMLElement): Promise<void> {
  const images = Array.from(root.querySelectorAll('img'))

  const tasks = images.map(async (img) => {
    const src = img.src
    if (src.startsWith('data:'))
      return // 已经是内联的

    try {
      const res = await fetch(src, { mode: 'cors' })
      const blob = await res.blob()
      const base64 = await blobToDataURL(blob)
      img.src = base64
    } catch (err) {
      console.warn('图片内联失败:', src, err)
    }
  })

  await Promise.all(tasks)
}

/**
 * Blob → data URL
 * @param blob - Blob 对象
 * @returns base64 编码的 data URL
 */
function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.readAsDataURL(blob)
  })
}

// 导出为 PDF
export async function exportElementAsPDF(
  elementSelector: string,
  outputName: string,
  options?: ExportPDFOptions,
): Promise<void> {
  await window.electronAPI.exportAsPDF(elementSelector, outputName, options)
}
// 导出为 Word

/**
 * 遍历 Markdown 渲染后的 DOM，生成结构化数据
 * 过滤非正文节点（toolbar、控件等）
 */
export function serializeMarkdownToBlocks(selector: string): Block[] {
  const el = document.querySelector(selector)
  if (!el)
    throw new Error('Element not found')

  const blocks: Block[] = []

  function traverse(node: Node) {
    if (!(node instanceof HTMLElement))
      return

    const className = node.className || ''
    if (
      className.includes('milkdown-block-handle')
      || className.includes('crepe-drop-cursor')
      || className.includes('milkdown-link-preview')
      || className.includes('milkdown-link-edit')
      || className.includes('milkdown-toolbar')
      || className.includes('milkdown-latex-inline-edit')
      || className.includes('milkdown-slash-menu')
    ) {
      return
    }

    if (node.dataset.ignore)
      return
    if (node.classList.contains('cm-content')) {
      const lines: string[] = []
      node.querySelectorAll('.cm-line').forEach((line) => {
        lines.push(line.textContent || '')
      })
      blocks.push({ type: 'code', lines })
      return
    }
    const tag = node.tagName.toLowerCase()
    if (tag.startsWith('h')) {
      blocks.push({ type: 'heading', level: Number(tag[1]) as 1 | 2 | 3, text: node.textContent || '' })
    } else if (tag === 'p') {
      blocks.push({ type: 'paragraph', text: node.textContent || '' })
    } else if (tag === 'pre') {
      blocks.push({ type: 'code', lines: node.textContent?.split('\n') || [] })
    } else if (tag === 'ul' || tag === 'ol') {
      const items: string[] = []
      node.querySelectorAll('li').forEach(li => items.push(li.textContent || ''))
      blocks.push({ type: 'list', items, ordered: tag === 'ol' })
    }

    node.childNodes.forEach(traverse)
  }

  traverse(el)
  return blocks
}

export async function exportElementAsWord(
  selector: string,
  outputName: string,
): Promise<void> {
  const blocks = serializeMarkdownToBlocks(selector)
  await window.electronAPI.exportAsWord(blocks, outputName)
}
