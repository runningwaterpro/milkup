import test from "node:test";
import assert from "node:assert/strict";
import { ref } from "vue";
import { readFileSync } from "node:fs";
import { createEditorZoomController } from "../src/renderer/utils/editorZoom.ts";
import { DEFAULT_SHORTCUTS } from "../src/core/keymap/shortcut-registry.ts";

function createTab(overrides = {}) {
  return {
    id: "tab-1",
    name: "Note",
    filePath: null,
    content: "# Note",
    originalContent: "# Note",
    isModified: false,
    readOnly: false,
    zoomPercent: 100,
    ...overrides,
  };
}

function createWheel(overrides = {}) {
  let prevented = 0;
  let stopped = 0;
  return {
    event: {
      ctrlKey: false,
      metaKey: false,
      deltaY: -1,
      preventDefault: () => {
        prevented += 1;
      },
      stopPropagation: () => {
        stopped += 1;
      },
      ...overrides,
    },
    get prevented() {
      return prevented;
    },
    get stopped() {
      return stopped;
    },
  };
}

test("editor zoom starts at the 100% baseline", () => {
  const activeTab = ref(createTab());
  const controller = createEditorZoomController(activeTab);

  assert.equal(controller.zoomPercent.value, 100);
  assert.deepEqual(controller.contentStyleFor(activeTab.value), {
    "--editor-zoom-inverse": 1,
    zoom: 1,
  });
});

test("editor zoom changes in ten-percent steps and resets to 100%", () => {
  const activeTab = ref(createTab());
  const controller = createEditorZoomController(activeTab);

  controller.zoomIn();
  assert.equal(controller.zoomPercent.value, 110);
  // 辅助工具靠反向缩放保持固定尺寸
  assert.deepEqual(controller.contentStyleFor(activeTab.value), {
    "--editor-zoom-inverse": 1 / 1.1,
    zoom: 1.1,
  });

  controller.zoomOut();
  controller.zoomOut();
  assert.equal(controller.zoomPercent.value, 90);

  controller.resetZoom();
  assert.equal(controller.zoomPercent.value, 100);
});

test("editor zoom clamps to 50–300% and exposes action availability", () => {
  const activeTab = ref(createTab());
  const controller = createEditorZoomController(activeTab);

  for (let index = 0; index < 10; index += 1) controller.zoomOut();
  assert.equal(controller.zoomPercent.value, 50);
  assert.equal(controller.canZoomOut.value, false);
  assert.equal(controller.canZoomIn.value, true);

  for (let index = 0; index < 30; index += 1) controller.zoomIn();
  assert.equal(controller.zoomPercent.value, 300);
  assert.equal(controller.canZoomIn.value, false);
  assert.equal(controller.canZoomOut.value, true);
});

test("editor zoom stays isolated per tab without changing document state", () => {
  const firstTab = createTab({ id: "tab-1", filePath: "D:/notes/note.md" });
  const secondTab = createTab({
    id: "tab-2",
    name: "Other",
    content: "Other",
    originalContent: "Other",
  });
  const activeTab = ref(firstTab);
  const controller = createEditorZoomController(activeTab);
  const firstTabBeforeZoom = { ...firstTab };

  controller.zoomIn();
  assert.equal(firstTab.zoomPercent, 110);
  assert.equal(secondTab.zoomPercent, 100);
  // 缩放只写 zoomPercent，文档、路径、修改状态都不动
  assert.deepEqual(
    { ...firstTab, zoomPercent: firstTabBeforeZoom.zoomPercent },
    firstTabBeforeZoom
  );
  assert.deepEqual(controller.contentStyleFor(firstTab), {
    "--editor-zoom-inverse": 1 / 1.1,
    zoom: 1.1,
  });

  activeTab.value = secondTab;
  assert.equal(controller.zoomPercent.value, 100);

  activeTab.value = firstTab;
  assert.equal(controller.zoomPercent.value, 110);

  activeTab.value = null;
  controller.zoomIn();
  assert.equal(controller.hasActiveTab.value, false);
  assert.equal(controller.canZoomIn.value, false);
  assert.equal(firstTab.zoomPercent, 110);
  // 没有活动标签时快捷键不改变任何标签状态
  const controller2 = createEditorZoomController(activeTab, undefined, makeMatcher(false));
  assert.equal(controller2.handleKeydown({ key: ">", shiftKey: true, ctrlKey: true }), true);
  assert.equal(firstTab.zoomPercent, 110);
  const wheel = createWheel({ ctrlKey: true });
  assert.equal(controller.handleWheel(wheel.event), false);
  assert.equal(wheel.prevented, 0);
  assert.equal(firstTab.zoomPercent, 110);
});

