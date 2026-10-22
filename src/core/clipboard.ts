import { Prec } from "@codemirror/state";
import { EditorView as CodeMirrorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type { Fragment } from "prosemirror-model";
import type { EditorView as ProseMirrorView } from "prosemirror-view";
import { decodeHtmlEntity, HTML_ENTITY_SYNTAX_TYPE } from "./utils/html-entities.ts";
import { resolveImageSrc } from "./utils/image-path.ts";
import {
  bytesToDataUrl,
  isSvgImageSource,
  readImageSourceBytes,
  readSvgIntrinsicSize,
  withExplicitSvgSize,
} from "./utils/image-source.ts";
import {
  findGraphicCache,
  GRAPHIC_CACHE_ATTRIBUTE,
  stripGraphicCacheAttributes,
} from "./utils/graphic-cache.ts";
import type { ImagePasteMethod } from "./plugins/paste";

const CELL_BORDER = "1px solid #cccccc";
const CLIPBOARD_TREEWALKER_SHOW_TEXT = typeof NodeFilter === "undefined" ? 4 : NodeFilter.SHOW_TEXT;

/** 图形复制按钮的 class */
const GRAPHIC_COPY_BUTTON_CLASS = "milkup-graphic-copy-btn";
/** 图形复制的像素密度倍数 */
const GRAPHIC_SCALE = 2;
/** 图形复制的最长边上限（像素） */
const GRAPHIC_MAX_SIDE = 4096;

export const RENDERED_CLIPBOARD_NODE_TYPES = new Set([
  "table",
  "image",
  "code_block",
  "math_block",
  "html_block",
]);

export function hasRenderedClipboardNode(fragment: Fragment): boolean {
  let found = false;
  fragment.descendants((node) => {
    if (RENDERED_CLIPBOARD_NODE_TYPES.has(node.type.name)) found = true;
    return !found;
  });
  return found;
}

export interface ClipboardBuildOptions {
  sourceView?: boolean;
  fontFamily?: string;
  codeFontFamily?: string;
  imageMode?: ImagePasteMethod;
}

export interface ClipboardPayload {
  plain: string;
  html: string;
  richRequired?: boolean;
}

export type ClipboardWriteStatus = "rich" | "plain" | "failed";

export interface ClipboardWriteResult {
  status: ClipboardWriteStatus;
}

export interface CodeClipboardOptions {
  fontFamily?: string;
  codeFontFamily?: string;
  codeStyle?: string;
  blockStyle?: string;
}

export function canDeleteAfterClipboardWrite(
  payload: ClipboardPayload,
  result: ClipboardWriteResult
): boolean {
  const richRequired = payload.richRequired ?? !!payload.html;
  return result.status !== "failed" && (!richRequired || result.status === "rich");
}

function cleanFontFamily(value: string): string {
  return value.trim().replace(/;+\s*$/, "");
}

export function getClipboardFontFamilies(
  element: HTMLElement,
  codeElement?: HTMLElement
): Pick<ClipboardBuildOptions, "fontFamily" | "codeFontFamily"> {
  if (typeof getComputedStyle !== "function") return {};

  try {
    const style = getComputedStyle(element);
    const codeStyle = codeElement ? getComputedStyle(codeElement) : style;
    const fontFamily =
      cleanFontFamily(style.getPropertyValue("--milkup-font-default")) ||
      cleanFontFamily(style.fontFamily);
    const codeFontFamily =
      cleanFontFamily(codeStyle.getPropertyValue("--milkup-font-code")) ||
      (codeElement ? cleanFontFamily(codeStyle.fontFamily) : "");
    return {
      ...(fontFamily ? { fontFamily } : {}),
      ...(codeFontFamily ? { codeFontFamily } : {}),
    };
  } catch {
    return {};
  }
}

export function getCodeClipboardOptions(view: CodeMirrorView): CodeClipboardOptions {
  const options: CodeClipboardOptions = getClipboardFontFamilies(view.dom, view.contentDOM);
  try {
    if (typeof getComputedStyle === "function") {
      options.codeStyle = getComputedStyle(view.contentDOM).cssText;
      const block = view.dom.closest<HTMLElement>(".milkup-code-block");
      if (block) options.blockStyle = getComputedStyle(block).cssText;
    }
  } catch {
    // Font information is still useful when computed styles are unavailable.
  }
  return options;
}

export function isClipboardElementHidden(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true")
      return true;
    const inlineStyle = (current as HTMLElement).style;
    if (inlineStyle.display === "none" || inlineStyle.visibility === "hidden") return true;

    if (typeof getComputedStyle === "function") {
      try {
        const computed = getComputedStyle(current);
        if (computed.display === "none" || computed.visibility === "hidden") return true;
      } catch {
        // Inline visibility is still usable when computed styles are unavailable.
      }
    }
    current = current.parentElement;
  }
  return false;
}

export function isClipboardElementVisible(element: Element): boolean {
  return !isClipboardElementHidden(element);
}

export function getRenderedSelectionRoot(
  view: ProseMirrorView,
  imageMode?: ImagePasteMethod
): HTMLElement | null {
  const document = view.dom.ownerDocument;
  if (view.state?.selection?.empty) return null;

  const range = getSelectionRange(view, document);
  if (!range || !view.dom.contains(range.commonAncestorContainer)) return null;

  const sourceClone = cloneWithInlineStyles(view.dom, imageMode);
  const start = getNodeAtPath(sourceClone, getNodePath(view.dom, range.startContainer));
  const end = getNodeAtPath(sourceClone, getNodePath(view.dom, range.endContainer));
  if (!start || !end) return null;

  try {
    const clonedRange = document.createRange();
    clonedRange.setStart(start, range.startOffset);
    clonedRange.setEnd(end, range.endOffset);
    const host = document.createElement("div");
    host.appendChild(clonedRange.extractContents());
    cleanRenderedClipboardDom(host);
    copyProseMirrorSliceMarker(host, view);
    return host;
  } catch {
    return null;
  }
}

