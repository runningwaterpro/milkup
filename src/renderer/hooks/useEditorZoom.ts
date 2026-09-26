import { createEditorZoomController } from "@/renderer/utils/editorZoom";
import useTab from "./useTab";

let controller: ReturnType<typeof createEditorZoomController> | undefined;
let shortcutsInstalled = false;

export default function useEditorZoom() {
  if (!controller) controller = createEditorZoomController(useTab().currentTab);

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
  const isMac = window.electronAPI.platform === "darwin";
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.target instanceof Element && event.target.closest(".shortcut-page")) return;
      if (!zoom.handleKeydown(event, isMac)) return;

      event.preventDefault();
      event.stopPropagation();
    },
    true
  );
  shortcutsInstalled = true;
}