test("read-only documents can be zoomed and stay read-only", () => {
  const tab = createTab({ readOnly: true });
  const controller = createEditorZoomController(ref(tab));

  controller.zoomIn();
  controller.zoomIn();

  assert.equal(tab.zoomPercent, 120);
  assert.equal(tab.readOnly, true);
  assert.equal(tab.isModified, false);
  assert.equal(tab.content, "# Note");
  assert.equal(tab.originalContent, "# Note");
});

// 复刻 useShortcutConfig.eventMatchesShortcutKey：主键比对前把 Shift 变体
// 归一化到基础键。Ctrl+Shift+0 时浏览器报 event.key = ")"，但用户存的是 "0"。
const SHIFTED_TO_BASE = {
  ")": "0",
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
};
const toBase = (k) => SHIFTED_TO_BASE[k] ?? k;

function makeMatcher(isMac) {
  return (event, binding) => {
    if (!binding) return false;
    const mods = binding.split("-").slice(0, -1);
    const main = binding.split("-").at(-1);
    const on = (flag) => Boolean(flag);
    if (mods.includes("Mod") !== (isMac ? on(event.metaKey) : on(event.ctrlKey))) return false;
    if (mods.includes("Shift") !== on(event.shiftKey)) return false;
    if (mods.includes("Alt") !== on(event.altKey)) return false;
    return toBase(main.toLowerCase()) === toBase(String(event.key).toLowerCase());
  };
}

test("keyboard shortcuts follow the configured bindings", () => {
  const activeTab = ref(createTab());
  const matches = makeMatcher(false);
  const controller = createEditorZoomController(activeTab, undefined, matches);

  // 默认绑定：放大 > (Period)、缩小 < (Comma)、还原 D (KeyD)
  assert.equal(controller.handleKeydown({ key: ">", shiftKey: true, ctrlKey: true }), true);
  assert.equal(controller.zoomPercent.value, 110);
  assert.equal(controller.handleKeydown({ key: "<", shiftKey: true, ctrlKey: true }), true);
  assert.equal(controller.zoomPercent.value, 100);
  assert.equal(controller.handleKeydown({ key: "D", shiftKey: true, ctrlKey: true }), true);
  assert.equal(controller.zoomPercent.value, 100);

  // 不带 Shift 的 Ctrl+0 属于「设为段落」，缩放不抢
  assert.equal(controller.handleKeydown({ key: "0", shiftKey: false, ctrlKey: true }), false);
  assert.equal(controller.handleKeydown({ key: "b", shiftKey: true, ctrlKey: true }), false);
  assert.equal(controller.zoomPercent.value, 100);
});

test("Mac 用 Cmd 而不是 Ctrl", () => {
  const activeTab = ref(createTab());
  const controller = createEditorZoomController(activeTab, undefined, makeMatcher(true));

  assert.equal(controller.handleKeydown({ key: ">", shiftKey: true, ctrlKey: true }), false);
  assert.equal(controller.zoomPercent.value, 100);
  assert.equal(controller.handleKeydown({ key: ">", shiftKey: true, metaKey: true }), true);
  assert.equal(controller.zoomPercent.value, 110);
});

test("缩放快捷键绑定在设置里可改，改完立即生效", () => {
  const activeTab = ref(createTab());
  let bindings = { zoomIn: "Mod-Shift->", zoomOut: "Mod-Shift-<", resetZoom: "Mod-Shift-d" };
  const matches = makeMatcher(false);
  const controller = createEditorZoomController(activeTab, () => bindings, matches);

  bindings = { ...bindings, zoomIn: "Alt-p" };
  assert.equal(controller.handleKeydown({ key: ">", shiftKey: true, ctrlKey: true }), false);
  assert.equal(controller.zoomPercent.value, 100);
  assert.equal(controller.handleKeydown({ key: "p", altKey: true }), true);
  assert.equal(controller.zoomPercent.value, 110);

  // Shift 变体与基础键可互相匹配：存 "0" 也能匹配 Ctrl+Shift+0（此时 event.key 是 ")"）
  bindings = { ...bindings, resetZoom: "Mod-Shift-0" };
  controller.zoomIn();
  assert.equal(controller.zoomPercent.value, 120);
  assert.equal(controller.handleKeydown({ key: ")", shiftKey: true, ctrlKey: true }), true);
  assert.equal(controller.zoomPercent.value, 100);
});

