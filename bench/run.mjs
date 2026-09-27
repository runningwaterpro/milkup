/* ============================================================================
 * PROTOTYPE / THROWAWAY — Milkup 启动性能基准驱动（Issue #18 阶段 1）。
 *
 * 一条命令：cmd /c "pnpm bench:startup"
 *
 * 做的事：
 *   1. 检查生产构建产物存在（dist/index.html + dist-electron/main/index.js）
 *   2. 按场景 × 重复次数冷启动打包后的 Electron
 *   3. 每次启动前确认「本应用的进程已完全退出」，不误杀别的 Electron 应用
 *   4. 应用自己把时间戳、峰值内存写成 JSON 到临时目录，然后 app.quit()
 *   5. 打印每个场景的完整阶段拆解 + 汇总 P50/P95 + 首屏体积
 *
 * 明确不做的事：不优化、不改启动行为、不加测试、不持久化。
 * ==========================================================================*/

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { printAssetsReport } from "./assets-size.mjs";
import { BENCH_TMP_ROOT, PROFILE_DIR, PRIMARY_SCENARIO_ID, SCENARIOS, ensureFixtures, getScenario } from "./scenarios.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const MAIN_JS = path.join(repoRoot, "dist-electron", "main", "index.js");
const RUNS_DIR = path.join(BENCH_TMP_ROOT, "runs");

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { scenarios: null, repeat: null, warmup: 1, timeout: 120_000, gap: 1200 };
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "scenarios") out.scenarios = value.split(",").map((s) => s.trim()).filter(Boolean);
    else if (key === "repeat") out.repeat = Number(value);
    else if (key === "warmup") out.warmup = Number(value);
    else if (key === "timeout") out.timeout = Number(value) * 1000;
    else if (key === "gap") out.gap = Number(value);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/** 默认：主场景跑 20 次，其余次要场景跑 5 次 */
function repeatFor(scenario) {
  if (args.repeat != null) return args.repeat;
  return scenario.id === PRIMARY_SCENARIO_ID ? 20 : 5;
}

const smokeMode = process.argv.includes("--smoke");

// ── 环境自检 ────────────────────────────────────────────────────────────────

function fail(message) {
  console.error(`\n[bench] ${message}\n`);
  process.exit(1);
}

function preflight() {
  if (!fs.existsSync(MAIN_JS)) {
    fail(`找不到 ${MAIN_JS}\n请先跑：cmd /c "pnpm build"（必须测生产构建，不许用 pnpm dev）`);
  }
  if (!fs.existsSync(path.join(repoRoot, "dist", "index.html"))) {
    fail("找不到 dist/index.html，请先跑：cmd /c \"pnpm build\"");
  }
  // 单实例锁：已有实例在跑时，新进程会立刻退出，测出来是假的
  const alive = findLiveAppPids();
  if (alive.length > 0) {
    fail(
      `检测到本应用还有进程在跑（PID ${alive.join(", ")}）。\n` +
        "单实例锁会让新的启动立刻退出，必须先完全退出应用再测。"
    );
  }
}

function electronBinary() {
  const pnpmDir = path.join(repoRoot, "node_modules", ".pnpm");
  const candidates = fs
    .readdirSync(pnpmDir)
    .filter((d) => d.startsWith("electron@"))
    .map((d) => path.join(pnpmDir, d, "node_modules", "electron", "dist", "electron.exe"));
  const hit = candidates.find((c) => fs.existsSync(c));
  if (!hit) fail("找不到 electron 可执行文件（node_modules/.pnpm/electron@*/…/electron.exe）");
  return hit;
}

/**
 * 只找「命令行里带我们这个 dist-electron/main/index.js」的 electron 进程。
 * 这样不会把 VSCode 等其它 Electron 应用算进来。
 */