function getSelectionRange(view: ProseMirrorView, document: Document): Range | null {
  try {
    const start = view.domAtPos(view.state.selection.from);
    const end = view.domAtPos(view.state.selection.to);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    if (!range.collapsed && view.dom.contains(range.commonAncestorContainer)) return range;
  } catch {
    // The browser selection below is the fallback for DOM positions PM cannot map.
  }

  const selection = document.getSelection();
  if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    if (!range.collapsed && view.dom.contains(range.commonAncestorContainer)) return range;
  }
  return null;
}

function copyProseMirrorSliceMarker(host: HTMLElement, view: ProseMirrorView): void {
  if (typeof view.serializeForClipboard !== "function" || !view.state?.selection) return;

  try {
    const { dom } = view.serializeForClipboard(view.state.selection.content());
    const marker =
      dom.firstElementChild?.getAttribute("data-pm-slice") ||
      dom.querySelector("[data-pm-slice]")?.getAttribute("data-pm-slice");
    if (!marker) return;
    host.setAttribute("data-pm-slice", marker);
    if (host.firstElementChild) host.firstElementChild.setAttribute("data-pm-slice", marker);
  } catch {
    // External clipboard consumers do not need the ProseMirror marker.
  }
}

export function getRenderedNodeRoot(
  view: ProseMirrorView,
  pos: number,
  imageMode?: ImagePasteMethod
): HTMLElement | null {
  const node = view.nodeDOM(pos);
  if (!node || node.nodeType !== 1) return null;
  const clonedNode = cloneWithInlineStyles(node as HTMLElement, imageMode);
  const document = view.dom?.ownerDocument || node.ownerDocument;
  if (!document) return null;
  const root = document.createElement("div");
  root.appendChild(clonedNode);
  cleanRenderedClipboardDom(root);
  root.setAttribute("data-pm-slice", "0 0 []");
  if (root.firstElementChild) root.firstElementChild.setAttribute("data-pm-slice", "0 0 []");
  return root;
}

function cloneWithInlineStyles(source: HTMLElement, imageMode?: ImagePasteMethod): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement;
  copyComputedStyles(source, clone, imageMode);
  return clone;
}

function getClipboardImageSource(image: HTMLImageElement): string {
  return image.currentSrc || image.src || image.getAttribute("src") || "";
}

function isRemoteClipboardImageSource(src: string): boolean {
  return /^(?:https?:|data:)/i.test(src);
}

function resolveLocalClipboardImageSource(src: string): string {
  try {
    return resolveImageSrc(src) || src;
  } catch {
    return src;
  }
}

/**
 * Resolve an image for the clipboard without changing the document source.
 * `local` may use a cached local Data URL, `base64` always tries to produce
 * one, and `remote` never replaces a remote URL with embedded image data.
 */
export function resolveClipboardImageSource(
  image: HTMLImageElement,
  mode: ImagePasteMethod
): string | null {
  const source = getClipboardImageSource(image);
  if (!source) return null;

  const cached = image.getAttribute("data-clipboard-src");
  switch (mode) {
    case "remote":
      return isRemoteClipboardImageSource(source)
        ? source
        : resolveLocalClipboardImageSource(source);
    case "local":
      return cached || resolveLocalClipboardImageSource(source);
    case "base64":
      return cached || getLoadedImageDataUrl(image) || resolveLocalClipboardImageSource(source);
  }
}

function copyClipboardImageSource(
  source: Element,
  target: Element,
  imageMode?: ImagePasteMethod
): void {
  if (!imageMode || source.tagName.toLowerCase() !== "img") return;
  const resolved = resolveClipboardImageSource(source as HTMLImageElement, imageMode);
  if (resolved) target.setAttribute("src", resolved);
  target.removeAttribute("data-clipboard-src");
}

// Text, tables, and code reflow in the target; media keeps intrinsic dimensions.
const CLIPBOARD_LAYOUT_PROPERTIES = new Set([
  "width",
  "min-width",
  "max-width",
  "height",
  "min-height",
  "max-height",
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "inset",
  "overflow",
  "overflow-x",
  "overflow-y",
  "white-space",
  "word-break",
  "overflow-wrap",
  "flex",
  "flex-basis",
  "flex-grow",
  "flex-shrink",
  "flex-direction",
  "flex-wrap",
  "grid-template-columns",
  "grid-template-rows",
  "transform",
]);

// Only intrinsic media/code formatting survives; editor viewport geometry does not.
const CLIPBOARD_LAYOUT_TAGS = new Set(["img", "svg", "canvas", "pre", "code"]);
const CLIPBOARD_LAYOUT_CONTAINERS =
  ".milkup-code-block-editor, .milkup-html-block-editor, .milkup-image-block, .milkup-mermaid-preview";
const CLIPBOARD_FLOW_WRAP_STYLES = {
  "white-space": "normal",
  "word-break": "normal",
  "overflow-wrap": "break-word",
} as const;
const CLIPBOARD_VIEWPORT_GEOMETRY_ATTRIBUTES = ["width", "height", "cellwidth", "cellheight"];
const CLIPBOARD_CODE_TAGS = new Set(["pre", "code"]);
const CLIPBOARD_CODE_WRAP_STYLES = {
  "white-space": "pre-wrap",
  "word-break": "normal",
  "overflow-wrap": "break-word",
} as const;

function shouldPreserveClipboardLayout(source: Element): boolean {
  const tag = source.tagName.toLowerCase();
  return CLIPBOARD_LAYOUT_TAGS.has(tag) || !!source.closest(CLIPBOARD_LAYOUT_CONTAINERS);
}

function copyElementTree(
  source: Element,
  target: Element,
  visit: (source: Element, target: Element) => void
): void {
  visit(source, target);
  const sourceChildren = Array.from(source.children);
  const targetChildren = Array.from(target.children);
  for (let index = 0; index < sourceChildren.length; index += 1) {
    copyElementTree(sourceChildren[index], targetChildren[index], visit);
  }
}

