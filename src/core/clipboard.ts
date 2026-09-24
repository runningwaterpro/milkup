import { Prec } from "@codemirror/state";
import { EditorView as CodeMirrorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type { EditorView as ProseMirrorView } from "prosemirror-view";
import { decodeHtmlEntity, HTML_ENTITY_SYNTAX_TYPE } from "./utils/html-entities.ts";
import type { ImagePasteMethod } from "./plugins/paste";

const CELL_BORDER = "1px solid #cccccc";

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

function copyClipboardImageSource(
  source: Element,
  target: Element,
  imageMode?: ImagePasteMethod
): void {
  if (!imageMode || source.tagName.toLowerCase() !== "img") return;
  const cached = source.getAttribute("data-clipboard-src");
  if (cached) {
    target.setAttribute("src", cached);
    target.removeAttribute("data-clipboard-src");
    return;
  }

  const image = source as HTMLImageElement;
  const src = image.currentSrc || image.getAttribute("src") || "";
  if (!src || src.startsWith("data:")) return;
  if (imageMode === "remote" && /^(?:https?:|data:)/i.test(src)) {
    if (image.currentSrc) target.setAttribute("src", image.currentSrc);
    return;
  }

  const dataUrl = getLoadedImageDataUrl(image);
  if (dataUrl) target.setAttribute("src", dataUrl);
  else if (image.currentSrc) target.setAttribute("src", image.currentSrc);
}

// Text must reflow in the target; only bounded objects keep layout dimensions.
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

const CLIPBOARD_LAYOUT_TAGS = new Set(["table", "th", "td", "img", "svg", "canvas", "pre", "code"]);
const CLIPBOARD_LAYOUT_CONTAINERS =
  "table, .milkup-code-block-editor, .milkup-html-block-editor, .milkup-image-block, .milkup-mermaid-preview";

function shouldPreserveClipboardLayout(source: Element): boolean {
  const tag = source.tagName.toLowerCase();
  return CLIPBOARD_LAYOUT_TAGS.has(tag) || !!source.closest(CLIPBOARD_LAYOUT_CONTAINERS);
}

function copyComputedStyles(source: Element, target: Element, imageMode?: ImagePasteMethod): void {
  copyClipboardImageSource(source, target, imageMode);
  const preserveLayout = shouldPreserveClipboardLayout(source);
  if (!preserveLayout) {
    for (const property of CLIPBOARD_LAYOUT_PROPERTIES) {
      (target as HTMLElement).style.removeProperty(property);
    }
  }
  if (typeof getComputedStyle === "function") {
    const computed = getComputedStyle(source);
    for (const property of Array.from(computed)) {
      if (!preserveLayout && CLIPBOARD_LAYOUT_PROPERTIES.has(property)) {
        (target as HTMLElement).style.removeProperty(property);
        continue;
      }
      const value = computed.getPropertyValue(property);
      if (value) (target as HTMLElement).style.setProperty(property, value);
    }
  }

  const sourceChildren = Array.from(source.children);
  const targetChildren = Array.from(target.children);
  for (let i = 0; i < sourceChildren.length; i++) {
    copyComputedStyles(sourceChildren[i], targetChildren[i], imageMode);
  }
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

function cleanRenderedClipboardDom(root: HTMLElement): void {
  const controls = [
    ".milkup-code-block-header",
    ".milkup-code-block-copy-btn",
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
    if (element.style.display === "none" || element.style.visibility === "hidden") {
      element.remove();
      continue;
    }
    element.removeAttribute("contenteditable");
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
    const pre = root.ownerDocument.createElement("pre");
    const code = root.ownerDocument.createElement("code");
    code.textContent = Array.from(content.querySelectorAll(".cm-line"))
      .map((line) => line.textContent || "")
      .join("\n");
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
      const firstText = document.createTreeWalker(marker, 4).nextNode();
      if (firstText) firstText.textContent = decoded;
      marker.replaceWith(...(children.length > 0 ? children : [document.createTextNode(decoded)]));
    } else {
      // 语法标记自身可能包着 strong/em 等语义节点；这些节点只承载 Markdown 符号。
      marker.remove();
    }
  }

  for (const heading of headingsWithMarker) {
    const walker = document.createTreeWalker(heading, 4);
    const firstText = walker.nextNode();
    if (firstText?.textContent?.startsWith(" ")) {
      firstText.textContent = firstText.textContent.slice(1);
    }
  }

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
    const cached = image.getAttribute("data-clipboard-src");
    if (cached) {
      image.setAttribute("src", cached);
      image.removeAttribute("data-clipboard-src");
      continue;
    }

    const src = image.getAttribute("src") || "";
    if (!src || src.startsWith("data:")) continue;
    if (mode === "remote" && /^(?:https?:|data:)/i.test(src)) continue;

    const dataUrl = getLoadedImageDataUrl(image);
    if (dataUrl) image.setAttribute("src", dataUrl);
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
  try {
    const response = await fetch(src);
    if (!response.ok && response.status !== 0) return null;
    return await blobToDataUrl(await response.blob());
  } catch {
    return null;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => resolve("");
    reader.readAsDataURL(blob);
  });
}

export async function cacheClipboardPng(element: Element): Promise<string | null> {
  element.removeAttribute("data-clipboard-png");
  const dataUrl = await rasterizeElement(element);
  if (dataUrl && element.isConnected) element.setAttribute("data-clipboard-png", dataUrl);
  return dataUrl;
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

    const markup = element.outerHTML;
    const isSvg = element.tagName.toLowerCase() === "svg";
    const svgMarkup =
      isSvg && !/\sxmlns=/.test(markup)
        ? markup.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"')
        : markup;
    const source = isSvg
      ? svgMarkup
      : `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">${markup}</div></foreignObject></svg>`;
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
    if (element.outerHTML !== markup) return null;
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

function applyClipboardPngFallback(root: HTMLElement): void {
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("[data-clipboard-png]"))) {
    const png = element.getAttribute("data-clipboard-png");
    if (!png) continue;

    const document = element.ownerDocument;
    const image = document.createElement("img");
    image.src = png;
    image.alt = element.getAttribute("aria-label") || element.getAttribute("alt") || "";
    image.className = element.getAttribute("class") || "";
    image.style.cssText = element.getAttribute("style") || "";

    if (element.tagName.toLowerCase() === "svg") {
      const picture = document.createElement("picture");
      const source = document.createElement("source");
      source.type = "image/svg+xml";
      source.srcset = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(element.outerHTML)}`;
      picture.append(source, image);
      element.replaceWith(picture);
    } else {
      element.replaceWith(image);
    }
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