function findLiveAppPids() {
  const psScript =
    "$needle = " +
    JSON.stringify(MAIN_JS) +
    "; Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | " +
    "Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) } | " +
    "ForEach-Object { $_.ProcessId }";
  const ps = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
    encoding: "utf-8",
    windowsHide: true,
  });
  if (ps.status !== 0 || !ps.stdout) return [];
  return ps.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map(Number);
}

function terminateAppPids(pids) {
  for (const pid of pids) {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      /* 忽略 */
    }
  }
}

// ── 单次冷启动 ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs, stepMs = 40) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

async function runOnce({ scenario, repeat, warmup, timeout, electron }) {
  const runId = `${scenario.id}-r${String(repeat).padStart(2, "0")}${warmup ? "-warm" : ""}-${Date.now()}`;
  const outFile = path.join(RUNS_DIR, `${runId}.json`);
  const fixtures = ensureFixtures();
  const seed = scenario.seed(fixtures);
  const launchFile = scenario.openFile(fixtures);

  // 冷启动前置条件：本应用进程必须一个都不剩（不按进程名 kill，只按命令行匹配本应用）
  const pre = findLiveAppPids();
  if (pre.length > 0) {
    await waitFor(() => findLiveAppPids().length === 0, 8000);
    const still = findLiveAppPids();
    if (still.length > 0) {
      terminateAppPids(still);
      await waitFor(() => findLiveAppPids().length === 0, 8000);
    }
  }

  const launchedAt = performance.timeOrigin + performance.now();
  const child = spawn(
    electron,
    [
      MAIN_JS,
      `--user-data-dir=${PROFILE_DIR}`,
      ...(launchFile ? [launchFile] : []),
    ],
    {
      cwd: repoRoot,
      windowsHide: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        MILKUP_BENCH_RUN: JSON.stringify({
          runId,
          scenario: scenario.id,
          repeat,
          outFile,
          seed,
          launchedAt,
          profileDir: PROFILE_DIR,
        }),
        MILKUP_BENCH_SEED: seed ? JSON.stringify({ "milkup-config": seed }) : "",
        ELECTRON_ENABLE_LOGGING: "0",
      },
    }
  );

  const logs = [];
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));

  let exited = false;
  const exitPromise = new Promise((resolve) => {
    child.on("exit", (code) => {
      exited = true;
      resolve(code);
    });
  });

  const gotFile = await waitFor(() => fs.existsSync(outFile) && fs.statSync(outFile).size > 0, timeout);
  let report = null;
  if (gotFile) {
    try {
      report = JSON.parse(fs.readFileSync(outFile, "utf-8"));
    } catch (error) {
      report = { parseError: String(error) };
    }
  }

  // 应用没自己退出（例如看门狗先触发）也要收场
  if (!exited) {
    await sleep(3000);
    if (!exited) {
      const pids = findLiveAppPids();
      if (pids.length > 0) terminateAppPids(pids);
    }
  }
  await Promise.race([exitPromise, sleep(8000)]);

  // 确认进程真的全没了，否则下一轮不是冷启动
  const exitedCleanly = await waitFor(() => findLiveAppPids().length === 0, 15_000, 120);
  if (!exitedCleanly) {
    terminateAppPids(findLiveAppPids());
    await waitFor(() => findLiveAppPids().length === 0, 5000, 120);
  }

  return {
    runId,
    scenario,
    repeat,
    warmup,
    outFile,
    gotFile,
    exitedCleanly,
    report,
    logs: logs.join("").slice(-4000),
  };
}

// ── 打印 ───────────────────────────────────────────────────────────────────

