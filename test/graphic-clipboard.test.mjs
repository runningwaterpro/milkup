import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Window } from "happy-dom";
import {
  buildClipboardPayload,
  copyGraphicToClipboard,
  createGraphicCopyButton,
  dataUrlToBytes,
  produceImageGraphic,
  resolveGraphicProduction,
} from "../src/core/clipboard.ts";
import { stripGraphicCacheAttributes } from "../src/core/utils/graphic-cache.ts";
import {
  bytesToDataUrl,
  isSvgImageSource,
  readImageSourceBytes,
  readSvgIntrinsicSize,
  withExplicitSvgSize,
} from "../src/core/utils/image-source.ts";

const window = new Window();
const previousGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  Node: globalThis.Node,
  NodeFilter: globalThis.NodeFilter,
  HTMLElement: globalThis.HTMLElement,
  fetch: globalThis.fetch,
};

Object.assign(globalThis, {
  window,
  document: window.document,
  Node: window.Node,
  NodeFilter: window.NodeFilter,
  HTMLElement: window.HTMLElement,
});

after(() => {
  window.close();
  Object.assign(globalThis, previousGlobals);
});

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const SVG_SOURCE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="red"/></svg>';

function pngDataUrl(base64 = PNG_BASE64) {
  return `data:image/png;base64,${base64}`;
}

function makeRoot(html) {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

function installClipboardBridge(result = true) {
  const calls = [];
  window.electronAPI = {
    writeImageToClipboard: async (bytes) => {
      calls.push(bytes);
      return result;
    },
  };
  return calls;
}

function removeClipboardBridge() {
  window.electronAPI = undefined;
}

/** 用假的服务端响应替换 fetch */
function stubFetch(responses) {
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    const response = responses[String(url)];
    if (!response) return new Response("", { status: 404 });
    return new Response(response.body, {
      status: 200,
      headers: { "content-type": response.type },
    });
  };
  return requests;
}

function pngBytes() {
  return Uint8Array.from(atob(PNG_BASE64), (char) => char.charCodeAt(0));
}

test("dataUrlToBytes decodes a base64 data url into bytes", () => {
  const bytes = dataUrlToBytes(pngDataUrl());

  assert.ok(bytes);
  assert.equal(bytes[0], 0x89);
  assert.equal(bytes[1], 0x50);
  assert.equal(bytes[2], 0x4e);
  assert.equal(bytes[3], 0x47);
});

test("dataUrlToBytes rejects a malformed data url", () => {
  assert.equal(dataUrlToBytes("not-a-data-url"), null);
});

test("resolveGraphicProduction uses the cached graphic", async () => {
  const root = makeRoot(`<div class="milkup-mermaid-preview" data-graphic-image="${pngDataUrl()}"></div>`);
  let produced = 0;

  const production = await resolveGraphicProduction(root, async () => {
    produced += 1;
    return { dataUrl: null };
  });

  assert.equal(production.dataUrl, pngDataUrl());
  assert.equal(produced, 0);
});

test("resolveGraphicProduction produces the graphic when the cache is missing", async () => {
  const root = makeRoot('<div class="milkup-mermaid-preview"></div>');
  const calls = [];

  const production = await resolveGraphicProduction(root, async (container) => {
    calls.push(container);
    return { dataUrl: pngDataUrl() };
  });

  assert.equal(production.dataUrl, pngDataUrl());
  assert.equal(calls.length, 1);
  assert.equal(calls[0], root);
});

test("resolveGraphicProduction keeps the failure reason", async () => {
  const root = makeRoot('<div class="milkup-mermaid-preview"></div>');

  const production = await resolveGraphicProduction(root, async () => ({
    dataUrl: null,
    reason: "图片尚未加载完成",
  }));

  assert.equal(production.dataUrl, null);
  assert.equal(production.reason, "图片尚未加载完成");
});

test("copyGraphicToClipboard writes only the graphic payload", async () => {
  const calls = installClipboardBridge();
  const root = makeRoot(`<div class="milkup-mermaid-preview" data-graphic-image="${pngDataUrl()}"></div>`);

  const result = await copyGraphicToClipboard(root);

  assert.equal(result.status, "copied");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 0x89);
});

