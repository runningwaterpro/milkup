import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Window } from "happy-dom";
import {
  buildClipboardPayload,
  copyGraphicToClipboard,
  createGraphicCopyButton,
  dataUrlToBytes,
  resolveGraphicImageBytes,
} from "../src/core/clipboard.ts";

const window = new Window();
const previousGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  Node: globalThis.Node,
  NodeFilter: globalThis.NodeFilter,
  HTMLElement: globalThis.HTMLElement,
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

test("resolveGraphicImageBytes uses the cached graphic png", async () => {
  const root = makeRoot(`<div class="milkup-mermaid-preview" data-graphic-png="${pngDataUrl()}"></div>`);
  let produced = 0;

  const bytes = await resolveGraphicImageBytes(root, async () => {
    produced += 1;
    return null;
  });

  assert.ok(bytes);
  assert.equal(bytes[0], 0x89);
  assert.equal(produced, 0);
});

test("resolveGraphicImageBytes produces the graphic when the cache is missing", async () => {
  const root = makeRoot('<div class="milkup-mermaid-preview"></div>');
  const calls = [];

  const bytes = await resolveGraphicImageBytes(root, async (container) => {
    calls.push(container);
    return pngDataUrl();
  });

  assert.ok(bytes);
  assert.equal(bytes[0], 0x89);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], root);
});

test("resolveGraphicImageBytes returns null when the graphic cannot be produced", async () => {
  const root = makeRoot('<div class="milkup-mermaid-preview"></div>');

  const bytes = await resolveGraphicImageBytes(root, async () => null);

  assert.equal(bytes, null);
});

test("copyGraphicToClipboard writes only the graphic payload", async () => {
  const calls = installClipboardBridge();
  const root = makeRoot(`<div class="milkup-mermaid-preview" data-graphic-png="${pngDataUrl()}"></div>`);

  const result = await copyGraphicToClipboard(root);

  assert.equal(result.status, "copied");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 0x89);
});

test("copyGraphicToClipboard writes nothing when the graphic cannot be produced", async () => {
  const calls = installClipboardBridge();
  const root = makeRoot('<div class="milkup-mermaid-preview"></div>');

  const result = await copyGraphicToClipboard(root, async () => null);

  assert.equal(result.status, "failed");
  assert.equal(calls.length, 0);
});

test("copyGraphicToClipboard fails when the clipboard bridge is missing", async () => {
  removeClipboardBridge();
  const root = makeRoot(`<div class="milkup-mermaid-preview" data-graphic-png="${pngDataUrl()}"></div>`);

  const result = await copyGraphicToClipboard(root);

  assert.equal(result.status, "failed");
});

test("createGraphicCopyButton copies the graphic when clicked", async () => {
  const calls = installClipboardBridge();
  const root = makeRoot(`<div class="milkup-mermaid-preview" data-graphic-png="${pngDataUrl()}"></div>`);
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
    produce: async () => null,
    onResult: (result) => resolveResult(result),
  });
  root.appendChild(button);

  button.click();
  const result = await resultPromise;

  assert.equal(result.status, "failed");
  assert.equal(button.classList.contains("failed"), true);
  assert.equal(button.classList.contains("copied"), false);
});

test("createGraphicCopyButton click does not bubble to the graphic", () => {
  installClipboardBridge();
  const root = makeRoot(`<div class="milkup-mermaid-preview" data-graphic-png="${pngDataUrl()}"></div>`);
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
