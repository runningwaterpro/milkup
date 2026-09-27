/* ============================================================================
 * PROTOTYPE / THROWAWAY — 启动性能基准「主进程侧」打点。
 *
 * 存在的唯一理由：给 Issue #18 的启动基准提供进程起点、阶段时间戳、
 * 峰值内存采样、报告落盘和自动退出。本文件不做任何优化，也不改变启动行为。
 *
 * 关闭方式：不给 Electron 传 MILKUP_BENCH_RUN 环境变量时 BENCH.enabled 为
 * false，src/main/index.ts 里的每个调用点都直接 return。
 * 基准原型结束后整个 src/bench/ 目录连同 src 里的调用点一起删除。
 * ==========================================================================*/

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { app, ipcMain, type BrowserWindow } from "electron";

interface BenchConfig {
  runId: string;
  scenario: string;
  repeat: number;
  outFile: string;
  seed: Record<string, string> | null;
  launchedAt: number;
  profileDir: string | null;
}

function readConfig(): BenchConfig | null {
  const raw = process.env.MILKUP_BENCH_RUN;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BenchConfig;
  } catch (error) {
    console.error("[bench] 解析 MILKUP_BENCH_RUN 失败", error);
    return null;
  }
}

const config = readConfig();

/** 绝对墙钟（ms，浮点），与渲染进程 prototype.ts 用同一个时钟 */
function wallNow(): number {
  return performance.timeOrigin + performance.now();
}

const marks: Record<string, number> = {};
const rendererMarks: Record<string, number> = {};
const rendererInfo: Record<string, unknown> = {};
const memorySamples: Array<{ t: number; totalKb: number; processes: number }> = [];
let memoryPeak: { t: number; totalKb: number; processes: number; breakdown: unknown } | null = null;
let reported = false;
let memoryTimer: ReturnType<typeof setInterval> | null = null;
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 进程起点估算：Node 的 process.uptime() 是单调时钟，从进程开始执行算起；
 * 用墙钟减去它，得到「进程创建时刻」的近似值。
 * 误差来源：Electron 从 CreateProcess 到执行入口脚本之间还有 Chromium/Node
 * 引导，这段时间不计入 uptime()，所以这个值会略晚于真实创建时刻。
 */
let processStartEstimate = 0;
let processStartRaw = { wallMinusUptime: 0, dateMinusUptime: 0, uptimeAtBoot: 0 };

let interactiveSeen = false;

function writeReport(reason: string): void {
  if (reported || !config) return;
  reported = true;
  stopMemorySampler();
  if (watchdogTimer) clearTimeout(watchdogTimer);
  BENCH.metrics();

  const t0 = processStartEstimate;
  const toMs = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? Math.round((value - t0) * 100) / 100 : null;

  const payload = {
    prototype: "milkup-startup-bench",
    stage: 1,
    schema: 1,
    reason,
    run: {
      runId: config.runId,
      scenario: config.scenario,
      repeat: config.repeat,
      launchedAt: config.launchedAt,
      profileDir: config.profileDir,
      seed: config.seed,
      userDataPath: app.getPath("userData"),
      argv: process.argv,
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        v8: process.versions.v8,
        platform: `${process.platform} ${process.arch} os${os.release()}`,
        cpus: os.cpus().length,
        totalMemMb: Math.round((os.totalmem() / 1024 / 1024) * 10) / 10,
      },
    },
    clock: {
      processStartEstimate: t0,
      processStartRaw,
      // 启动器打点时刻 → 进程起点估算，两者差值是「CreateProcess 前的开销 + 引导误差」
      launcherToProcessStartMs: Math.round((t0 - config.launchedAt) * 100) / 100,
    },
    marksMainMs: Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, toMs(v)])),
    marksRendererMs: Object.fromEntries(Object.entries(rendererMarks).map(([k, v]) => [k, toMs(v)])),
    marksMainAbs: marks,
    marksRendererAbs: rendererMarks,
    rendererInfo,
    memory: {
      // 口径：app.getAppMetrics() 的 memory.workingSetSize（工作集，KB），
      // 对所有 Electron 进程（主 / 渲染 / GPU / utility）求和后取启动期最大值。
      sampleIntervalMs: 50,
      sampleCount: memorySamples.length,
      peak: memoryPeak,
      samples: memorySamples,
    },
  };

  try {
    fs.mkdirSync(path.dirname(config.outFile), { recursive: true });
    fs.writeFileSync(config.outFile, JSON.stringify(payload, null, 2), "utf-8");
  } catch (error) {
    console.error("[bench] 报告落盘失败", error);
  }

  setTimeout(() => app.quit(), 30);
}

function startMemorySampler(): void {
  if (memoryTimer) return;
  const sample = () => {
    try {
      const metrics = app.getAppMetrics();
      let totalKb = 0;
      let privateKb = 0;
      for (const m of metrics) {
        totalKb += m.memory?.workingSetSize ?? 0;
        privateKb += m.memory?.privateBytes ?? 0;
      }
      const point = {
        t: Math.round((wallNow() - processStartEstimate) * 100) / 100,
        totalKb,
        privateKb,
        processes: metrics.length,
      };
      memorySamples.push(point);
      if (!memoryPeak || totalKb > memoryPeak.totalKb) {
        memoryPeak = {
          ...point,
          breakdown: metrics.map((m) => ({
            type: m.type,
            pid: m.pid,
            workingSetKb: m.memory?.workingSetSize ?? 0,
            privateBytesKb: m.memory?.privateBytes ?? 0,
            peakWorkingSetKb: m.memory?.peakWorkingSetSize ?? 0,
          })),
        };
      }
    } catch {
      /* 采样失败忽略 */
    }
  };
  sample();
  memoryTimer = setInterval(sample, 50);
}