test("copyGraphicToClipboard writes nothing when the graphic cannot be produced", async () => {
  const calls = installClipboardBridge();
  const root = makeRoot('<div class="milkup-mermaid-preview"></div>');

  const result = await copyGraphicToClipboard(root, async () => ({ dataUrl: null }));

  assert.equal(result.status, "failed");
  assert.equal(calls.length, 0);
});

test("copyGraphicToClipboard fails when the clipboard bridge is missing", async () => {
  removeClipboardBridge();
  const root = makeRoot(`<div class="milkup-mermaid-preview" data-graphic-image="${pngDataUrl()}"></div>`);

  const result = await copyGraphicToClipboard(root);

  assert.equal(result.status, "failed");
});

test("createGraphicCopyButton copies the graphic when clicked", async () => {
  const calls = installClipboardBridge();
  const root = makeRoot(`<div class="milkup-mermaid-preview" data-graphic-image="${pngDataUrl()}"></div>`);
  let resolveResult;
  const resultPromise = new Promise((resolve) => {
    resolveResult = resolve;
  });
  const button = createGraphicCopyButton(root, { onResult: (result) => resolveResult(result) });
  root.appendChild(button);

  button.click();
  const result = await resultPromise;

  assert.equal(result.status, "copied");
  assert.equal(calls.length, 1);
  assert.equal(button.classList.contains("copied"), true);
  assert.equal(button.classList.contains("failed"), false);
});

test("createGraphicCopyButton shows the failure state when the copy fails", async () => {
  installClipboardBridge();
  const root = makeRoot('<div class="milkup-mermaid-preview"></div>');
  let resolveResult;
  const resultPromise = new Promise((resolve) => {
    resolveResult = resolve;
  });
  const button = createGraphicCopyButton(root, {
    produce: async () => ({ dataUrl: null, reason: "图片尚未加载完成" }),
    onResult: (result) => resolveResult(result),
  });
  root.appendChild(button);

  button.click();
  const result = await resultPromise;

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "图片尚未加载完成");
  assert.equal(button.classList.contains("failed"), true);
  assert.equal(button.classList.contains("copied"), false);
  assert.equal(button.title, "复制图形失败：图片尚未加载完成");
});

test("createGraphicCopyButton click does not bubble to the graphic", () => {
  installClipboardBridge();
  const root = makeRoot(`<div class="milkup-mermaid-preview" data-graphic-image="${pngDataUrl()}"></div>`);
  let bubbled = 0;
  root.addEventListener("click", () => {
    bubbled += 1;
  });
  const button = createGraphicCopyButton(root);
  root.appendChild(button);

  button.click();

  assert.equal(bubbled, 0);
});

test("buildClipboardPayload drops the graphic copy button from the copied html", () => {
  const root = makeRoot(
    '<div class="milkup-mermaid-preview"><button class="milkup-graphic-copy-btn"></button><svg></svg></div>'
  );

  const payload = buildClipboardPayload("mermaid", root);

  assert.equal(payload.html.includes("milkup-graphic-copy-btn"), false);
});

test("readImageSourceBytes returns the original bytes of the image", async () => {
  const bytes = pngBytes();
  const requests = stubFetch({
    "https://example.com/pic.png": { body: bytes, type: "image/png" },
  });

  const source = await readImageSourceBytes("https://example.com/pic.png");

  assert.ok(source);
  assert.equal(source.mimeType, "image/png");
  assert.deepEqual(Array.from(source.bytes), Array.from(bytes));
  assert.deepEqual(requests, ["https://example.com/pic.png"]);
});

test("readImageSourceBytes returns null when the image cannot be read", async () => {
  stubFetch({});

  const source = await readImageSourceBytes("https://example.com/missing.png");

  assert.equal(source, null);
});

test("bytesToDataUrl keeps the original bytes intact", () => {
  const bytes = pngBytes();

  const dataUrl = bytesToDataUrl(bytes, "image/png");
  const decoded = dataUrlToBytes(dataUrl);

  assert.ok(decoded);
  assert.deepEqual(Array.from(decoded), Array.from(bytes));
});

test("isSvgImageSource tells svg apart from bitmap", () => {
  const svgBytes = Uint8Array.from(
    new TextEncoder().encode(SVG_SOURCE),
    (char) => char
  );

  assert.equal(isSvgImageSource({ bytes: svgBytes, mimeType: "image/svg+xml" }), true);
  assert.equal(isSvgImageSource({ bytes: pngBytes(), mimeType: "image/png" }), false);
});

