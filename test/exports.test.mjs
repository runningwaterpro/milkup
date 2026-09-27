import test from "node:test";
import assert from "node:assert/strict";

import {
  EXPORT_OMIT_MIRRORED_SIZE,
  EXPORT_OMIT_PROPERTIES,
  isEditorChrome,
  isMirroredWidth,
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

function writtenKeys(css) {
  return new Set(
    css
      .split(";")
      .filter(Boolean)
      .map((d) => d.slice(0, d.indexOf(":")))
  );
}

test("导出内联样式跳过会固化窗口布局的属性", () => {
  const computed = fakeComputed({
    position: "relative",
    top: "4px",
    left: "20px",
    right: "0px",
    bottom: "auto",
    overflow: "hidden",
    "overflow-x": "auto",
    float: "left",
    clear: "both",
    zoom: "3",
  });

  const keys = writtenKeys(serializeComputedStyle(computed));

  for (const key of EXPORT_OMIT_PROPERTIES) {
    assert.equal(keys.has(key), false, `不应写入 ${key}`);
  }
});

test("逻辑属性别名也必须跳过，否则物理属性剥了等于没剥", () => {
  // Chromium 的计算样式同时给出物理属性和逻辑属性，作用完全相同。
  // 只剥 width 而留下 inline-size，宽度照样被焊死 —— 这个 bug 真实发生过。
  const computed = fakeComputed({
    width: "350px",
    "inline-size": "350px",
    "min-width": "0px",
    "min-inline-size": "0px",
    "max-width": "800px",
  });

  const keys = writtenKeys(serializeComputedStyle(computed, true));

  for (const key of EXPORT_OMIT_MIRRORED_SIZE) {
    assert.equal(keys.has(key), false, `不应写入 ${key}`);
  }
  assert.equal(keys.has("max-width"), true, "max-width 是设计意图，应保留");
});

test("宽度是刻意设定时保留，勾选框不会塌成 0 宽", () => {
  // 任务列表勾选框 width: 16px，引用图标 width: 1.1em，都小于容器宽度，
  // 属于刻意尺寸。isMirroredWidth 为 false 时必须原样写入。
  const computed = fakeComputed({
    width: "16px",
    "inline-size": "16px",
    "min-width": "16px",
    "min-inline-size": "16px",
    height: "16px",
  });

  const keys = writtenKeys(serializeComputedStyle(computed, false));

  for (const key of EXPORT_OMIT_MIRRORED_SIZE) {
    assert.equal(keys.has(key), true, `应保留 ${key}`);
  }
  assert.equal(keys.has("height"), true, "高度不是这次的修复目标，应保留");
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

/**
 * getComputedStyle 是全局的，没有 DOM 环境，只能临时替换。
 * 替换必须覆盖整个断言过程，所以包在回调里。
 */
function withStubbedLayout(elements, run) {
  const original = globalThis.getComputedStyle;
  const byElement = new Map(elements.map((el) => [el, el.__computed]));
  globalThis.getComputedStyle = (el) => byElement.get(el) ?? {};
  try {
    return run();
  } finally {
    if (original === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = original;
  }
}

/** 造一个只有 isMirroredWidth 会用到的接口的假元素 */
function fakeElement({ width, padding = {}, margin = {}, parent = null }) {
  return {
    parentElement: parent,
    getBoundingClientRect: () => ({ width }),
    __computed: {
      paddingLeft: padding.left ?? "0px",
      paddingRight: padding.right ?? "0px",
      marginLeft: margin.left ?? "0px",
      marginRight: margin.right ?? "0px",
    },
  };
}

test("宽度等于父容器内容宽度时判定为镜像，应当丢弃", () => {
  // 编辑器容器 350px，父级 padding 左右各 20px → 内容宽 310px
  const parent = fakeElement({ width: 350, padding: { left: "20px", right: "20px" } });
  const child = fakeElement({ width: 310, margin: { left: "0px", right: "0px" }, parent });

  withStubbedLayout([parent, child], () => {
    assert.equal(isMirroredWidth(child), true, "撑满父容器的宽度是布局结果，不是设计");
  });
});

test("元素自带 padding 时仍判定为镜像", () => {
  // blockquote 外边距盒 310px、内容盒 270px。只比内容盒会漏判，
  // 实测下 blockquote 的宽度会被焊死在 310px。
  const parent = fakeElement({ width: 350, padding: { left: "20px", right: "20px" } });
  const quote = fakeElement({
    width: 310,
    padding: { left: "20px", right: "20px" },
    parent,
  });

  withStubbedLayout([parent, quote], () => {
    assert.equal(isMirroredWidth(quote), true, "按外边距盒比较才能识别撑满容器的元素");
  });
});

test("带外边距时按外边距盒比较", () => {
  const parent = fakeElement({ width: 350, padding: { left: "0px", right: "0px" } });
  const child = fakeElement({ width: 300, margin: { left: "25px", right: "25px" }, parent });

  withStubbedLayout([parent, child], () => {
    assert.equal(isMirroredWidth(child), true, "300 + 25 + 25 = 350，仍是撑满容器");
  });
});

test("宽度小于父容器时判定为刻意尺寸，应当保留", () => {
  const parent = fakeElement({ width: 350, padding: { left: "20px", right: "20px" } });
  const checkbox = fakeElement({ width: 16, parent });

  withStubbedLayout([parent, checkbox], () => {
    assert.equal(isMirroredWidth(checkbox), false, "勾选框的 16px 是设计意图");
  });
});

test("没有父元素时保守判定为刻意尺寸", () => {
  const orphan = fakeElement({ width: 800 });

  withStubbedLayout([orphan], () => {
    assert.equal(isMirroredWidth(orphan), false, "无法比较时保留宽度，不会造成内容丢失");
  });
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
