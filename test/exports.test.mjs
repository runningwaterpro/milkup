import test from "node:test";
import assert from "node:assert/strict";

import {
  EXPORT_OMIT_PROPERTIES,
  isEditorChrome,
  serializeComputedStyle,
} from "../src/renderer/utils/exports.ts";

/** 复刻 CSSStyleDeclaration 迭代行为，只暴露给定的属性名 */
function fakeComputed(entries) {
  const names = Object.keys(entries);
  const map = { ...entries };
  return {
    length: names.length,
    getPropertyValue: (key) => map[key] ?? "",
    [Symbol.iterator]: function* () {
      yield* names;
    },
  };
}

test("导出内联样式跳过会固化窗口宽度的属性", () => {
  const computed = fakeComputed({
    width: "350px",
    height: "1200px",
    "min-width": "0px",
    "max-width": "800px",
    position: "relative",
    top: "4px",
    left: "20px",
    right: "0px",
    bottom: "auto",
    overflow: "hidden",
    float: "left",
    clear: "both",
    transform: "none",
  });

  const css = serializeComputedStyle(computed);
  const written = new Set(
    css
      .split(";")
      .filter(Boolean)
      .map((d) => d.slice(0, d.indexOf(":")))
  );

  for (const key of EXPORT_OMIT_PROPERTIES) {
    assert.equal(written.has(key), false, `不应写入 ${key}`);
  }
  assert.equal(written.has("max-width"), true, "max-width 是设计意图，应保留");
});

test("导出内联样式保留视觉属性", () => {
  const computed = fakeComputed({
    color: "rgb(0, 0, 0)",
    "font-size": "16px",
    "font-weight": "700",
    "line-height": "24px",
    "background-color": "rgb(240, 240, 240)",
    "border-top-width": "1px",
    "text-align": "center",
    padding: "10px 20px",
  });

  const css = serializeComputedStyle(computed);

  for (const key of Object.keys({
    color: 1,
    "font-size": 1,
    "font-weight": 1,
    "line-height": 1,
    "background-color": 1,
    "border-top-width": 1,
    "text-align": 1,
    padding: 1,
  })) {
    assert.equal(css.includes(`${key}:`), true, `应保留 ${key}`);
  }
});

test("导出内联样式跳过无意义的默认值", () => {
  const computed = fakeComputed({
    "background-image": "none",
    "border-top-style": "none",
    "font-style": "normal",
    "list-style-type": "none",
    outline: "0px",
    "text-decoration-line": "none",
    content: "normal",
  });

  assert.equal(serializeComputedStyle(computed), "");
});

test("编辑器 UI 元素被识别，不会进入导出", () => {
  for (const cls of [
    "milkup-code-block-copy-btn",
    "milkup-code-block-header",
    "milkup-custom-select",
    "milkup-context-menu",
    "milkup-link-tooltip",
    "milkup-search-panel",
  ]) {
    assert.equal(isEditorChrome(cls), true, `${cls} 应识别为编辑器 UI`);
  }
});

test("文档内容元素不会被误剔除", () => {
  // 这些在 Markdown 源码里有对应物，剔掉会丢内容
  for (const cls of [
    "milkup-editor",
    "milkup-container",
    "milkup-code-block",
    "milkup-task-checkbox",
    "milkup-list-marker",
    "milkup-syntax-marker",
    "milkup-blockquote-alert-icon",
  ]) {
    assert.equal(isEditorChrome(cls), false, `${cls} 是内容，不应被剔除`);
  }
});