test("readSvgIntrinsicSize reads the size of the svg", () => {
  assert.deepEqual(readSvgIntrinsicSize(SVG_SOURCE), { width: 40, height: 20 });
  assert.deepEqual(
    readSvgIntrinsicSize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 6"></svg>'),
    { width: 12, height: 6 }
  );
  assert.equal(readSvgIntrinsicSize("<div></div>"), null);
});

test("withExplicitSvgSize writes the size into the svg root", () => {
  const sized = withExplicitSvgSize(SVG_SOURCE, 80, 40);

  assert.equal(sized.includes('width="80"'), true);
  assert.equal(sized.includes('height="40"'), true);
});

test("produceImageGraphic passes the original bitmap bytes through", async () => {
  const bytes = pngBytes();
  stubFetch({
    "https://example.com/pic.png": { body: bytes, type: "image/png" },
  });

  const root = makeRoot(
    '<div class="milkup-image-preview"><img src="https://example.com/pic.png"></div>'
  );
  const image = root.querySelector("img");
  Object.defineProperty(image, "complete", { value: true });
  Object.defineProperty(image, "naturalWidth", { value: 1 });
  Object.defineProperty(image, "naturalHeight", { value: 1 });

  const production = await produceImageGraphic(root);

  assert.ok(production.dataUrl);
  const decoded = dataUrlToBytes(production.dataUrl);
  assert.ok(decoded);
  assert.deepEqual(Array.from(decoded), Array.from(bytes));
});

test("produceImageGraphic fails with a reason when the image is not loaded", async () => {
  const root = makeRoot('<div class="milkup-image-preview"><img src="https://example.com/pic.png"></div>');
  const image = root.querySelector("img");
  Object.defineProperty(image, "complete", { value: false });

  const production = await produceImageGraphic(root);

  assert.equal(production.dataUrl, null);
  assert.equal(production.reason, "图片尚未加载完成");
});

test("produceImageGraphic sends svg images to the rasterizing branch", async () => {
  const svgBytes = new TextEncoder().encode(SVG_SOURCE);
  stubFetch({
    "https://example.com/pic.svg": { body: svgBytes, type: "image/svg+xml" },
  });

  const root = makeRoot(
    '<div class="milkup-image-preview"><img src="https://example.com/pic.svg"></div>'
  );
  const image = root.querySelector("img");
  Object.defineProperty(image, "complete", { value: true });
  Object.defineProperty(image, "naturalWidth", { value: 40 });
  Object.defineProperty(image, "naturalHeight", { value: 20 });

  const production = await produceImageGraphic(root);

  // happy-dom 没有真实画布，栅格化出不来位图。
  // 位图走的是直传分支，会拿到原图字节；SVG 走的是栅格化分支，这里拿不到。
  assert.equal(production.dataUrl, null);
  assert.equal(production.reason, "SVG 图片转 PNG 失败");
});

test("produceImageGraphic explains that foreignObject svg cannot be rasterized", async () => {
  const svgWithForeignObject =
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><foreignObject><div>x</div></foreignObject></svg>';
  stubFetch({
    "https://example.com/pic.svg": {
      body: new TextEncoder().encode(svgWithForeignObject),
      type: "image/svg+xml",
    },
  });

  const root = makeRoot(
    '<div class="milkup-image-preview"><img src="https://example.com/pic.svg"></div>'
  );
  const image = root.querySelector("img");
  Object.defineProperty(image, "complete", { value: true });
  Object.defineProperty(image, "naturalWidth", { value: 40 });
  Object.defineProperty(image, "naturalHeight", { value: 20 });

  const production = await produceImageGraphic(root);

  assert.equal(production.dataUrl, null);
  assert.equal(production.reason, "SVG 含 foreignObject，无法转成 PNG");
});

test("stripGraphicCacheAttributes drops the cached graphic from a tree", () => {
  const root = makeRoot(
    `<div class="milkup-image-preview" data-graphic-image="${pngDataUrl()}"><span data-graphic-image="${pngDataUrl()}"></span></div>`
  );

  stripGraphicCacheAttributes(root);

  assert.equal(root.hasAttribute("data-graphic-image"), false);
  assert.equal(root.querySelector("span").hasAttribute("data-graphic-image"), false);
});
