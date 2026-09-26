import test from "node:test";
import assert from "node:assert/strict";
import { ref } from "vue";
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
  assert.equal(
    controller.handleKeydown(
      { code: "Equal", key: "=", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true },
      false
    ),
    true
  );
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

test("keyboard shortcuts zoom the active tab via physical key codes", () => {
  const activeTab = ref(createTab());
  const controller = createEditorZoomController(activeTab);
  // Shift 让 +0 变成 ")"、+- 变成 "_"，只能靠物理键位 code 匹配
  const event = (overrides) => ({
    code: "Equal",
    key: "=",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: true,
    ...overrides,
  });

  assert.equal(controller.handleKeydown(event({ ctrlKey: true }), false), true);
  assert.equal(controller.zoomPercent.value, 110);
  assert.equal(
    controller.handleKeydown(event({ ctrlKey: true, code: "Equal", key: "+" }), false),
    true
  );
  assert.equal(controller.zoomPercent.value, 120);
  assert.equal(
    controller.handleKeydown(event({ ctrlKey: true, code: "Minus", key: "-" }), false),
    true
  );
  assert.equal(controller.zoomPercent.value, 110);
  assert.equal(
    controller.handleKeydown(event({ ctrlKey: true, code: "Digit0", key: ")" }), false),
    true
  );
  assert.equal(controller.zoomPercent.value, 100);

  // Mac 用 Cmd，Windows/Linux 用 Ctrl
  assert.equal(controller.handleKeydown(event({ ctrlKey: true }), true), false);
  assert.equal(controller.zoomPercent.value, 100);
  assert.equal(controller.handleKeydown(event({ metaKey: true }), true), true);
  assert.equal(controller.zoomPercent.value, 110);
  assert.equal(controller.handleKeydown(event({ metaKey: true, code: "Digit0" }), true), true);
  assert.equal(controller.zoomPercent.value, 100);

  // 不带 Shift 的 Ctrl+0 属于「设为段落」，不抢；Alt 和其他键也不抢
  assert.equal(
    controller.handleKeydown(
      event({ ctrlKey: true, code: "Digit0", key: "0", shiftKey: false }),
      false
    ),
    false
  );
  assert.equal(
    controller.handleKeydown(event({ ctrlKey: true, code: "Equal", shiftKey: false }), false),
    false
  );
  assert.equal(controller.handleKeydown(event({ ctrlKey: true, altKey: true }), false), false);
  assert.equal(controller.handleKeydown(event({ ctrlKey: true, code: "KeyB" }), false), false);
  assert.equal(controller.zoomPercent.value, 100);
});

test("缩放快捷键不占用「设为段落」的 Ctrl+0", () => {
  // 上游把 Mod-0 给了「设为段落」，缩放让开到 Mod-Shift-0
  const setParagraph = DEFAULT_SHORTCUTS.find((s) => s.id === "setParagraph");
  assert.equal(setParagraph?.defaultKey, "Mod-0");
  assert.equal(
    DEFAULT_SHORTCUTS.some((s) => s.defaultKey === "Mod-Shift-0"),
    false
  );
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