function stopMemorySampler(): void {
  if (!memoryTimer) return;
  clearInterval(memoryTimer);
  memoryTimer = null;
}

function pick(marksMap: Record<string, number>, ...names: string[]): number | undefined {
  for (const name of names) {
    if (typeof marksMap[name] === "number") return marksMap[name];
  }
  return undefined;
}

export const BENCH = {
  get enabled() {
    return config !== null;
  },

  /** 主进程模块最顶上调用一次：估算进程起点、装 IPC、看门狗 */
  boot(): void {
    if (!config) return;

    const uptimeAtBoot = process.uptime() * 1000;
    const wallMinusUptime = wallNow() - uptimeAtBoot;
    const dateMinusUptime = Date.now() - uptimeAtBoot;
    processStartEstimate = wallMinusUptime;
    processStartRaw = {
      wallMinusUptime: Math.round(wallMinusUptime * 1000) / 1000,
      dateMinusUptime: Math.round(dateMinusUptime * 1000) / 1000,
      uptimeAtBoot: Math.round(uptimeAtBoot * 1000) / 1000,
    };

    marks["m-main-module-eval"] = wallNow();

    ipcMain.on("bench:prototype-mark", (_event, payload: any) => {
      if (!payload) return;
      if (payload.marks) Object.assign(rendererMarks, payload.marks);
      if (payload.info) Object.assign(rendererInfo, payload.info);

      if (!interactiveSeen && typeof rendererMarks["r-input-verified"] === "number") {
        interactiveSeen = true;
        marks["m-observed-interactive"] = wallNow();
      }

      if (payload.done) writeReport("renderer-done");
    });

    watchdogTimer = setTimeout(() => writeReport("watchdog-timeout"), 90_000);
  },

  /** 打一个主进程阶段点 */
  mark(name: string): void {
    if (!config) return;
    marks[name] = wallNow();
  },

  /** 窗口建好之后调用，挂首帧 / 可见 / loadFile 等钩子 */
  trackWindow(win: BrowserWindow): void {
    if (!config) return;
    marks["m-window-created"] = wallNow();
    // show:true 是构造参数，窗口在构造函数返回时就已经可见，show 事件不会再触发。
    // 所以「首次可见」只能用 ready-to-show（渲染进程已经出了第一帧）来近似。
    marks["m-window-visible-at-construct"] = win.isVisible() ? wallNow() : 0;
    // 这两个事件在本机（Electron 37 / Windows）实测不触发，保留只是留证据
    win.once("show", () => {
      marks["m-window-shown"] = wallNow();
    });
    win.once("ready-to-show", () => {
      marks["m-window-ready-to-show"] = wallNow();
      marks["m-window-visible-at-ready-to-show"] = win.isVisible() ? wallNow() : 0;
    });
    win.webContents.once("paint", () => {
      marks["m-renderer-first-paint"] = wallNow();
    });
    win.webContents.once("did-finish-load", () => {
      marks["m-did-finish-load"] = wallNow();
    });
  },

  startMemorySampler(): void {
    if (!config) return;
    startMemorySampler();
  },

  /** 汇总三个指标的时间戳（毫秒，相对进程起点） */
  metrics(): void {
    if (!config) return;
    const t0 = processStartEstimate;
    const ms = (v: unknown): number | null => (typeof v === "number" ? Math.round((v - t0) * 100) / 100 : null);
    // 窗口可见 = ready-to-show：show 事件在 show:true 下不触发，paint 事件本机不触发
    const visible = pick(marks, "m-window-ready-to-show", "m-window-visible-at-construct");
    const interactive = pick(rendererMarks, "r-input-dispatched", "r-input-verified");
    const stable = pick(rendererMarks, "r-stable-ready");

    const interactiveSample =
      typeof interactive === "number"
        ? memorySamples.filter((s) => s.t <= interactive).reduce<typeof memorySamples[number] | null>(
            (best, s) => (best === null || s.totalKb > best.totalKb ? s : best),
            null
          )
        : null;

    (rendererInfo as any).metricAnchor = {
      windowVisibleMs: ms(visible),
      // ready-to-show 不触发时（窗口被完全遮挡时 Chromium 停产帧）退回到「构造完成」
      windowVisibleSource:
        typeof marks["m-window-ready-to-show"] === "number" ? "ready-to-show" : "window-constructed",
      windowReadyToShowMs: ms(marks["m-window-ready-to-show"]),
      windowVisibleAtConstructMs: ms(marks["m-window-visible-at-construct"]),
      firstPaintMs: ms(marks["m-renderer-first-paint"]),
      interactiveMs: ms(interactive),
      stableReadyMs: ms(stable),
      stableReadyTasksDoneMs: ms(rendererMarks["r-stable-ready-tasks-done"]),
      interactiveVerified: (rendererInfo["interactive"] as any)?.verified ?? null,
      memoryAtInteractive: interactiveSample,
    };
  },
};
