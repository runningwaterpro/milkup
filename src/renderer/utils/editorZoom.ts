import type { Ref } from "vue";
import type { Tab } from "@/types/tab";
import { computed } from "vue";

export const DEFAULT_ZOOM_PERCENT = 100;
export const MIN_ZOOM_PERCENT = 50;
export const MAX_ZOOM_PERCENT = 300;
export const ZOOM_STEP_PERCENT = 10;

/** 累积到这个滚动量才走一档，约等于鼠标滚轮一格（DOM_DELTA_PIXEL） */
const WHEEL_STEP_DELTA = 100;

function getZoomPercent(tab: Tab | null | undefined): number {
  return tab?.zoomPercent ?? DEFAULT_ZOOM_PERCENT;
}

type EditorZoomStyle = { "--editor-zoom-inverse": number; zoom: number };

function getContentStyle(tab: Tab | null | undefined): EditorZoomStyle {
  const zoom = getZoomPercent(tab) / 100;
  // --editor-zoom-inverse 供编辑区内的辅助工具反向缩放，保持固定尺寸
  return { "--editor-zoom-inverse": 1 / zoom, zoom };
}

export function createEditorZoomController(activeTab: Readonly<Ref<Tab | null>>) {
  const hasActiveTab = computed(() => activeTab.value !== null);
  const zoomPercent = computed(() => getZoomPercent(activeTab.value));
  const canZoomOut = computed(() => hasActiveTab.value && zoomPercent.value > MIN_ZOOM_PERCENT);
  const canZoomIn = computed(() => hasActiveTab.value && zoomPercent.value < MAX_ZOOM_PERCENT);

  function setZoomPercent(value: number) {
    const tab = activeTab.value;
    if (!tab) return;

    tab.zoomPercent = Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, value));
  }

  function zoomIn() {
    setZoomPercent(zoomPercent.value + ZOOM_STEP_PERCENT);
  }

  function zoomOut() {
    setZoomPercent(zoomPercent.value - ZOOM_STEP_PERCENT);
  }

  function resetZoom() {
    setZoomPercent(DEFAULT_ZOOM_PERCENT);
  }

  /**
   * 匹配物理键位而不是 event.key。
   * Ctrl/Cmd + Shift + 0 产生的 key 是 ")"，+ Shift + - 产生的是 "_"，
   * 用 key 匹配不到用户实际按的键；code 不受 Shift 影响，也跨键盘布局稳定。
   */
  function handleKeydown(event: KeyboardEvent, isMac: boolean): boolean {
    const hasModifier = isMac ? event.metaKey : event.ctrlKey;
    if (!hasModifier || event.altKey || !event.shiftKey) return false;

    switch (event.code) {
      case "Equal":
        zoomIn();
        return true;
      case "Minus":
        zoomOut();
        return true;
      case "Digit0":
        resetZoom();
        return true;
      default:
        return false;
    }
  }

  let wheelAccumulator = 0;

  /**
   * Ctrl/Cmd + 滚轮，按累积滚动量线性缩放（和 Chrome / VS Code 一致）。
   * 触控板一次捏合会产生一串小 deltaY，累积量不够就不会动，
   * 不会因为高频事件瞬间跳到边界；持续滚动则持续缩放，没有停顿感。
   */
  function handleWheel(event: WheelEvent): boolean {
    if ((!event.ctrlKey && !event.metaKey) || !hasActiveTab.value || event.deltaY === 0) {
      return false;
    }

    // 拦掉 Chromium 的整页缩放
    event.preventDefault();
    event.stopPropagation();

    // 反向滚动时清空累积量，否则要先滚过反向的余量才响应，反馈迟钝
    if (wheelAccumulator !== 0 && Math.sign(event.deltaY) !== Math.sign(wheelAccumulator)) {
      wheelAccumulator = 0;
    }
    wheelAccumulator += event.deltaY;
    const steps = Math.trunc(wheelAccumulator / WHEEL_STEP_DELTA);
    if (steps === 0) return true;

    wheelAccumulator -= steps * WHEEL_STEP_DELTA;
    for (let i = 0; i < Math.abs(steps); i += 1) {
      if (steps > 0) zoomOut();
      else zoomIn();
    }
    return true;
  }

  return {
    hasActiveTab,
    zoomPercent,
    contentStyleFor: getContentStyle,
    canZoomOut,
    canZoomIn,
    zoomIn,
    zoomOut,
    resetZoom,
    handleKeydown,
    handleWheel,
  };
}