const MAIN_STAGE_ROWS = [
  ["m-main-module-eval", "主进程 JS 开始执行"],
  ["m-app-ready", "app.whenReady 触发（Electron/Chromium 初始化完成）"],
  ["m-ipc-registered", "IPC 处理器注册完成"],
  ["m-window-created", "BrowserWindow 构造完成"],
  ["m-window-visible-at-construct", "构造返回时窗口已可见"],
  ["m-page-load-start", "开始 loadFile(index.html)"],
  ["m-window-ready-to-show", "窗口 ready-to-show（渲染进程已出第一帧）"],
  ["m-window-visible-at-ready-to-show", "ready-to-show 时窗口仍可见"],
  ["m-window-shown", "（本机不触发）窗口 show 事件"],
  ["m-renderer-first-paint", "（本机不触发）渲染进程 paint"],
  ["m-did-finish-load", "did-finish-load"],
  ["m-page-load-end", "loadFile 返回"],
  ["m-window-maximized", "maximize() 返回"],
  ["m-renderer-ready-ipc", "渲染进程发 renderer-ready"],
  ["m-launch-file-dispatched", "命令行文件已派发给渲染进程"],
];

const RENDERER_STAGE_ROWS = [
  ["r-seed-applied", "基准场景写入 localStorage"],
  ["r-module-eval", "渲染进程 JS 开始求值（第一个 import）"],
  ["r-before-mount", "createApp() 之前"],
  ["r-after-mount", "app.mount() 返回"],
  ["r-app-mounted", "App.vue onMounted"],
  ["r-theme-applied", "主题应用完成"],
  ["r-other-config-applied", "编辑器内边距配置完成"],
  ["r-spellcheck-applied", "拼写检查配置完成"],
  ["r-editor-instance-created", "Milkup 编辑器实例创建完成"],
  ["r-editor-first-frame", "编辑器内容进了一帧后的 DOM"],
  ["r-workspace-watch-started", "工作区目录监听已启动"],
  ["r-workspace-resolved", "工作区扫描完成"],
  ["r-fonts-resolved", "系统字体枚举完成（getFonts 返回）"],
  ["r-probe-begin", "开始派发可交互探测输入"],
  ["r-input-dispatched", "★ 可交互时间点：输入已进编辑管线"],
  ["r-input-verified", "可交互已确认（文档模型真的变了）"],
  ["r-stable-ready-tasks-done", "启动期后台任务全完成（不等帧）"],
  ["r-stable-ready", "★ 稳定就绪：字体/主题/工作区/启动期后台任务全完成"],
  ["r-finish", "渲染进程交出数据"],
];

function fmt(v) {
  if (v == null) return "     —";
  return (v >= 1000 ? (v / 1000).toFixed(2) + "s" : v.toFixed(0) + "ms").padStart(9);
}

