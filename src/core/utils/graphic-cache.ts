/**
 * 图形缓存。
 *
 * 缓存的是图形复制专用的 data URL：矢量图缓存 PNG，位图缓存原图。
 * 复制时直接取用，不重新渲染。图形内容变了要调用 {@link clearGraphicCache}。
 */

/** 图形缓存属性：存放图形复制专用的 data URL */
export const GRAPHIC_CACHE_ATTRIBUTE = "data-graphic-image";

/**
 * 清掉图形缓存。图形内容变化后要调用，否则复制到的是旧图。
 */
export function clearGraphicCache(element: Element): void {
  element.removeAttribute(GRAPHIC_CACHE_ATTRIBUTE);
}

/**
 * 找出图形容器里已缓存的图形 data URL。
 */
export function findGraphicCache(container: Element): string | null {
  const candidates: Element[] = [];
  if (container.hasAttribute(GRAPHIC_CACHE_ATTRIBUTE)) candidates.push(container);
  candidates.push(...Array.from(container.querySelectorAll(`[${GRAPHIC_CACHE_ATTRIBUTE}]`)));

  for (const candidate of candidates) {
    const value = candidate.getAttribute(GRAPHIC_CACHE_ATTRIBUTE);
    if (value) return value;
  }

  return null;
}

/**
 * 清掉一棵树里的图形缓存。导出 HTML 时要调用，
 * 否则缓存里的整张图会以 base64 的形式进到导出文件里。
 */
export function stripGraphicCacheAttributes(root: Element): void {
  for (const node of [root, ...Array.from(root.querySelectorAll("*"))]) {
    node.removeAttribute(GRAPHIC_CACHE_ATTRIBUTE);
  }
}