function copyComputedStyles(source: Element, target: Element, imageMode?: ImagePasteMethod): void {
  copyElementTree(source, target, (sourceElement, targetElement) => {
    if (isClipboardElementHidden(sourceElement)) {
      targetElement.setAttribute("data-clipboard-hidden", "true");
    }
    copyClipboardImageSource(sourceElement, targetElement, imageMode);
    const preserveLayout = shouldPreserveClipboardLayout(sourceElement);
    if (!preserveLayout) {
      for (const property of CLIPBOARD_LAYOUT_PROPERTIES) {
        (targetElement as HTMLElement).style.removeProperty(property);
      }
    }
    // Flow nodes stay semantic; copying Chromium's full computed declaration set bloats CF_HTML.
    if (preserveLayout && typeof getComputedStyle === "function") {
      const computed = getComputedStyle(sourceElement);
      for (const property of Array.from(computed)) {
        const value = computed.getPropertyValue(property);
        if (value) (targetElement as HTMLElement).style.setProperty(property, value);
      }
    }
  });
}

function getNodePath(root: Node, target: Node): number[] | null {
  const path: number[] = [];
  let current: Node | null = target;
  while (current && current !== root) {
    const parent: Node | null = current.parentNode;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
    current = parent;
  }
  return current === root ? path : null;
}

function getNodeAtPath(root: Node, path: number[] | null): Node | null {
  if (!path) return null;
  let current: Node = root;
  for (const index of path) {
    current = current.childNodes[index];
    if (!current) return null;
  }
  return current;
}

function normalizeClipboardCodeLayout(element: Element): void {
  for (const attribute of CLIPBOARD_VIEWPORT_GEOMETRY_ATTRIBUTES) {
    element.removeAttribute(attribute);
  }
  for (const property of CLIPBOARD_LAYOUT_PROPERTIES) {
    (element as HTMLElement).style.removeProperty(property);
  }
  for (const [property, value] of Object.entries(CLIPBOARD_CODE_WRAP_STYLES)) {
    (element as HTMLElement).style.setProperty(property, value);
  }
}

function sanitizeClipboardFlowDom(root: HTMLElement): void {
  const elements: Element[] = [root, ...Array.from(root.querySelectorAll("*"))];
  for (const element of elements) {
    if (isClipboardElementHidden(element)) {
      element.remove();
      continue;
    }
    if (shouldPreserveClipboardLayout(element)) {
      if (CLIPBOARD_CODE_TAGS.has(element.tagName.toLowerCase())) {
        normalizeClipboardCodeLayout(element);
      }
      continue;
    }
    for (const attribute of CLIPBOARD_VIEWPORT_GEOMETRY_ATTRIBUTES) {
      element.removeAttribute(attribute);
    }
    for (const property of CLIPBOARD_LAYOUT_PROPERTIES) {
      (element as HTMLElement).style.removeProperty(property);
    }
    for (const [property, value] of Object.entries(CLIPBOARD_FLOW_WRAP_STYLES)) {
      (element as HTMLElement).style.setProperty(property, value);
    }
  }
}

function cleanRenderedClipboardDom(root: HTMLElement): void {
  const controls = [
    ".milkup-code-block-header",
    ".milkup-code-block-copy-btn",
    ".milkup-copy-image-btn",
    ".milkup-html-block-header",
    ".milkup-list-marker",
    ".cm-gutters",
    ".cm-lineNumbers",
  ].join(",");

  for (const element of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    if (element.matches(controls)) {
      element.remove();
      continue;
    }
    if (
      element.hasAttribute("data-clipboard-hidden") ||
      element.hasAttribute("hidden") ||
      element.getAttribute("aria-hidden") === "true" ||
      element.style.display === "none" ||
      element.style.visibility === "hidden"
    ) {
      element.remove();
      continue;
    }
    element.removeAttribute("contenteditable");
    element.removeAttribute("data-clipboard-pending");
    element.removeAttribute(GRAPHIC_CACHE_ATTRIBUTE);
  }

  for (const checkbox of Array.from(root.querySelectorAll<HTMLElement>(".milkup-task-checkbox"))) {
    const input = root.ownerDocument.createElement("input");
    input.type = "checkbox";
    input.checked = checkbox.getAttribute("aria-checked") === "true";
    input.disabled = true;
    input.style.cssText = checkbox.getAttribute("style") || "";
    checkbox.replaceWith(input);
  }

  for (const editor of Array.from(
    root.querySelectorAll<HTMLElement>(".milkup-code-block-editor, .milkup-html-block-editor")
  )) {
    if (editor.style.display === "none") {
      editor.remove();
      continue;
    }
    const content = editor.querySelector<HTMLElement>(".cm-content");
    if (!content) {
      editor.remove();
      continue;
    }
    const text = Array.from(content.querySelectorAll(".cm-line"))
      .map((line) => line.textContent || "")
      .join("\n");
    if (editor.classList.contains("milkup-html-block-editor")) {
      try {
        const Parser =
          root.ownerDocument.defaultView?.DOMParser ??
          (typeof DOMParser !== "undefined" ? DOMParser : null);
        if (Parser) {
          const parsed = new Parser().parseFromString(text, "text/html");
          const rendered = root.ownerDocument.createElement("div");
          while (parsed.body.firstChild) rendered.appendChild(parsed.body.firstChild);
          editor.replaceWith(rendered);
          continue;
        }
      } catch {
        // Fall through to a source-code fragment if the browser cannot parse it.
      }
    }

    const pre = root.ownerDocument.createElement("pre");
    const code = root.ownerDocument.createElement("code");
    code.textContent = text;
    pre.style.cssText = content.style.cssText;
    code.style.cssText = content.style.cssText;
    pre.appendChild(code);
    editor.replaceWith(pre);
  }

  for (const preview of Array.from(root.querySelectorAll<HTMLElement>(".milkup-image-preview"))) {
    const content = preview.querySelector<HTMLElement>("a, img");
    if (content) preview.replaceWith(content);
  }

  for (const input of Array.from(
    root.querySelectorAll<HTMLInputElement>(".milkup-image-source-input")
  )) {
    const text = root.ownerDocument.createElement("span");
    text.textContent = input.value;
    input.replaceWith(text);
  }
}

