import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Window } from "happy-dom";
import {
  buildClipboardPayload,
  buildCodeClipboardPayload,
  getClipboardFontFamilies,
  getRenderedNodeRoot,
  getRenderedSelectionRoot,
  semanticizeClipboardDom,
  writeClipboardEvent,
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

function makeRoot(html) {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

test("semanticizeClipboardDom removes syntax markers but keeps semantic elements", () => {
  const root = makeRoot(
    '<h1 data-pm-slice="0 0 []"><span class="milkup-syntax" data-syntax-type="heading">#</span> Title</h1>' +
      '<p><span class="milkup-syntax" data-syntax-type="strong"><strong>**</strong></span><strong>bold</strong>' +
      '<span class="milkup-syntax" data-syntax-type="strong"><strong>**</strong></span>' +
      '<span class="milkup-syntax" data-syntax-type="link"><a>[</a></span><a href="/target">site</a>' +
      '<span class="milkup-syntax" data-syntax-type="link"><a>](/target)</a></span>' +
      '<span class="milkup-syntax" data-syntax-type="html_inline"><u>&lt;u&gt;</u></span><u>under</u>' +
      '<span class="milkup-syntax" data-syntax-type="html_entity"><strong>&amp;</strong></span></p>'
  );

  const result = semanticizeClipboardDom(root);

  assert.ok(result);
  assert.equal(result.querySelector("h1")?.textContent, "Title");
  assert.equal(result.querySelector("strong")?.textContent, "bold");
  assert.equal(result.querySelector("a")?.getAttribute("href"), "/target");
  assert.equal(result.querySelector("a")?.textContent, "site");
  assert.equal(result.querySelector("u")?.textContent, "under");
  assert.equal(result.querySelectorAll("strong")[1]?.textContent, "&");
  assert.equal(result.querySelector("p")?.textContent, "boldsiteunder&");
  assert.equal(result.innerHTML.includes("**"), false);
  assert.equal(result.querySelectorAll(".milkup-syntax").length, 0);
  assert.equal(result.querySelector("[data-pm-slice]")?.getAttribute("data-pm-slice"), "0 0 []");
  assert.equal(root.querySelectorAll(".milkup-syntax").length, 7);
});

test("buildClipboardPayload adds table borders", () => {
  const root = makeRoot("<table><tbody><tr><th>名称</th><td>合同</td></tr></tbody></table>");

  const payload = buildClipboardPayload("| 名称 | 合同 |", root);
  const parsed = new window.DOMParser().parseFromString(payload.html, "text/html");

  assert.equal(payload.plain, "| 名称 | 合同 |");
  assert.equal(parsed.querySelector("table")?.getAttribute("border"), "1");
  assert.equal(parsed.querySelector("th")?.style.border, "1px solid #cccccc");
  assert.equal(parsed.querySelector("td")?.style.border, "1px solid #cccccc");
});

test("buildClipboardPayload carries the configured fonts into HTML", () => {
  const root = makeRoot("<p>中文</p><pre><code>const value = 1</code></pre>");
  const payload = buildClipboardPayload("中文", root, {
    fontFamily: '"UserConfiguredSans", sans-serif',
    codeFontFamily: '"UserConfiguredCode", monospace',
  });
  const parsed = new window.DOMParser().parseFromString(payload.html, "text/html");
  const host = parsed.body.firstElementChild;
  const paragraph = parsed.querySelector("p");
  const pre = parsed.querySelector("pre");

  assert.match(host?.style.fontFamily ?? "", /UserConfiguredSans/);
  assert.match(host?.style.fontFamily ?? "", /sans-serif/);
  assert.match(paragraph?.style.fontFamily ?? "", /UserConfiguredSans/);
  assert.match(pre?.style.fontFamily ?? "", /UserConfiguredCode/);
});

test("reads font families from the current runtime CSS", () => {
  const previous = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({
    fontFamily: "runtime-fallback",
    getPropertyValue(name) {
      if (name === "--milkup-font-default") return '"ConfiguredSans", sans-serif;';
      if (name === "--milkup-font-code") return '"ConfiguredCode", monospace;';
      return "";
    },
  });

  try {
    assert.deepEqual(getClipboardFontFamilies(document.createElement("div")), {
      fontFamily: '"ConfiguredSans", sans-serif',
      codeFontFamily: '"ConfiguredCode", monospace',
    });
  } finally {
    if (previous === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = previous;
  }
});

test("buildClipboardPayload prefers a cached local image data URL", () => {
  const root = makeRoot(
    '<img data-clipboard-src="data:image/png;base64,cached" src="file:///local.png">'
  );
  const payload = buildClipboardPayload("![图](local.png)", root, { imageMode: "local" });
  assert.match(payload.html, /src="data:image\/png;base64,cached"/);
});

test("getRenderedSelectionRoot clones visible DOM and drops editor controls", () => {
  const editorDom = makeRoot(
    '<div class="milkup-code-block"><div class="milkup-code-block-header">JavaScript</div>' +
      '<div class="milkup-code-block-editor"><div class="cm-gutters">1</div>' +
      '<div class="cm-content"><div class="cm-line">one</div><div class="cm-line">two</div></div></div></div>'
  );
  document.body.appendChild(editorDom);
  const range = document.createRange();
  range.selectNodeContents(editorDom);
  const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  const result = getRenderedSelectionRoot({ dom: editorDom });
  assert.ok(result);
  assert.equal(result.querySelector("pre code")?.textContent, "one\ntwo");
  assert.equal(result.querySelector(".milkup-code-block-header"), null);
  assert.equal(result.querySelector(".cm-gutters"), null);
  editorDom.remove();
});

test("getRenderedSelectionRoot drops prose layout but keeps table dimensions", () => {
  const editorDom = makeRoot(
    '<p style="width: 320px; max-width: 320px; height: 100px; white-space: pre-wrap; font-size: 18px;">text</p>' +
      '<table style="width: 640px"><tbody><tr><td>cell</td></tr></tbody></table>'
  );
  document.body.appendChild(editorDom);
  const range = document.createRange();
  range.selectNodeContents(editorDom);
  const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  const result = getRenderedSelectionRoot({ dom: editorDom });
  const paragraph = result?.querySelector("p");
  const table = result?.querySelector("table");
  assert.equal(paragraph?.style.width, "");
  assert.equal(paragraph?.style.maxWidth, "");
  assert.equal(paragraph?.style.height, "");
  assert.equal(paragraph?.style.whiteSpace, "");
  assert.equal(paragraph?.style.fontSize, "18px");
  assert.equal(table?.style.width, "640px");
  editorDom.remove();
});

test("getRenderedSelectionRoot normalizes an HTML block editor", () => {
  const editorDom = makeRoot(
    '<div class="milkup-html-block-editor"><div class="cm-gutters">1</div>' +
      '<div class="cm-content"><div class="cm-line">&lt;b&gt;x&lt;/b&gt;</div></div></div>'
  );
  document.body.appendChild(editorDom);
  const range = document.createRange();
  range.selectNodeContents(editorDom);
  const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  const result = getRenderedSelectionRoot({ dom: editorDom });
  assert.equal(result?.querySelector("pre code")?.textContent, "<b>x</b>");
  assert.equal(result?.querySelector(".cm-gutters"), null);
  editorDom.remove();
});

test("getRenderedSelectionRoot turns task markers into semantic checkboxes", () => {
  const editorDom = makeRoot(
    '<ul><li><span class="milkup-task-checkbox" aria-checked="true">✓</span>' +
      '<span class="milkup-list-marker">- [x] </span>done</li></ul>'
  );
  document.body.appendChild(editorDom);
  const range = document.createRange();
  range.selectNodeContents(editorDom);
  const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  const result = getRenderedSelectionRoot({ dom: editorDom });
  assert.equal(result?.querySelector("input[type=checkbox]")?.checked, true);
  assert.equal(result?.querySelector(".milkup-list-marker"), null);
  editorDom.remove();
});

test("getRenderedSelectionRoot falls back to ProseMirror DOM positions", () => {
  const editorDom = makeRoot("<p>one</p><p>two</p>");
  document.body.appendChild(editorDom);
  const selection = document.getSelection();
  selection.removeAllRanges();
  const collapsed = document.createRange();
  collapsed.setStart(editorDom, 0);
  collapsed.collapse(true);
  selection.addRange(collapsed);

  const result = getRenderedSelectionRoot({
    dom: editorDom,
    state: { selection: { empty: false, from: 1, to: 7 } },
    domAtPos(pos) {
      return { node: editorDom, offset: pos === 1 ? 0 : 2 };
    },
  });
  assert.equal(result?.textContent, "onetwo");
  editorDom.remove();
});

test("getRenderedSelectionRoot preserves the ProseMirror slice marker", () => {
  const editorDom = makeRoot("<p>text</p>");
  document.body.appendChild(editorDom);
  const range = document.createRange();
  range.selectNodeContents(editorDom);
  const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  const result = getRenderedSelectionRoot({
    dom: editorDom,
    state: { selection: { empty: false, content: () => ({}) } },
    serializeForClipboard: () => ({
      dom: makeRoot('<p data-pm-slice="0 1 []">text</p>'),
    }),
  });
  assert.equal(result?.getAttribute("data-pm-slice"), "0 1 []");
  assert.equal(result?.firstElementChild?.getAttribute("data-pm-slice"), "0 1 []");
  editorDom.remove();
});

test("getRenderedNodeRoot keeps the visible image element", () => {
  const imageNode = makeRoot(
    '<div class="milkup-image-block"><div class="milkup-image-preview"><img src="image.png" alt="图"></div></div>'
  );
  const result = getRenderedNodeRoot({ nodeDOM: () => imageNode }, 0);
  assert.equal(result?.querySelector("img")?.getAttribute("src"), "image.png");
});

test("buildClipboardPayload uses cached PNG as an SVG fallback", () => {
  const root = makeRoot(
    '<svg data-clipboard-png="data:image/png;base64,fallback"><path></path></svg>'
  );
  const payload = buildClipboardPayload("![图表](chart.svg)", root);
  const parsed = new window.DOMParser().parseFromString(payload.html, "text/html");

  assert.equal(parsed.querySelector("picture source")?.getAttribute("type"), "image/svg+xml");
  assert.equal(
    parsed.querySelector("picture img")?.getAttribute("src"),
    "data:image/png;base64,fallback"
  );
});

test("buildClipboardPayload keeps plain text only in source view", () => {
  const root = makeRoot('<p data-list-id="list-1">- item</p>');
  const payload = buildClipboardPayload("- item", root, { sourceView: true });

  assert.equal(payload.plain, "- item");
  assert.equal(payload.html, "");
});

test("buildCodeClipboardPayload creates a semantic pre/code fragment", () => {
  const payload = buildCodeClipboardPayload("const answer = 42");
  const parsed = new window.DOMParser().parseFromString(payload.html, "text/html");

  assert.equal(payload.plain, "const answer = 42");
  assert.equal(parsed.querySelector("pre code")?.textContent, "const answer = 42");
});

test("buildCodeClipboardPayload carries the current code style", () => {
  const payload = buildCodeClipboardPayload("const answer = 42", {
    codeStyle: "font-size: 20px; line-height: 1.6; white-space: pre;",
  });
  const parsed = new window.DOMParser().parseFromString(payload.html, "text/html");
  assert.equal(parsed.querySelector("pre")?.style.fontSize, "20px");
  assert.equal(parsed.querySelector("code")?.style.whiteSpace, "pre");
});

test("writeClipboardEvent writes both formats and prevents the default action", () => {
  const values = new Map();
  const event = {
    clipboardData: {
      clearData() {
        values.clear();
      },
      setData(type, value) {
        values.set(type, value);
      },
    },
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };

  const handled = writeClipboardEvent(event, { plain: "# Title", html: "<h1>Title</h1>" });

  assert.equal(handled, true);
  assert.equal(event.defaultPrevented, true);
  assert.equal(values.get("text/plain"), "# Title");
  assert.equal(values.get("text/html"), "<h1>Title</h1>");
});
