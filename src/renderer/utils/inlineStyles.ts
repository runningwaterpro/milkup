/** 从导出路径抽出的「克隆 + 内联计算样式」；复制与导出共用。 */

export function cloneWithInlineStyles(element: HTMLElement): HTMLElement {
  const clone = element.cloneNode(true) as HTMLElement
  applyStylesRecursive(element, clone)
  return clone
}

export function applyStylesRecursive(src: Element, dest: Element): void {
  const computed = getComputedStyle(src)
  const style = Array.from(computed)
    .map(key => `${key}:${computed.getPropertyValue(key)};`)
    .join('')
  dest.setAttribute('style', style)

  if (dest instanceof HTMLAnchorElement) {
    dest.style.pointerEvents = 'auto'
    dest.style.cursor = 'pointer'
    dest.style.textDecoration = 'underline'
    dest.setAttribute('target', '_blank')
  }

  const srcChildren = Array.from(src.children)
  const destChildren = Array.from(dest.children)
  for (let i = 0; i < srcChildren.length; i++) {
    applyStylesRecursive(srcChildren[i], destChildren[i])
  }
}