export function semanticizeClipboardDom(
  dom: HTMLElement,
  options: ClipboardBuildOptions = {}
): HTMLElement | null {
  if (options.sourceView) return null;

  const root = dom.cloneNode(true) as HTMLElement;
  const document = root.ownerDocument;
  const headingsWithMarker = new Set<Element>();

  for (const marker of Array.from(root.querySelectorAll("span.milkup-syntax"))) {
    const syntaxType = marker.getAttribute("data-syntax-type");
    if (syntaxType === "heading") {
      const heading = marker.closest("h1,h2,h3,h4,h5,h6");
      if (heading) headingsWithMarker.add(heading);
    }

    if (syntaxType === HTML_ENTITY_SYNTAX_TYPE) {
      const decoded = decodeHtmlEntity(marker.textContent ?? "") ?? marker.textContent ?? "";
      const children = Array.from(marker.childNodes);
      const firstText = document
        .createTreeWalker(marker, CLIPBOARD_TREEWALKER_SHOW_TEXT)
        .nextNode();
      if (firstText) firstText.textContent = decoded;
      marker.replaceWith(...(children.length > 0 ? children : [document.createTextNode(decoded)]));
    } else {
      // 语法标记自身可能包着 strong/em 等语义节点；这些节点只承载 Markdown 符号。
      marker.remove();
    }
  }

  for (const heading of headingsWithMarker) {
    const walker = document.createTreeWalker(heading, CLIPBOARD_TREEWALKER_SHOW_TEXT);
    const firstText = walker.nextNode();
    if (firstText?.textContent?.startsWith(" ")) {
      firstText.textContent = firstText.textContent.slice(1);
    }
  }

  sanitizeClipboardFlowDom(root);
  removeGraphicCopyButtons(root);
  return root;
}

export function buildClipboardPayload(
  plain: string,
  selectionRoot: HTMLElement | null,
  options: ClipboardBuildOptions = {}
): ClipboardPayload {
  const richRequired = !options.sourceView;
  const root = selectionRoot ? semanticizeClipboardDom(selectionRoot, options) : null;
  if (!root) return { plain, html: "", richRequired };

  stripUnsafeContent(root);
  applyTableBorders(root);
  applyClipboardFonts(root, options);
  applyClipboardImages(root, options.imageMode);
  applyClipboardPngFallback(root);
  return { plain, html: root.outerHTML, richRequired };
}

export function buildCodeClipboardPayload(
  text: string,
  options: CodeClipboardOptions = {}
): ClipboardPayload {
  const root = document.createElement("div");
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = text;
  if (options.blockStyle) pre.style.cssText = options.blockStyle;
  if (options.codeStyle) {
    if (!options.blockStyle) pre.style.cssText = options.codeStyle;
    code.style.cssText = options.codeStyle;
  }
  if (options.fontFamily && !options.blockStyle) pre.style.fontFamily = options.fontFamily;
  if (options.codeFontFamily) {
    if (!options.blockStyle) pre.style.fontFamily = options.codeFontFamily;
    code.style.fontFamily = options.codeFontFamily;
  }
  pre.appendChild(code);
  root.appendChild(pre);
  return buildClipboardPayload(text, root, options);
}

export function writeClipboardEvent(
  event: ClipboardEvent,
  payload: ClipboardPayload
): ClipboardWriteResult {
  const data = event.clipboardData;
  if (!data) return { status: "failed" };

  let plainWritten = false;
  try {
    data.clearData();
    data.setData("text/plain", payload.plain);
    plainWritten = true;
    if (payload.html) data.setData("text/html", payload.html);
    event.preventDefault();
    return { status: payload.html ? "rich" : "plain" };
  } catch (error) {
    console.error("写入剪贴板失败", error);
    if (!plainWritten) return { status: "failed" };

    // Keep the successful plain-text write usable, but report that the
    // requested rich representation was not available.
    event.preventDefault();
    return { status: "plain" };
  }
}

type ElectronClipboardApi = {
  writeToClipboard?: (payload: { text: string; html: string }) => Promise<boolean>;
  writeTextToClipboard?: (text: string) => Promise<boolean>;
  writeImageToClipboard?: (bytes: Uint8Array<ArrayBuffer>) => Promise<boolean>;
};

function getBrowserClipboard(): Clipboard | null {
  if (typeof navigator === "undefined" || !navigator.clipboard) return null;
  return navigator.clipboard;
}

function getElectronClipboardApi(): ElectronClipboardApi | null {
  if (typeof window === "undefined") return null;
  return window.electronAPI ?? null;
}

