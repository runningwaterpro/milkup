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
    controller.handleKeydown({ key: "=", ctrlKey: true, metaKey: false, altKey: false }, false),
    true
  );
  const wheel = createWheel({ ctrlKey: true });
  assert.equal(controller.handleWheel(wheel.event, 2_000), false);
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

test("keyboard shortcuts zoom the active tab with platform modifiers", () => {
  const activeTab = ref(createTab());
  const controller = createEditorZoomController(activeTab);
  const event = (overrides) => ({
    key: "=",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...overrides,
  });

  assert.equal(controller.handleKeydown(event({ ctrlKey: true }), false), true);
  assert.equal(controller.zoomPercent.value, 110);
  assert.equal(controller.handleKeydown(event({ key: "+", ctrlKey: true }), false), true);
  assert.equal(controller.zoomPercent.value, 120);
  assert.equal(controller.handleKeydown(event({ key: "-", ctrlKey: true }), false), true);
  assert.equal(controller.zoomPercent.value, 110);
  assert.equal(controller.handleKeydown(event({ key: "0", ctrlKey: true }), false), true);
  assert.equal(controller.zoomPercent.value, 100);

  // Mac 用 Cmd，Windows/Linux 用 Ctrl
  assert.equal(controller.handleKeydown(event({ key: "0", ctrlKey: true }), true), false);
  assert.equal(controller.handleKeydown(event({ key: "0", metaKey: true }), true), true);
  assert.equal(controller.zoomPercent.value, 100);
  // Alt 和无修饰键不抢
  assert.equal(
    controller.handleKeydown(event({ key: "=", altKey: true, ctrlKey: true }), false),
    false
  );
  assert.equal(controller.handleKeydown(event({ key: "=" }), false), false);
  assert.equal(controller.zoomPercent.value, 100);
});

test("a continuous modified-wheel gesture moves exactly one step", () => {
  const activeTab = ref(createTab());
  const controller = createEditorZoomController(activeTab);

  // 触控板捏合：2 秒内 40 个高频事件，全程只走一个档位
  let t = 1_000;
  for (let i = 0; i < 40; i += 1) {
    const wheel = createWheel({ ctrlKey: true });
    assert.equal(controller.handleWheel(wheel.event, t), true);
    // 页面缩放必须被拦掉，即使这次不调整倍率
    assert.equal(wheel.prevented, 1);
    assert.equal(wheel.stopped, 1);
    t += 50;
  }
  assert.equal(controller.zoomPercent.value, 110);

  // 静默超过一个空闲间隔后，下一次捏合重新算一次手势
  const next = createWheel({ ctrlKey: true });
  assert.equal(controller.handleWheel(next.event, t + 400), true);
  assert.equal(controller.zoomPercent.value, 120);
});

test("plain wheel scrolling is left alone", () => {
  const activeTab = ref(createTab());
  const controller = createEditorZoomController(activeTab);

  const plain = createWheel();
  assert.equal(controller.handleWheel(plain.event, 1_000), false);
  assert.equal(plain.prevented, 0);
  assert.equal(controller.zoomPercent.value, 100);

  // 反向滚轮缩小
  const zoomOutWheel = createWheel({ ctrlKey: true, deltaY: 1 });
  assert.equal(controller.handleWheel(zoomOutWheel.event, 1_400), true);
  assert.equal(controller.zoomPercent.value, 90);

  // deltaY 为 0 不处理
  const still = createWheel({ ctrlKey: true, deltaY: 0 });
  assert.equal(controller.handleWheel(still.event, 1_800), false);
  assert.equal(controller.zoomPercent.value, 90);
});

test("editor shortcuts reserve Ctrl+0 for zoom reset", () => {
  assert.equal(
    DEFAULT_SHORTCUTS.some((shortcut) => shortcut.defaultKey === "Mod-0"),
    false
  );
  assert.equal(
    DEFAULT_SHORTCUTS.find((shortcut) => shortcut.id === "setParagraph")?.defaultKey,
    "Mod-Shift-0"
  );
});