function printRun(run) {
  const r = run.report;
  const tag = run.warmup ? "WARMUP" : `run ${run.repeat}`;
  console.log("");
  console.log(`── ${run.scenario.title} / ${tag} ──────────────────────────────────`);
  if (!r || !r.marksMainMs) {
    console.log(`  !! 没拿到数据：report=${r ? JSON.stringify(r).slice(0, 400) : "null"}`);
    if (run.logs) console.log("  ---- 应用 stderr/stdout 尾部 ----\n" + run.logs);
    return;
  }
  const mm = r.marksMainMs;
  const rm = r.marksRendererMs;
  console.log("  阶段".padEnd(44) + "主进程".padStart(10) + "渲染进程".padStart(10));
  for (const [key, label] of MAIN_STAGE_ROWS) {
    if (mm[key] == null && rm[key] == null) continue;
    console.log("  " + label.padEnd(42) + fmt(mm[key]) + fmt(rm[key]));
  }
  for (const [key, label] of RENDERER_STAGE_ROWS) {
    if (rm[key] == null) continue;
    console.log("  " + label.padEnd(42) + "".padStart(10) + fmt(rm[key]));
  }
  // 没有落在固定表里的补充点也打出来，避免信息丢失
  const known = new Set([...MAIN_STAGE_ROWS, ...RENDERER_STAGE_ROWS].map(([k]) => k));
  const extra = [
    ...Object.entries(mm).filter(([k]) => !known.has(k)),
    ...Object.entries(rm).filter(([k]) => !known.has(k)),
  ];
  for (const [k, v] of extra) console.log("  (其他) " + k.padEnd(44) + fmt(v));

  const anchor = r.rendererInfo?.metricAnchor ?? {};
  const interactiveDetail = r.rendererInfo?.interactive ?? {};
  const raf = r.rendererInfo?.raf ?? {};
  console.log("  " + "-".repeat(62));
  console.log("  指标".padEnd(20) + "值".padStart(11) + "  说明");
  console.log("  窗口可见时间".padEnd(18) + fmt(anchor.windowVisibleMs) + "   口径=" + (anchor.windowVisibleSource ?? "?"));
  console.log(
    "  稳定就绪时间".padEnd(18) + fmt(anchor.stableReadyMs) + "   字体/主题/工作区/后台任务全完成"
  );
  console.log(
    "  可交互时间".padEnd(18) +
      fmt(anchor.interactiveMs) +
      "   输入已进管线并回读确认" +
      (anchor.interactiveVerified ? "" : "  ⚠ 未确认")
  );
  console.log(
    "    └ 交互验证".padEnd(16) +
      `${interactiveDetail.attempts ?? "?"} 次尝试`.padStart(11) +
      "   docHasMarker=" +
      interactiveDetail.docHasMarker +
      " mdHasMarker=" +
      interactiveDetail.mdHasMarker +
      " focus=" +
      interactiveDetail.hasFocus +
      " vis=" +
      interactiveDetail.visibilityState
  );
  console.log(
    "    └ 帧健康度".padEnd(16) +
      `${raf.callbacks ?? "?"} 帧`.padStart(11) +
      `   rAF 回调 ${raf.callbacks ?? 0} 次 / 兜底超时 ${raf.timeouts ?? 0} 次` +
      (raf.healthy === false ? "  ⚠ rAF 被降级，帧边界不可信" : "")
  );
  const mem = r.memory;
  console.log(
    "  峰值内存".padEnd(20) +
      fmtPeak(mem?.peak?.totalKb).padStart(11) +
      `   工作集合计, 私有 ${fmtPeak(mem?.peak?.privateKb)}, ${mem?.peak?.processes ?? "?"} 进程, ${mem?.sampleCount ?? 0} 次采样`
  );
  if (mem?.peak?.breakdown) {
    for (const p of mem.peak.breakdown) {
      console.log(
        `      ${String(p.type).padEnd(10)} pid ${String(p.pid).padEnd(7)} 工作集 ${kb(p.workingSetKb).padStart(11)}  私有 ${kb(p.privateBytesKb).padStart(11)}`
      );
    }
  }
  console.log(
    "  时钟校验".padEnd(20) +
      `${String(r.clock?.launcherToProcessStartMs ?? "?").padStart(10)}ms   启动器打点 → 进程起点估算`
  );
  // 这一轮的诚实性信号：有任何一个异常，阶段 2 都不该收这条数据
  const flags = [];
  if (raf.healthy === false) flags.push("rAF 被降级（窗口被遮挡？）");
  if (interactiveDetail.visibilityState === "hidden") flags.push("探测时 document.visibilityState=hidden");
  if (anchor.windowVisibleSource === "window-constructed") flags.push("ready-to-show 未触发，窗口可见时间用兜底口径");
  if (anchor.stableReadyMs == null) flags.push("稳定就绪未收敛");
  if (r.rendererInfo?.stableReadyTimedOut) flags.push("稳定就绪靠 30s 超时兜底");
  if (flags.length > 0) console.log("  ⚠ 可疑信号：" + flags.join("；"));
  if (!run.exitedCleanly) console.log("  ⚠ 这一轮结束时进程没有干净退出（下一轮可能不是冷启动）");
  if (r.reason !== "renderer-done") console.log(`  ⚠ 报告原因：${r.reason}`);
}