async function writeBrowserRichClipboard(payload: ClipboardPayload): Promise<boolean> {
  const clipboard = getBrowserClipboard();
  if (
    !payload.html ||
    !clipboard ||
    typeof clipboard.write !== "function" ||
    typeof ClipboardItem === "undefined"
  ) {
    return false;
  }

  try {
    await clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([payload.plain], { type: "text/plain" }),
        "text/html": new Blob([payload.html], { type: "text/html" }),
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function writeElectronRichClipboard(payload: ClipboardPayload): Promise<boolean> {
  const api = getElectronClipboardApi();
  if (!payload.html || !api?.writeToClipboard) return false;

  try {
    return (await api.writeToClipboard({ text: payload.plain, html: payload.html })) === true;
  } catch {
    return false;
  }
}

async function writeBrowserPlainClipboard(text: string): Promise<boolean> {
  const clipboard = getBrowserClipboard();
  if (!clipboard || typeof clipboard.writeText !== "function") return false;

  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function writeElectronPlainClipboard(text: string): Promise<boolean> {
  const api = getElectronClipboardApi();
  if (!api?.writeTextToClipboard) return false;

  try {
    return (await api.writeTextToClipboard(text)) === true;
  } catch {
    return false;
  }
}

export async function writeClipboardPayload(
  payload: ClipboardPayload
): Promise<ClipboardWriteResult> {
  if (payload.html) {
    if (await writeBrowserRichClipboard(payload)) return { status: "rich" };
    if (await writeElectronRichClipboard(payload)) return { status: "rich" };
  }

  if (await writeBrowserPlainClipboard(payload.plain)) return { status: "plain" };
  if (await writeElectronPlainClipboard(payload.plain)) return { status: "plain" };
  return { status: "failed" };
}

type CodeClipboardRange = { from: number; to: number };
type CodeClipboardPayloadBuilder = (text: string, view: CodeMirrorView) => ClipboardPayload;

export function createCodeClipboardExtension(
  isReadOnly: () => boolean = () => false,
  buildPayload: CodeClipboardPayloadBuilder = (text, view) =>
    buildCodeClipboardPayload(text, getCodeClipboardOptions(view))
): Extension {
  return Prec.highest(
    CodeMirrorView.domEventHandlers({
      copy: (event, view) =>
        writeCodeClipboard(event as ClipboardEvent, view, isReadOnly, buildPayload),
      cut: (event, view) =>
        writeCodeClipboard(event as ClipboardEvent, view, isReadOnly, buildPayload),
    })
  );
}

export function getCodeClipboardSelection(view: CodeMirrorView): {
  text: string;
  ranges: CodeClipboardRange[];
} {
  const selectedRanges = view.state.selection.ranges.filter((range) => !range.empty);
  if (selectedRanges.length > 0) {
    return {
      text: selectedRanges
        .map((range) => view.state.sliceDoc(range.from, range.to))
        .join(view.state.lineBreak),
      ranges: selectedRanges.map((range) => ({ from: range.from, to: range.to })),
    };
  }

  const ranges: CodeClipboardRange[] = [];
  const lines: string[] = [];
  let lastLineNumber = -1;
  for (const range of view.state.selection.ranges) {
    const line = view.state.doc.lineAt(range.from);
    if (line.number <= lastLineNumber) continue;
    lastLineNumber = line.number;
    ranges.push({ from: line.from, to: Math.min(view.state.doc.length, line.to + 1) });
    lines.push(line.text);
  }

  return { text: lines.join(view.state.lineBreak), ranges };
}

function writeCodeClipboard(
  event: ClipboardEvent,
  view: CodeMirrorView,
  isReadOnly: () => boolean,
  buildPayload: CodeClipboardPayloadBuilder
): boolean {
  const selection = document.getSelection();
  const anchor = selection?.anchorNode;
  const focus = selection?.focusNode;
  const selectionIsInside =
    !!anchor && !!focus && view.contentDOM.contains(anchor) && view.contentDOM.contains(focus);

  if (!selectionIsInside) return false;

  // CodeMirror 的默认 cut handler 仍会删除内容；只读时必须由这里拦截。
  if (event.type === "cut" && isReadOnly()) {
    event.preventDefault();
    return true;
  }

  const { text, ranges } = getCodeClipboardSelection(view);
  if (!event.clipboardData || ranges.length === 0) {
    if (event.type === "cut") {
      event.preventDefault();
      return true;
    }
    return false;
  }

  const payload = buildPayload(text, view);
  const result = writeClipboardEvent(event, payload);
  if (event.type === "cut" && !canDeleteAfterClipboardWrite(payload, result)) {
    event.preventDefault();
    return true;
  }
  if (result.status === "failed") return false;

  if (event.type === "cut") {
    view.dispatch({
      changes: ranges,
      scrollIntoView: true,
      userEvent: "delete.cut",
    });
  }
  return true;
}

function stripUnsafeContent(root: HTMLElement): void {
  root
    .querySelectorAll("script,style,iframe,object,embed,link,meta")
    .forEach((node) => node.remove());

  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    element.removeAttribute("contenteditable");
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (["href", "src", "action"].includes(attribute.name)) {
        const value = attribute.value.trim();
        if (
          /^(javascript|vbscript):/i.test(value) ||
          (/^data:/i.test(value) && !/^data:image\//i.test(value))
        ) {
          element.removeAttribute(attribute.name);
        }
      }
    }
  }
}

function applyClipboardFonts(root: HTMLElement, options: ClipboardBuildOptions): void {
  const { fontFamily, codeFontFamily } = options;
  if (fontFamily) root.style.fontFamily = fontFamily;

  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (element.style.fontFamily && !element.style.fontFamily.includes("var(")) continue;
    const tag = element.tagName.toLowerCase();
    const family = ["pre", "code", "kbd", "samp"].includes(tag) ? codeFontFamily : fontFamily;
    if (family) element.style.fontFamily = family;
  }
}

function applyClipboardImages(root: HTMLElement, mode: ImagePasteMethod | undefined): void {
  if (!mode) return;

  for (const image of Array.from(root.querySelectorAll<HTMLImageElement>("img"))) {
    const resolved = resolveClipboardImageSource(image, mode);
    if (resolved) image.setAttribute("src", resolved);
    image.removeAttribute("data-clipboard-src");
  }
}

function getLoadedImageDataUrl(image: HTMLImageElement): string | null {
  if (!image.complete || !image.naturalWidth || !image.naturalHeight) return null;

  try {
    const canvas = image.ownerDocument.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0);
    return canvas.toDataURL();
  } catch {
    return null;
  }
}

export async function cacheClipboardImage(image: HTMLImageElement): Promise<string | null> {
  const dataUrl =
    getLoadedImageDataUrl(image) || (await fetchImageAsDataUrl(image.currentSrc || image.src));
  if (dataUrl && image.isConnected) image.setAttribute("data-clipboard-src", dataUrl);
  return dataUrl;
}

async function fetchImageAsDataUrl(src: string): Promise<string | null> {
  if (!src || src.startsWith("data:")) return null;
  const source = await readImageSourceBytes(src);
  return source ? bytesToDataUrl(source.bytes, source.mimeType) : null;
}

