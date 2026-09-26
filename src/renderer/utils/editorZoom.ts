import type { Ref } from "vue";
import type { Tab } from "@/types/tab";
import { computed } from "vue";

export const DEFAULT_ZOOM_PERCENT = 100;
export const MIN_ZOOM_PERCENT = 50;
export const MAX_ZOOM_PERCENT = 300;
export const ZOOM_STEP_PERCENT = 10;

/** 滚轮事件间隔超过这个时长就认为上一次手势已经结束 */
const WHEEL_GESTURE_IDLE_MS = 300;

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
  const canResetZoom = computed(
    () => hasActiveTab.value && zoomPercent.value !== DEFAULT_ZOOM_PERCENT
  );

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

  function handleKeydown(event: KeyboardEvent, isMac: boolean): boolean {
    const hasModifier = isMac ? event.metaKey : event.ctrlKey;
    if (!hasModifier || event.altKey) return false;

    if (event.key === "=" || event.key === "+") {
      zoomIn();
      return true;
    }
    if (event.key === "-") {
      zoomOut();
      return true;
    }
    if (event.key === "0") {
      resetZoom();
      return true;
    }
    return false;
  }

  let lastWheelAt = Number.NEGATIVE_INFINITY;
  let wheelGestureApplied = false;

  /**
   * Ctrl/Cmd + 滚轮。触控板一次捏合会产生一串高频事件，
   * 整串只走一个 10% 档位，静默 WHEEL_GESTURE_IDLE_MS 后才算下一次手势。
   */
  function handleWheel(event: WheelEvent, timestamp = Date.now()): boolean {
    if ((!event.ctrlKey && !event.metaKey) || !hasActiveTab.value || event.deltaY === 0) {
      return false;
    }

    // 即使这次手势不再调整倍率，也要拦掉浏览器/Electron 的页面缩放
    event.preventDefault();
    event.stopPropagation();

    const continuingGesture = timestamp - lastWheelAt < WHEEL_GESTURE_IDLE_MS;
    lastWheelAt = timestamp;
    if (continuingGesture && wheelGestureApplied) return true;
    wheelGestureApplied = true;

    if (event.deltaY < 0) zoomIn();
    else zoomOut();
    return true;
  }

  return {
    hasActiveTab,
    zoomPercent,
    contentStyleFor: getContentStyle,
    canZoomOut,
    canZoomIn,
    canResetZoom,
    zoomIn,
    zoomOut,
    resetZoom,
    handleKeydown,
    handleWheel,
  };
}