test("缩放快捷键不占用「设为段落」的 Ctrl+0，也不撞分割线", () => {
  const byId = (id) => DEFAULT_SHORTCUTS.find((s) => s.id === id)?.defaultKey;
  // 「设为段落」保留上游的 Mod-0
  assert.equal(byId("setParagraph"), "Mod-0");
  // 分割线保留上游的 Mod-Shift-minus
  assert.equal(byId("insertHorizontalRule"), "Mod-Shift-minus");
  // 缩放三条用 Period / Comma / Digit0，都不与上面两条相同
  assert.equal(byId("zoomIn"), "Mod-Shift->");
  assert.equal(byId("zoomOut"), "Mod-Shift-<");
  assert.equal(byId("resetZoom"), "Mod-Shift-d");
  // action-commands.ts 只按 id 赋值，没有这三条 → commandMap 里取不到
  // → dynamic-keymap 的 `if (command && boundKey)` 会跳过，不会进 keymap
  const source = readFileSync(
    new URL("../src/core/keymap/action-commands.ts", import.meta.url),
    "utf8"
  );
  for (const id of ["zoomIn", "zoomOut", "resetZoom"]) {
    assert.equal(source.includes(`.${id} =`), false, `${id} 不应有 ProseMirror command`);
  }
});

test("modified wheel zooms linearly by accumulated scroll delta", () => {
  const activeTab = ref(createTab());
  const controller = createEditorZoomController(activeTab);

  // 触控板小增量：累积不够一整格就不动，避免瞬间跳到边界
  for (let i = 0; i < 9; i += 1) {
    const w = createWheel({ ctrlKey: true, deltaY: -10 });
    assert.equal(controller.handleWheel(w.event), true);
    // 每一帧都必须拦住 Chromium 的整页缩放
    assert.equal(w.prevented, 1);
    assert.equal(w.stopped, 1);
  }
  assert.equal(controller.zoomPercent.value, 100);

  // 累积到一整格（100）就走一档
  const tenth = createWheel({ ctrlKey: true, deltaY: -10 });
  assert.equal(controller.handleWheel(tenth.event), true);
  assert.equal(controller.zoomPercent.value, 110);

  // 持续滚动持续缩放，没有停顿感
  for (let i = 0; i < 5; i += 1) {
    controller.handleWheel(createWheel({ ctrlKey: true, deltaY: -100 }).event);
  }
  assert.equal(controller.zoomPercent.value, 160);

  // 一次大增量直接跨多档
  const big = createWheel({ ctrlKey: true, deltaY: -250 });
  assert.equal(controller.handleWheel(big.event), true);
  assert.equal(controller.zoomPercent.value, 180);

  // 反向滚动立刻生效，不被上一步的余量拖住
  const down = createWheel({ ctrlKey: true, deltaY: 100 });
  assert.equal(controller.handleWheel(down.event), true);
  assert.equal(controller.zoomPercent.value, 170);

  // 未到反向一整格前不动作
  for (let i = 0; i < 5; i += 1) {
    controller.handleWheel(createWheel({ ctrlKey: true, deltaY: 10 }).event);
  }
  assert.equal(controller.zoomPercent.value, 170);
  controller.handleWheel(createWheel({ ctrlKey: true, deltaY: 50 }).event);
  assert.equal(controller.zoomPercent.value, 160);
});

test("plain wheel scrolling is left alone", () => {
  const activeTab = ref(createTab());
  const controller = createEditorZoomController(activeTab);

  const plain = createWheel();
  assert.equal(controller.handleWheel(plain.event), false);
  assert.equal(plain.prevented, 0);
  assert.equal(controller.zoomPercent.value, 100);

  const still = createWheel({ ctrlKey: true, deltaY: 0 });
  assert.equal(controller.handleWheel(still.event), false);
  assert.equal(controller.zoomPercent.value, 100);
});
