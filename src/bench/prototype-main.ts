/* ============================================================================
 * PROTOTYPE / THROWAWAY — 启动性能基准「主进程侧」打点（阶段 2）。
 *
 * 存在的唯一理由：给 Issue #18 的启动基准提供进程起点、阶段时间戳、
 * 峰值内存采样、报告落盘和自动退出。本文件不做任何优化，也不改变启动行为。
 *
 * 关闭方式：不给 Electron 传 MILKUP_BENCH_RUN 环境变量时 BENCH.enabled 为
 * false，src/main/index.ts 里的每个调用点都直接 return。
 * 基准原型结束后整个 src/bench/ 目录连同 src 里的调用点一起删除。
 *
 * 阶段 2 新增：
 *   1. 时钟零点改成「操作系统报告的进程创建时刻」（Windows GetProcessTimes），
 *      t0（performance.timeOrigin + now − process.uptime()）降级为对照量，
 *      用来量化原来的系统性低估。
 *   2. 内存峰值同时记工作集和私有字节，并在三个里程碑各取一次快照。
 *   3. 支持 mode="activate"：走 activate 分支的「重启后启动」抽检。
 *   4. 支持 MILKUP_BENCH_NOSAMPLER=1 关掉内存采样器（量采样器本身的侵入代价）。
 * ==========================================================================*/

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { app, BrowserWindow, ipcMain, type BrowserWindow as BrowserWindowType } from "electron";

interface BenchConfig {
  runId: string;
  scenario: string;
  repeat: number;
  outFile: string;
  seed: Record<string, string> | null;
  launchedAt: number;
  profileDir: string | null;
  /** cold = 普通冷启动；activate = 冷启动后销毁窗口并 emit("activate")，量「重启后启动」 */
  mode?: "cold" | "activate";
  /** 额外用 WMI CIM 再取一次进程创建时刻做交叉校验 */
  clockCross?: boolean;
  /** 一次性 DevTools 网络探针（会扰动时序，只用于定性） */
  netProbe?: boolean;
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
const MODE = config?.mode === "activate" ? "activate" : "cold";

/** 绝对墙钟（ms，浮点），与渲染进程 prototype.ts 用同一个时钟 */
function wallNow(): number {
  return performance.timeOrigin + performance.now();
}

const marks: Record<string, number> = {};
const rendererMarks: Record<string, number> = {};
const rendererInfo: Record<string, unknown> = {};
const memorySamples: Array<{ t: number; totalKb: number; privateKb: number; processes: number }> = [];
let memoryPeak: MemoryPeak | null = null;
let memoryPeakPrivate: MemoryPeak | null = null;
let reported = false;
let memoryTimer: ReturnType<typeof setInterval> | null = null;
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

interface MemorySample {
  t: number;
  totalKb: number;
  privateKb: number;
  processes: number;
}
interface MemoryPeak extends MemorySample {
  breakdown: unknown;
}

/**
 * 进程起点（阶段 1 的口径，保留下来当对照）：
 * process.uptime() 在 Windows 上是 libuv 的 uv_uptime()，它取的是「本进程第一次
 * 调用 uv_uptime 的时刻」到现在的差，不是 CreateProcess 时刻。
 * 所以这个值必然晚于真实创建时刻，算出来的指标会系统性偏小。
 * 真实零点改用 readOsProcessCreationMs()。
 */
let t0UptimeEstimate = 0;
let processStartRaw: Record<string, number> = {};

/** 操作系统报告的进程创建时刻（epoch ms）。0 = 没读到。 */
let osCreateMs = 0;
let osCreateSource = "none";
let osCreateCimMs = 0;
let osCreateQueryMs = 0;

let interactiveSeen = false;

// ── 第二轮（activate 模式）状态 ─────────────────────────────────────────────
/** 当前是第几轮窗口。第 1 轮前缀空，第 2 轮主进程打点 m2-、渲染进程打点 r2- */
let round = 1;
const mainPrefix = () => (round === 1 ? "" : `m${round}-`);
const rendererPrefix = () => (round === 1 ? "" : `r${round}-`);
let restartStarted = false;
let restoredQuit: (() => void) | null = null;
/** 一次性网络探针的 debugger 句柄（只在 config.netProbe 时存在） */
let netProbeDbg: { sendCommand: (m: string) => Promise<any> } | null = null;
/** 每轮渲染进程交上来的 info 快照（interactive / raf / resources 都在里面） */
const roundInfo: Record<number, any> = {};

/* ============================================================================
 * 操作系统进程创建时刻
 * ==========================================================================*/

/**
 * 读 Windows 记录的进程创建时刻（GetProcessTimes 的 FILETIME）。
 * 必须在所有打点都结束之后调用（writeReport 里），因为它要起一个子进程，
 * 会和应用的启动争 CPU。进程创建时刻是常量，晚读不影响结果。
 */
function readOsProcessCreationMs(): number {
  const ps = [
    `$ErrorActionPreference='Stop';`,
    `$p=[System.Diagnostics.Process]::GetProcessById(${process.pid});`,
    `[DateTimeOffset]::new($p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()`,
  ].join(" ");
  const started = wallNow();
  const out = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf-8",
    windowsHide: true,
    timeout: 20_000,
  });
  osCreateQueryMs = Math.round(wallNow() - started);
  if (out.status !== 0 || !out.stdout) {
    osCreateSource = "failed:" + String(out.stderr || out.status).slice(0, 200);
    return 0;
  }
  const value = Number.parseInt(String(out.stdout).trim(), 10);
  if (!Number.isFinite(value) || value <= 0) {
    osCreateSource = "unparsable:" + String(out.stdout).slice(0, 200);
    return 0;
  }
  osCreateSource = "GetProcessTimes(Process.StartTime)";
  return value;
}