export async function cacheClipboardPng(element: Element): Promise<string | null> {
  element.removeAttribute("data-clipboard-png");
  const dataUrl = await rasterizeElement(element);
  if (dataUrl && element.isConnected) element.setAttribute("data-clipboard-png", dataUrl);
  return dataUrl;
}

export type ClipboardFallbackRasterizer = (element: Element) => Promise<string | null>;

export function requestClipboardPngFallback(
  element: Element,
  rasterize: ClipboardFallbackRasterizer = cacheClipboardPng
): void {
  if (
    !isClipboardElementVisible(element) ||
    element.hasAttribute("data-clipboard-png") ||
    element.hasAttribute("data-clipboard-pending")
  ) {
    return;
  }
  element.setAttribute("data-clipboard-pending", "true");
  void Promise.resolve()
    .then(() => rasterize(element))
    .catch(() => null)
    .finally(() => element.removeAttribute("data-clipboard-pending"));
}

export function refreshClipboardFallbacks(
  root: ParentNode,
  rasterize: ClipboardFallbackRasterizer = cacheClipboardPng
): void {
  const targets = root.querySelectorAll<HTMLElement>(".math-preview, .milkup-mermaid-preview svg");
  for (const target of Array.from(targets)) {
    requestClipboardPngFallback(target, rasterize);
  }
}

function inlineRuntimeStylesForRaster(source: Element, target: Element): void {
  if (typeof getComputedStyle !== "function") return;

  copyElementTree(source, target, (sourceElement, targetElement) => {
    try {
      const computed = getComputedStyle(sourceElement);
      for (let index = 0; index < computed.length; index += 1) {
        const property = computed.item(index);
        const value = computed.getPropertyValue(property);
        if (value) (targetElement as HTMLElement).style.setProperty(property, value);
      }
    } catch {
      // A best-effort inline style is still useful when computed styles are partial.
    }
  });
}

function absolutizeFontFaceCssUrls(css: string, baseUri: string): string {
  return css.replace(/url\((['"]?)([^)'"\s]+)\1\)/gi, (match, quote, value) => {
    if (/^(?:data:|blob:|https?:|file:)/i.test(value)) return match;
    try {
      return `url(${quote}${new URL(value, baseUri).href}${quote})`;
    } catch {
      return match;
    }
  });
}

function getRuntimeFontFaceCss(document: Document): string {
  const rules: string[] = [];
  const sheets = document.styleSheets;

  if (sheets) {
    for (let sheetIndex = 0; sheetIndex < sheets.length; sheetIndex += 1) {
      try {
        const sheet = sheets.item(sheetIndex);
        if (!sheet) continue;
        let sheetRules = 0;
        for (const rule of Array.from(sheet.cssRules)) {
          const cssText = rule.cssText || "";
          if (/^@font-face\b/i.test(cssText.trim())) {
            rules.push(absolutizeFontFaceCssUrls(cssText, document.baseURI));
            sheetRules += 1;
          }
        }
        if (sheetRules === 0) {
          const styleText = sheet.ownerNode?.textContent || "";
          rules.push(
            ...(styleText.match(/@font-face\s*\{[\s\S]*?\}/gi) || []).map((rule) =>
              absolutizeFontFaceCssUrls(rule, document.baseURI)
            )
          );
        }
      } catch {
        // Cross-origin stylesheets are intentionally left to the browser fallback.
      }
    }
  }
  if (rules.length === 0) {
    for (const style of Array.from(document.querySelectorAll("style"))) {
      rules.push(
        ...(style.textContent?.match(/@font-face\s*\{[\s\S]*?\}/gi) || []).map((rule) =>
          absolutizeFontFaceCssUrls(rule, document.baseURI)
        )
      );
    }
  }
  return rules.join("\n");
}

export function buildSelfContainedMarkup(element: Element): { markup: string; isSvg: boolean } {
  const isSvg = element.tagName.toLowerCase() === "svg";
  const clone = element.cloneNode(true) as Element;
  inlineRuntimeStylesForRaster(element, clone);
  removeClipboardPngAttributes(clone);
  removeGraphicCopyButtons(clone);

  const fontFaceCss = getRuntimeFontFaceCss(element.ownerDocument);
  if (fontFaceCss) {
    const style = isSvg
      ? element.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "style")
      : element.ownerDocument.createElement("style");
    style.textContent = fontFaceCss;
    clone.insertBefore(style, clone.firstChild);
  }

  return { markup: clone.outerHTML, isSvg };
}

async function rasterizeElement(element: Element): Promise<string | null> {
  if (
    typeof Image === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return null;
  }

  let url: string | undefined;
  try {
    const width = Math.ceil(element.getBoundingClientRect?.().width || 0);
    const height = Math.ceil(element.getBoundingClientRect?.().height || 0);
    if (width <= 0 || height <= 0) return null;

    const originalMarkup = element.outerHTML;
    const source = buildRasterSvgSource(element, width, height);
    const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);
    url = objectUrl;

    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("PNG fallback image failed to load"));
      image.src = objectUrl;
    });

    const canvas = element.ownerDocument.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);
    if (element.outerHTML !== originalMarkup) return null;
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

function removeClipboardPngAttributes(element: Element): void {
  for (const node of [element, ...Array.from(element.querySelectorAll("*"))]) {
    node.removeAttribute("data-clipboard-png");
    node.removeAttribute(GRAPHIC_CACHE_ATTRIBUTE);
  }
}

function removeGraphicCopyButtons(element: Element): void {
  for (const node of Array.from(element.querySelectorAll(`.${GRAPHIC_COPY_BUTTON_CLASS}`))) {
    node.remove();
  }
}

