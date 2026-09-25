<script setup lang="ts">
import { computed, ref } from "vue";
import AppIcon from "@/renderer/components/ui/AppIcon.vue";
import { toggleShowOutline } from "@/renderer/hooks/useOutline";
import useEditorZoom from "@/renderer/hooks/useEditorZoom";
import useSourceCode from "@/renderer/hooks/useSourceCode";

const props = defineProps<{
  content: string;
  updateStatus?: "idle" | "downloading" | "downloaded" | "error";
  downloadProgress?: number;
  isUpdateDialogVisible?: boolean;
}>();
const emit = defineEmits<{
  (e: "restore-update"): void;
}>();

const { isShowSource, toggleSourceCode } = useSourceCode();
const { zoomPercent, canZoomOut, canZoomIn, canResetZoom, zoomOut, resetZoom, zoomIn } =
  useEditorZoom();
const mode = ref<"chars" | "lines">("chars");

const displayText = computed(() => {
  const text = props.content ?? "";
  switch (mode.value) {
    case "chars":
      return `${countMarkdownChars(text)} 字符`;
    case "lines":
      return `${countMarkdownLines(text)} 行`;
    default:
      return "";
  }
});

function handleRestore() {
  emit("restore-update");
}

function cycleMode() {
  if (mode.value === "chars") mode.value = "lines";
  else if (mode.value === "lines") mode.value = "chars";
}
function countMarkdownLines(text: string, options = { skipEmpty: true }): number {
  if (!text) return 0;
  const rawLines = text.split(/\n{2,}|<br\s*\/?>| {2}\n/g);
  if (options.skipEmpty) {
    return rawLines.filter((line) => line.trim().length > 0).length;
  }
  return rawLines.length;
}
function countMarkdownChars(text: string): number {
  const base64Regex = /data:image\/[a-zA-Z]+;base64,[a-zA-Z0-9+/=]+/g;
  return (text.replaceAll("&#x20;", "").replace(base64Regex, "image").trim() || "").split("")
    .length;
}
window.electronAPI.on("view:toggleView", () => {
  toggleSourceCode();
});
</script>

<template>
  <div class="StatusBarBox">
    <div class="left-section">
      <div>
        <span class="status-icon-btn" @click="toggleShowOutline()">
          <AppIcon name="List-outlined" />
        </span>
        <span class="status-icon-btn" @click.stop="toggleSourceCode()">
          <AppIcon :name="isShowSource ? 'input' : 'markdown'" />
        </span>
      </div>

      <!-- Update Progress (Centered-ish or just after icons) -->
      <div
        v-if="updateStatus === 'downloading' && !isUpdateDialogVisible"
        class="update-progress-bar"
        @click="handleRestore"
        title="点击恢复下载弹窗"
      >
        <AppIcon name="download" class="status-inline-icon" />
        <span>正在下载 {{ downloadProgress }}%</span>
        <div class="mini-progress-bg">
          <div class="mini-progress-fill" :style="{ width: `${downloadProgress}%` }"></div>
        </div>
      </div>
      <div
        v-else-if="updateStatus === 'downloaded' && !isUpdateDialogVisible"
        class="update-progress-bar success"
        @click="handleRestore"
      >
        <AppIcon name="check-circle" class="status-inline-icon" />
        <span>下载完成，点击安装</span>
      </div>
    </div>

    <div class="right-section">
      <span class="statusBarText" @click="cycleMode">{{ displayText }}</span>
      <div class="zoomControls" role="group" aria-label="编辑视图缩放">
        <button
          type="button"
          aria-label="缩小编辑区"
          title="缩小编辑区"
          :disabled="!canZoomOut"
          @click="zoomOut"
        >
          −
        </button>
        <button
          type="button"
          class="zoomValue"
          :aria-label="`编辑区缩放 ${zoomPercent}%，点击还原`"
          :title="`编辑区缩放 ${zoomPercent}%，点击还原`"
          :disabled="!canResetZoom"
          @click="resetZoom"
        >
          {{ zoomPercent }}%
        </button>
        <button
          type="button"
          aria-label="放大编辑区"
          title="放大编辑区"
          :disabled="!canZoomIn"
          @click="zoomIn"
        >
          +
        </button>
      </div>
    </div>
  </div>
</template>

<style lang="less" scoped>
.StatusBarBox {
  user-select: none;
  cursor: pointer;
  font-size: 14px;
  color: var(--text-color-1);
  text-align: right;
  background: var(--background-color-2);
  display: flex;
  justify-content: space-between;
  align-items: center;

  .left-section {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  span {
    padding: 2px 8px;
    display: inline-block;

    &:hover {
      background: var(--hover-color);
    }
  }
}

.right-section {
  display: flex;
  align-items: center;
  gap: 8px;
}

.zoomControls {
  display: inline-flex;
  align-items: center;
  gap: 2px;

  button {
    min-width: 24px;
    height: 22px;
    padding: 0 6px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    font: inherit;
    line-height: 1;
    cursor: pointer;

    &:hover:not(:disabled) {
      background: var(--hover-color);
    }

    &:disabled {
      opacity: 0.4;
      cursor: default;
    }
  }

  .zoomValue {
    min-width: 48px;
    color: var(--text-color-3);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
}

.statusBarText {
  font-size: 12px;
  margin: 2px 0;
  color: var(--text-color-3);
}

.update-progress-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-color-2);
  padding: 2px 8px;
  border-radius: 4px;
  transition: background 0.2s;

  &:hover {
    background: var(--hover-color);
  }

  &.success {
    color: var(--primary-color);
  }

  .mini-progress-bg {
    width: 60px;
    height: 4px;
    background: var(--border-color-1);
    border-radius: 2px;
    overflow: hidden;
  }

  .mini-progress-fill {
    height: 100%;
    background: var(--primary-color);
    transition: width 0.3s;
  }
}
</style>