/** 第二个独立来源：WMI Win32_Process.CreationDate。慢，只在 clockCross 时跑。 */
function readOsProcessCreationMsCim(): number {
  const ps = [
    `$ErrorActionPreference='Stop';`,
    `$c=(Get-CimInstance Win32_Process -Filter "ProcessId=${process.pid}").CreationDate;`,
    `[int64](($c.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds)`,
  ].join(" ");
  const out = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf-8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (out.status !== 0 || !out.stdout) return 0;
  const value = Number.parseInt(String(out.stdout).trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/* ============================================================================
 * 报告
 * ==========================================================================*/

function metricBlock(zero: number, mp = "", rp = ""): Record<string, unknown> {
  const ms = (v: unknown): number | null =>
    typeof v === "number" ? Math.round((v - zero) * 100) / 100 : null;
  const pick = (...names: string[]): number | undefined => {
    for (const name of names) if (typeof rendererMarks[rp + name] === "number") return rendererMarks[rp + name];
    return undefined;
  };
  const pickMain = (...names: string[]): number | undefined => {
    for (const name of names) if (typeof marks[mp + name] === "number") return marks[mp + name];
    return undefined;
  };
  // 窗口可见 = ready-to-show：show 事件在 show:true 下不触发，paint 事件本机不触发
  const visible = pickMain("m-window-ready-to-show", "m-window-visible-at-construct");
  const interactive = pick("r-input-dispatched", "r-input-verified");
  const stable = pick("r-stable-ready");
  return {
    windowVisibleMs: ms(visible),
    windowVisibleSource:
      typeof marks[mp + "m-window-ready-to-show"] === "number" ? "ready-to-show" : "window-constructed",
    windowReadyToShowMs: ms(marks[mp + "m-window-ready-to-show"]),
    windowVisibleAtConstructMs: ms(marks[mp + "m-window-visible-at-construct"]),
    firstPaintMs: ms(marks[mp + "m-renderer-first-paint"]),
    interactiveMs: ms(interactive),
    interactiveVerified: (roundInfo[round === 1 ? 1 : 2]?.interactive as any)?.verified ?? null,
    stableReadyMs: ms(stable),
    stableReadyTasksDoneMs: ms(rendererMarks[rp + "r-stable-ready-tasks-done"]),
  };
}

/** 取「某一时刻之前的采样里的最大值」。入参是绝对墙钟。 */
function sampleBefore(absLimit: number, key: "totalKb" | "privateKb"): MemorySample | null {
  const limit = absLimit - t0UptimeEstimate;
  return memorySamples
    .filter((s) => s.t <= limit)
    .reduce<MemorySample | null>((best, s) => (best === null || s[key] > best[key] ? s : best), null);
}

function writeReport(reason: string): void {
  if (reported || !config) return;
  reported = true;
  stopMemorySampler();
  if (watchdogTimer) clearTimeout(watchdogTimer);
  if (restoredQuit) restoredQuit();
  void collectResourceTree().then(() => finishReport(reason));
}

/** 一次性取文档实际持有的资源树（只定性用） */
async function collectResourceTree(): Promise<void> {
  if (!netProbeDbg) return;
  try {
    const tree = await netProbeDbg.sendCommand("Page.getResourceTree");
    const frame = tree?.frameTree?.frame;
    const resources = frame?.resources ?? [];
    (rendererInfo as any).resourceTree = {
      frameUrl: frame?.url,
      // 每一项再去磁盘量一次真实字节，DevTools 不给 file:// 的体积
      entries: resources.map((r: any) => {
        const url = String(r.url);
        let bytes = 0;
        try {
          const filePath = path.normalize(decodeURIComponent(url.replace(/^file:\/\//i, "")));
          bytes = fs.statSync(filePath).size;
        } catch {
          /* 量不到就留 0（比如开发期的 public 路径） */
        }
        return { url: url.split("\\").pop(), type: r.type, bytes };
      }),
    };
  } catch (error) {
    (rendererInfo as any).netProbeError = String(error);
  } finally {
    netProbeDbg = null;
  }
}

function finishReport(reason: string): void {
  if (!config) return;

  // 全部打点结束之后再读进程创建时刻（起子进程会争 CPU）
  osCreateMs = readOsProcessCreationMs();
  if (config.clockCross) osCreateCimMs = readOsProcessCreationMsCim();

  const zeroFromCreate = osCreateMs > 0 ? osCreateMs : t0UptimeEstimate;
  const zeroLabel = osCreateMs > 0 ? "process-create" : "t0-uptime-estimate";
  const rel = (map: Record<string, number>, zero: number): Record<string, number | null> =>
    Object.fromEntries(
      Object.entries(map).map(([k, v]) => [k, Math.round((v - zero) * 100) / 100])
    );

  const interactiveAbs = (() => {
    for (const name of ["r-input-dispatched", "r-input-verified"]) {
      if (typeof rendererMarks[name] === "number") return rendererMarks[name];
    }
    return null;
  })();
  const stableAbs = typeof rendererMarks["r-stable-ready"] === "number" ? rendererMarks["r-stable-ready"] : null;
  const visibleAbs = (() => {
    for (const name of ["m-window-ready-to-show", "m-window-visible-at-construct"]) {
      if (typeof marks[name] === "number") return marks[name];
    }
    return null;
  })();

  (rendererInfo as any).metricAnchor = metricBlock(zeroFromCreate);
  (rendererInfo as any).metricAnchorFromT0 = metricBlock(t0UptimeEstimate);
  const activateAbs = marks["m2-activate-emitted"];
  (rendererInfo as any).metricAnchorRound2FromActivate =
    typeof activateAbs === "number" ? metricBlock(activateAbs, "m2-", "r2-") : null;

  // 先按里程碑切数据（此时采样点的 t 还是 t0 口径，sampleBefore 内部按 t0 比较），
  // 再把采样点统一换到正式口径（从进程创建算起）。
  const milestones = {
    note: "里程碑之前所有采样中的最大值（t 从进程创建算起）",
    atWindowVisible: visibleAbs == null ? null : sampleBefore(visibleAbs, "totalKb"),
    atInteractive: interactiveAbs == null ? null : sampleBefore(interactiveAbs, "totalKb"),
    atStableReady: stableAbs == null ? null : sampleBefore(stableAbs, "totalKb"),
    atInteractivePrivate:
      interactiveAbs == null ? null : sampleBefore(interactiveAbs, "privateKb"),
  };
  const toFromCreate = (s: MemorySample | null): MemorySample | null =>
    s ? { ...s, t: Math.round((s.t + t0UptimeEstimate - zeroFromCreate) * 100) / 100 } : null;
  memorySamples.forEach((s, i) => {
    memorySamples[i] = toFromCreate(s)!;
  });
  memoryPeak = toFromCreate(memoryPeak);
  memoryPeakPrivate = toFromCreate(memoryPeakPrivate);
  (rendererInfo as any).memoryMilestones = {
    note: milestones.note,
    atWindowVisible: toFromCreate(milestones.atWindowVisible),
    atInteractive: toFromCreate(milestones.atInteractive),
    atStableReady: toFromCreate(milestones.atStableReady),
    atInteractivePrivate: toFromCreate(milestones.atInteractivePrivate),
  };

  const payload = {
    prototype: "milkup-startup-bench",
    stage: 2,
    schema: 2,
    reason,
    mode: MODE,
    run: {
      runId: config.runId,
      scenario: config.scenario,
      repeat: config.repeat,
      launchedAt: config.launchedAt,
      profileDir: config.profileDir,
      seed: config.seed,
      pid: process.pid,
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
      // 报告里所有 *_FromCreateMs 的零点
      frame: zeroLabel,
      osCreateMs,
      osCreateSource,
      osCreateCimMs,
      osCreateCimDeltaMs: osCreateCimMs > 0 ? Math.round((osCreateCimMs - osCreateMs) * 100) / 100 : null,
      osCreateQueryMs,
      t0UptimeEstimate,
      processStartRaw,
      // 阶段 1 用的 t0 比真实创建时刻晚多少 = 三个指标被系统性低估了多少
      t0MinusOsCreateMs:
        osCreateMs > 0 ? Math.round((t0UptimeEstimate - osCreateMs) * 100) / 100 : null,
      launcherToOsCreateMs:
        osCreateMs > 0 ? Math.round((osCreateMs - config.launchedAt) * 100) / 100 : null,
      launcherToT0Ms: Math.round((t0UptimeEstimate - config.launchedAt) * 100) / 100,
      // 真实「进程创建 → 主进程 JS 开始执行」的引导时间（阶段 1 看不到这一段）
      bootstrapToMainModuleEvalMs:
        osCreateMs > 0 && typeof marks["m-main-module-eval"] === "number"
          ? Math.round((marks["m-main-module-eval"] - osCreateMs) * 100) / 100
          : null,
    },
    // 阶段 2 正式口径：全部从「操作系统进程创建时刻」算起
    marksMainFromCreateMs: rel(marks, zeroFromCreate),
    marksRendererFromCreateMs: rel(rendererMarks, zeroFromCreate),
    // 对照口径：阶段 1 的 t0
    marksMainFromT0Ms: rel(marks, t0UptimeEstimate),
    marksRendererFromT0Ms: rel(rendererMarks, t0UptimeEstimate),
    marksMainAbs: marks,
    marksRendererAbs: rendererMarks,
    rendererInfo,
    roundInfo,
    memory: {
      // 口径：app.getAppMetrics() 的 memory.workingSetSize（工作集，KB）与
      // memory.privateBytes（私有字节，KB），对所有 Electron 进程
      // （Browser / Tab / GPU / Utility）求和后取启动期最大值。
      sampleIntervalMs: 50,
      sampleCount: memorySamples.length,
      peak: memoryPeak,
      peakPrivate: memoryPeakPrivate,
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

/* ============================================================================
 * 内存采样
 * ==========================================================================*/

function startMemorySampler(): void {
  if (memoryTimer) return;
  if (process.env.MILKUP_BENCH_NOSAMPLER === "1") return; // 量采样器侵入代价时用
  const sample = () => {
    try {
      const metrics = app.getAppMetrics();
      let totalKb = 0;
      let privateKb = 0;
      for (const m of metrics) {
        totalKb += m.memory?.workingSetSize ?? 0;
        privateKb += m.memory?.privateBytes ?? 0;
      }
      const point: MemorySample = {
        t: Math.round((wallNow() - t0UptimeEstimate) * 100) / 100,
        totalKb,
        privateKb,
        processes: metrics.length,
      };
      memorySamples.push(point);
      const breakdown = metrics.map((m) => ({
        type: m.type,
        pid: m.pid,
        workingSetKb: m.memory?.workingSetSize ?? 0,
        privateBytesKb: m.memory?.privateBytes ?? 0,
        peakWorkingSetKb: m.memory?.peakWorkingSetSize ?? 0,
      }));
      if (!memoryPeak || totalKb > memoryPeak.totalKb) memoryPeak = { ...point, breakdown };
      if (!memoryPeakPrivate || privateKb > memoryPeakPrivate.privateKb) {
        memoryPeakPrivate = { ...point, breakdown };
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

/* ============================================================================
 * activate 模式：走 activate 分支的「重启后启动」抽检
 * ==========================================================================*/

/**
 * Windows 上销毁唯一窗口会触发 window-all-closed → app.quit()，
 * 所以「进程还在、窗口全没了」这个状态在 Windows 上默认活不下来。
 * 为了能真正走到 activate 分支，这里在重启窗口期内临时把 app.quit 变成空操作，
 * activate 触发完新窗口建好之后再恢复。
 * 这个替换只影响「合成重启」那几百毫秒的销毁动作，不触碰冷启动路径。
 */
function startRestartProbe(): void {
  if (restartStarted) return;
  restartStarted = true;

  const appAny = app as any;
  const realQuit = appAny.quit.bind(app);
  appAny.quit = () => {
    /* 重启抽检期间挂起退出 */
  };
  restoredQuit = () => {
    appAny.quit = realQuit;
    restoredQuit = null;
  };

  // destroy() 是同步的：返回后 getAllWindows() 里已经没有这个窗口
  for (const w of BrowserWindow.getAllWindows()) w.destroy();
  marks["m2-window-destroyed"] = wallNow();
  round = 2;
  marks["m2-activate-emitted"] = wallNow();
  app.emit("activate");

  // createWindow() 里的 new BrowserWindow 一执行 getAllWindows() 就非空了，
  // 那时就可以把 app.quit 放回去（activate 分支本身不会触发 window-all-closed）
  const restore = setInterval(() => {
    if (BrowserWindow.getAllWindows().length > 0) {
      clearInterval(restore);
      if (restoredQuit) restoredQuit();
    }
  }, 10);
}

/* ============================================================================
 * 对外接口
 * ==========================================================================*/

export const BENCH = {
  get enabled() {
    return config !== null;
  },

  /** 主进程模块最顶上调用一次：估算进程起点、装 IPC、看门狗 */
  boot(): void {
    if (!config) return;

    // ===== PROTOTYPE BENCH (阶段 2：让被遮挡的窗口照样产帧) =====
    // 基准是从控制台里拉起来的，控制台窗口会盖住 Electron 窗口。Windows 上窗口被
    // 判定为遮挡时 Chromium 停产帧：ready-to-show 不触发、requestAnimationFrame 不回调，
    // 「窗口可见」和「稳定就绪」两个指标会直接失真（实测 1.72s vs 真实 1.34s）。
    // 这三个开关只在基准模式生效，等于声明「测量时窗口是可见的、在出帧的」。
    // 代价：本基线不覆盖「窗口被完全遮住」这种真实但非目标的使用状态。
    if (!process.env.MILKUP_BENCH_NO_FRAME_FIX) {
      app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
      app.commandLine.appendSwitch("disable-renderer-backgrounding");
      app.commandLine.appendSwitch("disable-features", "CalculateNativeWindowOcclusion");
    }
    // ===== /PROTOTYPE BENCH =====

    const uptimeAtBoot = process.uptime() * 1000;
    const wallMinusUptime = wallNow() - uptimeAtBoot;
    t0UptimeEstimate = wallMinusUptime;
    processStartRaw = {
      wallMinusUptime: Math.round(wallMinusUptime * 1000) / 1000,
      uptimeAtBoot: Math.round(uptimeAtBoot * 1000) / 1000,
      // 第二次调 uptime 只为确认它是单调的
      uptimeAgainMs: Math.round(process.uptime() * 100000) / 100,
    };

    marks["m-main-module-eval"] = wallNow();

    let lastSession = 0;
    ipcMain.on("bench:prototype-mark", (_event, payload: any) => {
      if (!payload) return;
      // 渲染进程每次换文档 performance.timeOrigin 都会变，用它当轮次标识
      if (typeof payload.session === "number" && payload.session !== lastSession) {
        lastSession = payload.session;
        rendererInfo["session"] = payload.session;
      }
      if (payload.marks) {
        const prefix = rendererPrefix();
        for (const [k, v] of Object.entries(payload.marks)) {
          if (typeof v === "number") rendererMarks[prefix + k] = v;
        }
      }
      if (payload.info) Object.assign(rendererInfo, payload.info);

      if (!interactiveSeen && typeof rendererMarks["r-input-verified"] === "number") {
        interactiveSeen = true;
        marks["m-observed-interactive"] = wallNow();
      }

      if (payload.done) {
        roundInfo[round] = payload.info;
        if (MODE === "activate" && round === 1) {
          // 第 1 轮结束不写报告，先把窗口销毁并走 activate 分支量第 2 轮
          marks["m1-finished"] = wallNow();
          startRestartProbe();
        } else {
          writeReport("renderer-done");
        }
      }
    });

    watchdogTimer = setTimeout(() => writeReport("watchdog-timeout"), 120_000);
  },

  /** 打一个主进程阶段点 */
  mark(name: string): void {
    if (!config) return;
    marks[mainPrefix() + name] = wallNow();
  },

  /** 窗口建好之后调用，挂首帧 / 可见 / loadFile 等钩子 */
  trackWindow(win: BrowserWindowType): void {
    if (!config) return;
    const p = mainPrefix();
    marks[p + "m-window-created"] = wallNow();
    // show:true 是构造参数，窗口在构造函数返回时就已经可见，show 事件不会再触发。
    // 所以「首次可见」只能用 ready-to-show（渲染进程已经出了第一帧）来近似。
    marks[p + "m-window-visible-at-construct"] = win.isVisible() ? wallNow() : 0;

    // ===== PROTOTYPE BENCH (阶段 2：把窗口顶到最前，否则测量机会遮挡它) =====
    // 测量进程是一个控制台应用，它的窗口会盖住 Electron 窗口。Windows 上窗口被完全
    // 遮挡时 Chromium 停产帧：ready-to-show 不触发、requestAnimationFrame 不回调，
    // 「稳定就绪」这种需要走两帧的指标会被 setTimeout 兜底撑大几百毫秒。
    // setAlwaysOnTop 只是让窗口不被遮挡，代价为 0，且只在基准模式里生效。
    try {
      win.setAlwaysOnTop(true, "floating");
      win.show();
      win.focus();
      marks[p + "m-bench-ontop"] = wallNow();
    } catch (error) {
      (rendererInfo as any).ontopError = String(error);
    }
    // ===== /PROTOTYPE BENCH =====

    // 这两个事件在本机（Electron 37 / Windows）实测不触发，保留只是留证据
    win.once("show", () => {
      marks[p + "m-window-shown"] = wallNow();
    });
    win.once("ready-to-show", () => {
      marks[p + "m-window-ready-to-show"] = wallNow();
      marks[p + "m-window-visible-at-ready-to-show"] = win.isVisible() ? wallNow() : 0;
      if (MODE === "activate") {
        try {
          win.setAlwaysOnTop(true, "floating");
        } catch {
          /* 忽略 */
        }
      }
    });
    win.webContents.once("paint", () => {
      marks[p + "m-renderer-first-paint"] = wallNow();
    });
    win.webContents.once("did-finish-load", () => {
      marks[p + "m-did-finish-load"] = wallNow();
    });
  },

  /**
   * 一次性网络探针（只开不开由 config.netProbe 决定，绝不在正式测量里开）。
   * 用来回答「首屏那 2.026MB 的 theme-main chunk 到底是不是真的被首屏加载了」。
   * 注意两点：
   *   1. Network 域不上报 file:// 的 ES module 加载（实测只报得出 index.html 和一张样式表），
   *      所以改用 Page.getResourceTree 一次性查询文档实际持有的资源树。
   *   2. debugger 一旦 attach 就会改变时序，所以只能用于定性，不能用于计时。
   */
  async startNetProbe(win: BrowserWindowType): Promise<void> {
    if (!config || !config.netProbe) return;
    try {
      const dbg = win.webContents.debugger;
      if (dbg.isAttached()) dbg.detach();
      dbg.attach("1.3");
      await dbg.sendCommand("Network.enable");
      netProbeDbg = dbg;
    } catch (error) {
      (rendererInfo as any).netProbeError = String(error);
    }
  },

  startMemorySampler(): void {
    if (!config) return;
    startMemorySampler();
  },
};