function applyClipboardPngFallback(root: HTMLElement): void {
  const elements: Element[] = [];
  if (root.hasAttribute("data-clipboard-png")) elements.push(root);
  elements.push(...Array.from(root.querySelectorAll("[data-clipboard-png]")));

  for (const element of elements) {
    const png = element.getAttribute("data-clipboard-png");
    if (!png) continue;

    const document = element.ownerDocument;
    const image = document.createElement("img");
    image.src = png;
    image.alt = element.getAttribute("aria-label") || element.getAttribute("alt") || "";
    image.style.cssText = element.getAttribute("style") || "";
    image.className = "milkup-clipboard-png-fallback";
    image.setAttribute("data-clipboard-fallback-image", "true");
    image.setAttribute("aria-hidden", "true");

    if (element.tagName.toLowerCase() === "svg") {
      const picture = document.createElement("picture");
      const source = document.createElement("source");
      const primary = element.cloneNode(true) as Element;
      removeClipboardPngAttributes(primary);
      source.type = "image/svg+xml";
      source.srcset = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(primary.outerHTML)}`;
      picture.append(source, image);
      element.replaceWith(picture);
      continue;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "milkup-clipboard-fallback";
    wrapper.setAttribute("data-clipboard-fallback", "png");
    const primary = element.cloneNode(true) as Element;
    removeClipboardPngAttributes(primary);
    image.style.display = "none";
    wrapper.append(primary, image);
    element.replaceWith(wrapper);
  }
}

/** 表格是本次剪贴板验收明确需要的唯一额外样式。 */
function applyTableBorders(root: HTMLElement): void {
  for (const table of root.querySelectorAll<HTMLElement>("table")) {
    if (!table.getAttribute("border")) table.setAttribute("border", "1");
    if (!table.style.borderCollapse) table.style.borderCollapse = "collapse";
  }

  for (const cell of root.querySelectorAll<HTMLElement>("th,td")) {
    if (!cell.style.border) cell.style.border = CELL_BORDER;
  }
}

/* -------------------------------------------------------------------------- */
/* 图形复制：把渲染好的图形以 PNG 位图写进剪贴板                              */
/* -------------------------------------------------------------------------- */

const GRAPHIC_COPY_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>`;
const GRAPHIC_COPIED_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const GRAPHIC_FAILED_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

/** 复制按钮的默认提示 */
const GRAPHIC_COPY_TITLE = "复制图形";
/** 复制成功后的提示 */
const GRAPHIC_COPIED_TITLE = "已复制图形";

export type GraphicCopyStatus = "copied" | "failed";

export interface GraphicCopyResult {
  status: GraphicCopyStatus;
  /** 失败原因，给用户看的 */
  reason?: string;
}

/**
 * 图形产出结果。dataUrl 为 null 表示产出失败，reason 说明失败原因。
 */
export interface GraphicProduction {
  dataUrl: string | null;
  reason?: string;
}

/** 图形产出器：返回图形 data URL，失败时给出原因 */
export type GraphicProducer = (container: Element) => Promise<GraphicProduction>;

export interface GraphicCopyButtonOptions {
  /** 图形产出器，缺省用容器里的矢量图 */
  produce?: GraphicProducer;
  /** 复制结束后的回调 */
  onResult?: (result: GraphicCopyResult) => void;
}

/**
 * 把 data URL 解成字节。
 */
export function dataUrlToBytes(dataUrl: string): Uint8Array<ArrayBuffer> | null {
  const match = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(dataUrl);
  if (!match) return null;

  const payload = match[3] ?? "";
  const isBase64 = /;base64/i.test(match[2] ?? "");

  try {
    if (isBase64) {
      if (typeof atob !== "function") return null;
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    }

    const decoded = decodeURIComponent(payload);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index) & 0xff;
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * 取图形容器的实际背景色，取不到时用白色。
 */
export function getGraphicBackgroundColor(element: Element): string {
  if (typeof getComputedStyle !== "function") return "#ffffff";

  let node: Element | null = element;
  while (node) {
    try {
      const color = getComputedStyle(node).backgroundColor;
      if (color && color !== "transparent" && !isFullyTransparent(color)) return color;
    } catch {
      // 计算样式不可用时继续向上找。
    }
    node = node.parentElement;
  }

  return "#ffffff";
}

function isFullyTransparent(color: string): boolean {
  const match = /rgba?\(([^)]+)\)/.exec(color);
  if (!match) return false;
  const parts = (match[1] ?? "").split(",").map((part) => part.trim());
  if (parts.length < 4) return false;
  return Number(parts[3]) === 0;
}

/**
 * 取图形的像素尺寸：优先用布局尺寸，其次用固有尺寸。
 */
function getGraphicSize(element: Element): { width: number; height: number } {
  const rect = element.getBoundingClientRect?.();
  if (rect && rect.width > 0 && rect.height > 0) {
    return { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
  }

  if (element.tagName.toLowerCase() === "img") {
    const image = element as HTMLImageElement;
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      return { width: image.naturalWidth, height: image.naturalHeight };
    }
  }

  const viewBox = element
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map((value) => Number(value));
  if (viewBox && viewBox.length === 4 && viewBox.every((value) => Number.isFinite(value))) {
    return { width: Math.ceil(viewBox[2]), height: Math.ceil(viewBox[3]) };
  }

  const width = Number.parseFloat(element.getAttribute("width") ?? "");
  const height = Number.parseFloat(element.getAttribute("height") ?? "");
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width: Math.ceil(width), height: Math.ceil(height) };
  }

  return { width: 0, height: 0 };
}

/**
 * 把图形元素画成 SVG 源码。
 * 注意：Chromium 会把含 foreignObject 的 SVG 判为污染画布，含 foreignObject 的图形导不出位图。
 */
