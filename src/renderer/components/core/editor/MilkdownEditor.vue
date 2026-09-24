<script setup lang="ts">
import type { Ctx } from '@milkdown/kit/ctx'
import { vue } from '@codemirror/lang-vue'
import { Crepe } from '@milkdown/crepe'
import { editorViewCtx, editorViewOptionsCtx, serializerCtx } from '@milkdown/kit/core'
import { upload, uploadConfig } from '@milkdown/kit/plugin/upload'
import { outline } from '@milkdown/kit/utils'
import { automd } from '@milkdown/plugin-automd'
import { commonmark } from '@milkdown/preset-commonmark'
import { TextSelection } from '@milkdown/prose/state'
import { enhanceConfig } from '@renderer/enhance/crepe/config'
import { buildClipboardPayload, normalizeOlStartHtml, selectionStyleHost } from '@renderer/utils/clipboardPayload'
import { nextTick, onBeforeUnmount, onMounted } from 'vue'
import useTab from '@/hooks/useTab'
import { uploader } from '@/plugins/customPastePlugin'
import { htmlPlugin } from '@/plugins/hybridHtmlPlugin/rawHtmlPlugin'
import { diagram } from '@/plugins/mermaidPlugin'
import emitter from '@/renderer/events'

const props = defineProps<{
  modelValue: string
  readOnly: boolean | undefined
}>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()
let crepe: Crepe | null = null
let detachClipboard: (() => void) | null = null

