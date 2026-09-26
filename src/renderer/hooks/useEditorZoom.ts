import {
  createEditorZoomController,
  DEFAULT_ZOOM_BINDINGS,
  type EditorZoomBindings,
} from "@/renderer/utils/editorZoom";
import useTab from "./useTab";
import { eventMatchesShortcutKey, useShortcutConfig } from "./useShortcutConfig";

let controller: ReturnType<typeof createEditorZoomController> | undefined;
let shortcutsInstalled = false;

export default function useEditorZoom() {
  if (!controller) {
    const { shortcuts } = useShortcutConfig();
    controller = createEditorZoomController(
      useTab().currentTab,
      () => {
        const key = (id: keyof EditorZoomBindings) =>
          shortcuts.value.find((s) => s.id === id)?.key ?? "";
        return {
          zoomIn: key("zoomIn") || DEFAULT_ZOOM_BINDINGS.zoomIn,
          zoomOut: key("zoomOut") || DEFAULT_ZOOM_BINDINGS.zoomOut,
          resetZoom: key("resetZoom") || DEFAULT_ZOOM_BINDINGS.resetZoom,
        };
      },
      eventMatchesShortcutKey
    );
  }

  return controller;
}

/**
 * 注册编辑区缩放快捷键。只应由状态栏调用：
 * 状态栏只存在于主编辑器窗口，主题编辑器窗口渲染的是
 * ThemeEditor 预览，不应该响应缩放快捷键。
 */
export function installEditorZoomShortcuts() {
  if (shortcutsInstalled) return;

  const zoom = useEditorZoom();
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.target instanceof Element && event.target.closest(".shortcut-page")) return;
      if (!zoom.handleKeydown(event)) return;

      event.preventDefault();
      event.stopPropagation();
    },
    true
  );
  shortcutsInstalled = true;
}