function buildRasterSvgSource(element: Element, width: number, height: number): string {
  const { markup, isSvg } = buildSelfContainedMarkup(element);
  if (isSvg) {
    return /\sxmlns=/.test(markup)
      ? markup
      : markup.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">${markup}</div></foreignObject></svg>`;
}

/**
 * 把 SVG 源码栅格化成 PNG：按给定底色铺底，2 倍像素密度，最长边 4096 截断。
 */
export async function rasterizeSvgSource(
  ownerDocument: Document,
  source: string,
  width: number,
  height: number,
  background: string
): Promise<string | null> {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  if (width <= 0 || height <= 0) return null;

  const scale = Math.min(GRAPHIC_SCALE, GRAPHIC_MAX_SIDE / Math.max(width, height));
  const canvas = ownerDocument.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));

  const context = canvas.getContext("2d");
  if (!context) return null;

  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);

  try {
    const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("graphic rasterization failed"));
        image.src = url;
      });
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
    } finally {
      URL.revokeObjectURL(url);
    }

    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/**
 * 把图形元素栅格化成 PNG：按给定底色铺底，2 倍像素密度，最长边 4096 截断。
 */
export async function rasterizeGraphic(
  element: Element,
  background?: string
): Promise<string | null> {
  const { width, height } = getGraphicSize(element);
  if (width <= 0 || height <= 0) return null;

  const source = buildRasterSvgSource(element, width, height);
  return rasterizeSvgSource(
    element.ownerDocument,
    source,
    width,
    height,
    background ?? getGraphicBackgroundColor(element)
  );
}
/**
 * 默认产出器：栅格化容器里的矢量图。
 */
async function defaultGraphicProducer(container: Element): Promise<GraphicProduction> {
  const target = container.querySelector("svg") ?? container;
  const dataUrl = await rasterizeGraphic(target, getGraphicBackgroundColor(container));
  return dataUrl ? { dataUrl } : { dataUrl: null, reason: "图形栅格化失败" };
}

/**
 * 解析图形容器的图形：优先用图形缓存，缓存缺失时当场产出。
 */
export async function resolveGraphicProduction(
  container: Element,
  produce: GraphicProducer = defaultGraphicProducer
): Promise<GraphicProduction> {
  const cached = findGraphicCache(container);
  if (cached) return { dataUrl: cached };

  const production = await produce(container);
  if (!production.dataUrl) return production;
  if (container.isConnected) container.setAttribute(GRAPHIC_CACHE_ATTRIBUTE, production.dataUrl);
  return production;
}

/**
 * 把图形复制到剪贴板。只写图形载荷，不写纯文本载荷与渲染载荷。
 */
export async function copyGraphicToClipboard(
  container: Element,
  produce?: GraphicProducer
): Promise<GraphicCopyResult> {
  const production = await resolveGraphicProduction(container, produce);
  if (!production.dataUrl) return { status: "failed", reason: production.reason };

  const bytes = dataUrlToBytes(production.dataUrl);
  if (!bytes || bytes.length === 0) return { status: "failed", reason: "图形数据为空" };

  const api = getElectronClipboardApi();
  if (!api?.writeImageToClipboard) return { status: "failed", reason: "剪贴板不可用" };

  try {
    const written = await api.writeImageToClipboard(bytes);
    return written === true
      ? { status: "copied" }
      : { status: "failed", reason: "剪贴板写入失败" };
  } catch {
    return { status: "failed", reason: "剪贴板写入失败" };
  }
}

/**
 * 产出插入图片的可复制图形：位图直传原图字节，SVG 原图栅格化成 PNG。
 */
export async function produceImageGraphic(container: Element): Promise<GraphicProduction> {
  const image = container.querySelector("img");
  if (!image) return { dataUrl: null, reason: "没有可复制的图片" };

  if (!image.complete || !image.naturalWidth || !image.naturalHeight) {
    return { dataUrl: null, reason: "图片尚未加载完成" };
  }

  const source = await readImageSourceBytes(image.currentSrc || image.src || "");
  if (!source) return { dataUrl: null, reason: "读取图片失败" };

  if (!isSvgImageSource(source)) {
    return { dataUrl: bytesToDataUrl(source.bytes, source.mimeType) };
  }

  const svgText = new TextDecoder().decode(source.bytes);
  // 含 foreignObject 的 SVG 会被 Chromium 判为污染画布，导不出位图（见 ADR-0003）。
  if (/<foreignObject\b/i.test(svgText)) {
    return { dataUrl: null, reason: "SVG 含 foreignObject，无法转成 PNG" };
  }

  const size = readSvgIntrinsicSize(svgText) ?? {
    width: image.naturalWidth,
    height: image.naturalHeight,
  };
  const dataUrl = await rasterizeSvgSource(
    container.ownerDocument,
    withExplicitSvgSize(svgText, size.width, size.height),
    size.width,
    size.height,
    getGraphicBackgroundColor(container)
  );

  return dataUrl ? { dataUrl } : { dataUrl: null, reason: "SVG 图片转 PNG 失败" };
}

/**
 * 创建图形复制按钮。三类图形共用同一个实现：同一图标、同一位置、同一反馈。
 */
export function createGraphicCopyButton(
  container: Element,
  options: GraphicCopyButtonOptions = {}
): HTMLButtonElement {
  const document = container.ownerDocument;
  const button = document.createElement("button");
  button.className = GRAPHIC_COPY_BUTTON_CLASS;
  button.type = "button";
  setButtonState(button, GRAPHIC_COPY_TITLE);
  button.innerHTML = GRAPHIC_COPY_ICON;

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    void copyGraphicToClipboard(container, options.produce).then((result) => {
      const copied = result.status === "copied";
      button.classList.toggle("copied", copied);
      button.classList.toggle("failed", !copied);
      button.innerHTML = copied ? GRAPHIC_COPIED_ICON : GRAPHIC_FAILED_ICON;
      setButtonState(button, copied ? GRAPHIC_COPIED_TITLE : `复制图形失败：${result.reason ?? "未知原因"}`);

      setTimeout(() => {
        button.classList.remove("copied", "failed");
        button.innerHTML = GRAPHIC_COPY_ICON;
        setButtonState(button, GRAPHIC_COPY_TITLE);
      }, 1500);

      options.onResult?.(result);
    });
  });

  return button;
}

/** 同步按钮的提示与无障碍标签 */
function setButtonState(button: HTMLButtonElement, title: string): void {
  button.title = title;
  button.setAttribute("aria-label", title);
}