const { currentTab } = useTab()
function fixUnclosedCodeBlock(markdown: string): string {
  const count = (markdown.match(/```/g) || []).length
  if (count % 2 !== 0) {
    console.warn('[Milkdown] 检测到未闭合的代码块，已自动补全。')
    return `${markdown}\n\`\`\``
  }
  return markdown
}
function normalizeMarkdown(text: string): string {
  return text
    // 移除 BOM
    .replace(/^\uFEFF/, '')
    // 替换 CRLF → LF
    .replace(/\r\n/g, '\n')
    // 移除非断行空格
    .replace(/\u00A0/g, ' ')
}

onMounted(async () => {
  await nextTick()
  // 预览模式下支持自定义css文件路径解析
  // 还有在源码模式下 支持自定义字体大小调节
  // 还有 切换 源码和预览模式 以及 目录打开与关闭 搞个可以自定义的快捷键

  // crepe 有更好的用户体验👇
  crepe = new Crepe({
    root: document.querySelector('#milkdown') as HTMLElement,
    defaultValue: normalizeMarkdown(fixUnclosedCodeBlock(props.modelValue.toString())),
    featureConfigs: {
      'code-mirror': {
        extensions: [vue()],
      },
      ...enhanceConfig,
    },
  })
  crepe.on((lm) => {
    lm.markdownUpdated((Ctx, nextMarkdown) => {
      emit('update:modelValue', nextMarkdown)
      emitOutlineUpdate(Ctx)
    })
    lm.mounted(async (Ctx) => {
      emitOutlineUpdate(Ctx)
      setSelectionAndScrollToView(Ctx)
      // 监听滚动事件
      const view = Ctx.get(editorViewCtx)
      view.dom.addEventListener('scroll', (e) => {
        console.log('e::: ', e)
        const scrollTop = view.dom.scrollTop
        const scrollHeight = view.dom.scrollHeight - view.dom.clientHeight
        const ratio = scrollHeight === 0 ? 0 : scrollTop / scrollHeight
        currentTab.value!.scrollRatio = ratio
      })
    })
    lm.selectionUpdated((Ctx) => {
      // 获取光标位置
      try {
        nextTick(() => {
          const view = Ctx.get(editorViewCtx)
          const serializer = Ctx.get(serializerCtx)
          const sel = view.state.selection
          const head = sel.head ? sel.head : sel.head // 对应光标位置
          // 获取光标之前的文档部分
          const before = view.state.doc.cut(0, head)
          // 序列化为 Markdown 源码
          const markdownBefore = serializer(before)
          currentTab.value!.codeMirrorCursorOffset = markdownBefore.length
          currentTab.value!.milkdownCursorOffset = head
        })
      } catch (err) {
        console.error('获取光标位置失败:', err)
      }
    })
  })
  const editor = crepe.editor
  editor.ctx.inject(uploadConfig.key)
  editor
    .use(automd)
    .use(upload)
    .use(htmlPlugin)
    .use(diagram)
    .use(commonmark)

  if (props.readOnly) {
    crepe.setReadonly(true)
  }

  await crepe.create()

  // 必须在 create 之后：editorViewOptions 要等内部插件注入
  editor.ctx.update(editorViewOptionsCtx, prev => ({
    ...prev,
    transformPastedHTML: (html: string, view: never) => {
      const prevFn = prev.transformPastedHTML
      const out = prevFn ? prevFn.call(view, html, view as never) : html
      return normalizeOlStartHtml(out)
    },
  }))

  editor.ctx.update(uploadConfig.key, prev => ({ ...prev, uploader }))
  detachClipboard = bindDualClipboard(editor.ctx)
})
onBeforeUnmount(() => {
  detachClipboard?.()
  detachClipboard = null
  if (crepe) {
    crepe.destroy()
    crepe = null
  }
})

/** 双写：在 document 捕获阶段抢在 ProseMirror 前写入 plain+html。 */
function bindDualClipboard(ctx: Ctx): () => void {
  const view = ctx.get(editorViewCtx)
  const onCopyCut = (e: ClipboardEvent) => {
    if (!e.clipboardData)
      return
    const target = e.target as Node | null
    const inView = !!target && view.dom.contains(target)
    const active = document.activeElement
    // Electron 菜单复制时 target 可能是 document；PM 有选区就接管
    const inApp = inView
      || view.hasFocus()
      || (!!active && view.dom.contains(active))
      || target === document
      || target === document.body
    if (!inApp)
      return
    const sel = view.state.selection
    if (sel.empty)
      return
    const serializer = ctx.get(serializerCtx)
    const markdown = serializer(view.state.doc.slice(sel.from, sel.to))
    const host = selectionStyleHost(view)
    if (!host)
      return
    const payload = buildClipboardPayload(markdown, host)
    e.clipboardData.setData('text/plain', payload.plain)
    e.clipboardData.setData('text/html', payload.html)
    e.stopImmediatePropagation()
    e.preventDefault()
    if (e.type === 'cut')
      view.dispatch(view.state.tr.delete(sel.from, sel.to))
  }
  // 捕获挂在 document：先于 view.dom 上的 PM copy 处理器
  document.addEventListener('copy', onCopyCut, true)
  document.addEventListener('cut', onCopyCut, true)
  return () => {
    document.removeEventListener('copy', onCopyCut, true)
    document.removeEventListener('cut', onCopyCut, true)
  }
}

function emitOutlineUpdate(ctx: Ctx) {
  const headings = outline()(ctx)
  emitter.emit('outline:Update', headings)
}
function setSelectionAndScrollToView(Ctx: Ctx) {
  try {
    const view = Ctx.get(editorViewCtx)
    const size = view.state.doc.content.size
    const rawPos = currentTab.value?.milkdownCursorOffset ?? 1
    // 设置光标位置
    const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, rawPos))
    view.dispatch(tr)
    const clamped = Math.max(1, Math.min(rawPos, Math.max(1, size - 1)))
    const dom = view.domAtPos(clamped).node as HTMLElement
    // 检查是 文本节点还是 元素节点
    if (dom.nodeType === Node.TEXT_NODE) {
      const parent = dom.parentElement!
      parent.scrollIntoView({ behavior: 'instant', block: 'center' })
    } else {
      dom.scrollIntoView({ behavior: 'instant', block: 'center' })
    }
  } catch {
    if (currentTab.value!.milkdownCursorOffset !== null && currentTab.value!.milkdownCursorOffset! > 0) {
      currentTab.value!.milkdownCursorOffset!--
      setSelectionAndScrollToView(Ctx)
    }
  }
}
</script>

<template>
  <div class="editor-box">
    <div class="scrollView milk">
      <div id="milkdown"></div>
    </div>
  </div>
</template>

<style scoped lang="less">
.editor-box {
  width: 100%;
  height: 100%;
  display: flex;

  .scrollView {
    flex: 1;
    height: 100%;
    overflow-y: auto;
    background: var(--background-color-1);
  }
}
</style>
