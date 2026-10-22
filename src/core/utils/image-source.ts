/**
 * 图片原图的字节来源。
 *
 * 复制图形要拿到原图字节，不能重新编码：位图直传原字节，SVG 才栅格化成 PNG。
 * 所以这里只负责「把原图地址读成字节」，不碰剪贴板，也不碰画布。
 */

/** 原图字节与它的 MIME 类型 */
export interface ImageSourceBytes {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
}

/** SVG 的 MIME 类型 */
const SVG_MIME_TYPES = new Set(["image/svg+xml"]);

/** 嗅探 SVG 时读的头部字节数 */
const SVG_SNIFF_LENGTH = 512;

/**
 * 读取图片地址对应的原始字节。地址为空、读不到、内容为空都返回 null。
 */
export async function readImageSourceBytes(src: string): Promise<ImageSourceBytes | null> {
  if (!src) return null;

  try {
    const response = await fetch(src);
    if (!response.ok && response.status !== 0) return null;

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) return null;

    return { bytes, mimeType: normalizeMimeType(response.headers.get("content-type")) };
  } catch {
    return null;
  }
}

/**
 * 把字节编码成 data URL。位图原图走这条路，字节不变。
 */
export function bytesToDataUrl(bytes: Uint8Array<ArrayBuffer>, mimeType: string): string {
  const type = mimeType || "application/octet-stream";
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return `data:${type};base64,${btoa(binary)}`;
}

/**
 * 判断原图是不是 SVG。先看服务端给的类型，不准时再看内容。
 */
export function isSvgImageSource(source: ImageSourceBytes): boolean {
  if (SVG_MIME_TYPES.has(source.mimeType)) return true;
  return looksLikeSvg(source.bytes);
}

/**
 * 读 SVG 的固有尺寸：先看宽高属性，再看 viewBox。取不到返回 null。
 */
export function readSvgIntrinsicSize(svgText: string): { width: number; height: number } | null {
  const rootTag = /<svg\b[^>]*>/i.exec(svgText)?.[0];
  if (!rootTag) return null;

  const width = readSvgLength(rootTag, "width");
  const height = readSvgLength(rootTag, "height");
  if (width && height) return { width, height };

  const viewBox = /viewBox\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(rootTag);
  const parts = (viewBox?.[1] ?? viewBox?.[2] ?? "")
    .trim()
    .split(/[\s,]+/)
    .map((value) => Number(value));

  if (parts.length === 4 && parts.every((value) => Number.isFinite(value))) {
    if (parts[2] > 0 && parts[3] > 0) {
      return { width: Math.ceil(parts[2]), height: Math.ceil(parts[3]) };
    }
  }

  return null;
}

/**
 * 给 SVG 写死宽高。栅格化时浏览器不会替没有尺寸的 SVG 选默认尺寸，
 * 写死之后画布尺寸才是可预期的。
 */
export function withExplicitSvgSize(svgText: string, width: number, height: number): string {
  return svgText.replace(/<svg\b([^>]*)>/i, (match, attributes: string) => {
    let next = replaceSvgLength(attributes, "width", width);
    next = replaceSvgLength(next, "height", height);
    return `<svg${next}>`;
  });
}

function normalizeMimeType(value: string | null): string {
  if (!value) return "";
  return value.split(";")[0]?.trim().toLowerCase() ?? "";
}

function looksLikeSvg(bytes: Uint8Array<ArrayBuffer>): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, SVG_SNIFF_LENGTH)).trimStart();
  if (head.startsWith("<svg")) return true;
  return head.startsWith("<?xml") && head.includes("<svg");
}

function readSvgLength(tag: string, name: string): number | null {
  const match = new RegExp(`(?<![\\w-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  if (!match) return null;

  const raw = (match[1] ?? match[2] ?? "").trim();
  // 百分比之类的相对长度不是像素尺寸，交给调用方兜底。
  if (!/^[0-9.]+(?:px)?$/i.test(raw)) return null;

  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) return null;

  return Math.ceil(value);
}

function replaceSvgLength(attributes: string, name: string, value: number): string {
  const pattern = new RegExp(`(?<![\\w-])${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "i");

  if (pattern.test(attributes)) {
    return attributes.replace(pattern, `${name}="${value}"`);
  }

  return `${attributes} ${name}="${value}"`;
}
