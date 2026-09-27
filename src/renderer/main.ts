// ===== PROTOTYPE BENCH (Issue #18 启动基准, throwaway, 用完连同 src/bench 一起删) =====
// 必须是第一个 import：ESM 按顺序求值，这样 r-module-eval 才约等于「渲染进程开始执行 JS」。
// 另外它在 createApp 之前把基准场景写进 localStorage。
import { benchMark } from "@/bench/prototype";
// ===== /PROTOTYPE BENCH =====
import "../../lang/index.js";
import { createApp } from "vue";
import { directives } from "@/directives";
import App from "./App.vue";
import "./style.less";
import "@/themes/theme-main.less";
import "vditor/src/assets/less/index.less";

const app = createApp(App);

Object.entries(directives).forEach(([name, directive]) => {
  app.directive(name, directive);
});

benchMark("r-before-mount"); // PROTOTYPE BENCH
app.mount("#app");
benchMark("r-after-mount"); // PROTOTYPE BENCH