function fmtPeak(kb) {
  if (kb == null) return "—";
  return (kb / 1024).toFixed(0) + "MB";
}
function kb(n) {
  return (n / 1024).toFixed(1) + "MB";
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

function summarize(results) {
  const byScenario = new Map();
  for (const r of results) {
    if (r.warmup) continue;
    if (!byScenario.has(r.scenario.id)) byScenario.set(r.scenario.id, []);
    byScenario.get(r.scenario.id).push(r);
  }
  console.log("");
  console.log("══ 汇总（去掉 warmup）══════════════════════════════════════════════════════");
  console.log(
    "  场景".padEnd(26) +
      "n".padStart(3) +
      "可交互 P50".padStart(12) +
      "P95".padStart(10) +
      "窗口可见 P50".padStart(13) +
      "稳定就绪 P50".padStart(13) +
      "峰值内存".padStart(11) +
      "  确认"
  );
  for (const s of SCENARIOS) {
    const runs = byScenario.get(s.id);
    if (!runs || runs.length === 0) continue;
    const pickOf = (key) => runs.map((r) => r.report?.rendererInfo?.metricAnchor?.[key]).filter((v) => typeof v === "number");
    const inter = pickOf("interactiveMs").sort((a, b) => a - b);
    const vis = pickOf("windowVisibleMs").sort((a, b) => a - b);
    const stable = pickOf("stableReadyMs").sort((a, b) => a - b);
    const peaks = runs.map((r) => r.report?.memory?.peak?.totalKb).filter((v) => typeof v === "number");
    const suspicious = runs.filter((r) => r.report?.rendererInfo?.raf?.healthy === false).length;
    const verified = runs.filter((r) => r.report?.rendererInfo?.metricAnchor?.interactiveVerified).length;
    console.log(
      "  " +
        s.title.padEnd(24) +
        String(runs.length).padStart(3) +
        fmt(percentile(inter, 50)).padStart(12) +
        fmt(percentile(inter, 95)).padStart(10) +
        fmt(percentile(vis, 50)).padStart(13) +
        fmt(percentile(stable, 50)).padStart(13) +
        fmtPeak(peaks.length ? Math.max(...peaks) : null).padStart(11) +
        `  ${verified}/${runs.length}` +
        (suspicious > 0 ? `  ⚠${suspicious} 帧降级` : "")
    );
  }
  console.log("");
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  Milkup 启动性能基准 PROTOTYPE（Issue #18 阶段 1，throwaway）           ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");
  console.log(`  临时产物目录  ${BENCH_TMP_ROOT}`);
  console.log(`  Electron      ${electronBinary()}`);
  console.log(`  基准模式      ${smokeMode ? "冒烟（每场景 1 次）" : "正式"}`);
  preflight();
  const fixtures = ensureFixtures();
  console.log(`  测试文档      ${fixtures.normalDoc}`);
  console.log(`                ${fixtures.largeDoc}`);
  console.log(`  工作区目录    ${fixtures.workspaceDir}`);
  console.log("");

  const selected = args.scenarios
    ? args.scenarios.map(getScenario)
    : SCENARIOS.filter((s) => s.id !== "wsl-workspace");

  const electron = electronBinary();
  const results = [];

  for (const scenario of selected) {
    const times = smokeMode ? 1 : repeatFor(scenario);
    for (let i = 0; i < args.warmup; i += 1) {
      const r = await runOnce({
        scenario,
        repeat: 0,
        warmup: true,
        timeout: args.timeout,
        electron,
      });
      printRun(r);
      results.push(r);
    }
    for (let t = 1; t <= times; t += 1) {
      const r = await runOnce({ scenario, repeat: t, warmup: false, timeout: args.timeout, electron });
      printRun(r);
      results.push(r);
      await sleep(args.gap);
    }
  }

  summarize(results);
  printAssetsReport();
  console.log("  原始 JSON：" + RUNS_DIR);
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
