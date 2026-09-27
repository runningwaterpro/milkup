/* ============================================================================
 * PROTOTYPE / THROWAWAY — 启动基准的离线分析（Issue #18 阶段 2）。
 *
 * 从 %TEMP%\milkup-bench-PROTOTYPE\runs\<label>\*.json 里算出报告要用的数：
 *   1. 阶段拆解：每段耗时的中位数（跨全部轮次）+ 中位轮次的完整时间线
 *   2. 编辑器核心占比（ADR 0001 第 7 条的 30% 门槛）
 *   3. 峰值内存：逐进程拆解 + 可交互时刻的取值
 *   4. 时钟：t0 偏晚量、引导时间
 *   5. 两次构建的对比
 *
 * 用法：node bench/analyze.mjs build1,build2 [场景id]
 * ==========================================================================*/

import * as fs from "node:fs";
import * as path from "node:path";
import { BENCH_TMP_ROOT, SCENARIOS } from "./scenarios.mjs";

/** 主指标 / 次指标从哪来，报告里要说明，这里只认 rendererInfo.metricAnchor */
const METRICS = [
  ["interactiveMs", "可交互"],
  ["windowVisibleMs", "窗口可见"],
  ["stableReadyMs", "稳定就绪"],
];

function loadRuns(label) {
  const dir = path.join(BENCH_TMP_ROOT, "runs", label);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "summary.json")
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      } catch {
        return null;
      }
    })
    .filter(
      (r) =>
        r && r.run && !String(r.run.runId ?? "").includes("-warm") && r.rendererInfo?.metricAnchor
    );
}

function percentile(values, p) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  if (v.length === 1) return v[0];
  const rank = (p / 100) * (v.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (rank - lo);
}
const med = (values) => percentile(values, 50);
const r1 = (n) => (typeof n === "number" ? Math.round(n * 10) / 10 : n);

const fmt = (v) =>
  v == null ? "—" : v >= 1000 ? (v / 1000).toFixed(2) + "s" : Math.round(v) + "ms";

/** 把一轮的 marks 变成「有序打点流水」（主进程和渲染进程按时间混排） */
function timelineOf(run) {
  const main = Object.entries(run.marksMainFromCreateMs ?? {});
  const rend = Object.entries(run.marksRendererFromCreateMs ?? {});
  return [
    ...main.map(([k, v]) => ({ k, t: v, side: "主" })),
    ...rend.map(([k, v]) => ({ k, t: v, side: "渲" })),
  ]
    .filter((x) => typeof x.t === "number")
    .sort((a, b) => a.t - b.t);
}

/** 从 events 流水里切出每一次编辑器内核构造的耗时（启动期会建两次：空文档 + 真文档） */
function coreSegments(run) {
  const events = (run.rendererInfo?.events ?? []).filter((e) => typeof e.t === "number");
  const abs = Object.values(run.marksRendererAbs ?? {});
  const base = Math.min(...abs);
  const rel = (e) => e.t - base;
  const segs = [];
  for (let i = 0; i < events.length; i += 1) {
    if (events[i].name !== "r-core-ctor-begin") continue;
    const pick = (name) => {
      for (let j = i + 1; j < events.length; j += 1)
        if (events[j].name === name) return rel(events[j]);
      return null;
    };
    const begin = rel(events[i]);
    const enter = (() => {
      for (let j = i - 1; j >= 0; j -= 1)
        if (events[j].name === "r-editor-create-enter") return rel(events[j]);
      return null;
    })();
    // r-core-ctor-begin 上只记了 isActive，字符数在它前一个 r-editor-create-enter 上
    const chars = (() => {
      for (let j = i - 1; j >= 0; j -= 1) {
        if (events[j].name === "r-editor-create-enter")
          return events[j].detail?.contentChars ?? null;
      }
      return null;
    })();
    const parse = pick("r-core-parse-done");
    const state = pick("r-core-state-done");
    const view = pick("r-core-view-done");
    const search = pick("r-core-searchpanel-done");
    const exit = (() => {
      for (let j = i + 1; j < events.length; j += 1)
        if (events[j].name === "r-editor-create-exit") return rel(events[j]);
      return null;
    })();
    segs.push({
      chars,
      parse: parse == null ? null : parse - begin,
      plugins: state == null || parse == null ? null : state - parse,
      view: view == null || state == null ? null : view - state,
      initRest: search == null || view == null ? null : search - view,
      coreTotal: search == null ? null : search - begin,
      componentTotal: exit == null || enter == null ? null : exit - enter,
    });
  }
  return segs;
}

// ── 主流程 ────────────────────────────────────────────────────────────────

const labels = (process.argv[2] ?? "build1")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const onlyScenario = process.argv[3] ?? null;
const all = labels.map((label) => ({ label, runs: loadRuns(label) }));

console.log("");
console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  启动基准离线分析（阶段 2）                                            ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");
for (const { label, runs } of all) console.log(`  ${label}: ${runs.length} 轮`);

// ── 指标总表（合并所有 label）─────────────────────────────────────────────
const pooled = all.flatMap((x) => x.runs);
const byScenario = new Map();
for (const r of pooled) {
  const id = r.run.scenario;
  if (!byScenario.has(id)) byScenario.set(id, []);
  byScenario.get(id).push(r);
}

console.log("");
console.log("══ 三指标总表（合并所有批次，全部从进程创建算起）═══════════════════════════");
for (const s of SCENARIOS) {
  const runs = byScenario.get(s.id);
  if (!runs?.length) continue;
  const cells = METRICS.map(([key]) => {
    const v = runs.map((r) => r.rendererInfo.metricAnchor[key]);
    return `${fmt(percentile(v, 50))}/${fmt(percentile(v, 95))}`;
  });
  console.log(
    "  " +
      s.title.padEnd(22) +
      "n=" +
      String(runs.length).padStart(3) +
      "  " +
      cells.join("   ").padEnd(30)
  );
}

// ── 阶段拆解 ──────────────────────────────────────────────────────────────
const target = onlyScenario ?? "normal";
const tRuns = (byScenario.get(target) ?? [])
  .slice()
  .sort(
    (a, b) => a.rendererInfo.metricAnchor.interactiveMs - b.rendererInfo.metricAnchor.interactiveMs
  );
const medianRun = tRuns[Math.floor(tRuns.length / 2)];

console.log("");
console.log(
  `══ 阶段拆解 · 场景「${SCENARIOS.find((s) => s.id === target)?.title ?? target}」· n=${tRuns.length} ══`
);

/** 取 events 流水里第 n 次出现的某个打点（0 基），换算到「从进程创建算起」的口径 */
function nthEvent(run, name, n = 0) {
  const evs = (run.rendererInfo?.events ?? []).filter(
    (e) => e.name === name && typeof e.t === "number"
  );
  if (evs.length <= n) return null;
  const zero = run.clock?.osCreateMs || run.clock?.t0UptimeEstimate;
  if (!zero) return null;
  return evs[n].t - zero;
}

const STAGE_GROUPS = [
  [
    "A 进程创建 → 主进程 JS 开始执行",
    (r) => r.marksMainFromCreateMs["m-main-module-eval"],
    () => 0,
    "Electron/Node 引导",
  ],
  [
    "A 主进程 JS → app.whenReady",
    (r) => r.marksMainFromCreateMs["m-app-ready"],
    (r) => r.marksMainFromCreateMs["m-main-module-eval"],
    "Electron/Chromium 初始化",
  ],
  [
    "A whenReady → IPC 注册完",
    (r) => r.marksMainFromCreateMs["m-ipc-registered"],
    (r) => r.marksMainFromCreateMs["m-app-ready"],
    "主进程",
  ],
  [
    "A IPC → BrowserWindow 构造完",
    (r) => r.marksMainFromCreateMs["m-window-created"],
    (r) => r.marksMainFromCreateMs["m-ipc-registered"],
    "Chromium 窗口/渲染进程创建",
  ],
  [
    "A 构造完 → loadFile",
    (r) => r.marksMainFromCreateMs["m-page-load-start"],
    (r) => r.marksMainFromCreateMs["m-window-created"],
    "主进程",
  ],
  [
    "B loadFile → 渲染进程第一行 JS",
    (r) => r.marksRendererFromCreateMs["r-module-eval"],
    (r) => r.marksMainFromCreateMs["m-page-load-start"],
    "首屏 HTML+JS 字节",
  ],
  [
    "B 模块图求值 → createApp 前",
    (r) => r.marksRendererFromCreateMs["r-before-mount"],
    (r) => r.marksRendererFromCreateMs["r-module-eval"],
    "首屏 JS 字节（求值）",
  ],
  [
    "B createApp → App.onMounted（Vue 首次渲染，子组件 onMounted 就在此刻触发）",
    (r) => r.marksRendererFromCreateMs["r-app-mounted"],
    (r) => r.marksRendererFromCreateMs["r-before-mount"],
    "Vue 首次渲染",
  ],
  [
    "C App.onMounted → 主题/内边距/拼写配置完",
    (r) => r.marksRendererFromCreateMs["r-other-config-applied"],
    (r) => r.marksRendererFromCreateMs["r-app-mounted"],
    "应用启动期配置",
  ],
  [
    "C ⚠ 第一个编辑器 onMounted 早于父组件配置完",
    (r) => nthEvent(r, "r-editor-mounted-begin", 0),
    (r) => r.marksRendererFromCreateMs["r-other-config-applied"],
    "Vue 父子钩子顺序（负值）",
  ],
  [
    "C 第一个编辑器 onMounted → 构造完（空文档）",
    (r) => nthEvent(r, "r-editor-instance-created", 0),
    (r) => nthEvent(r, "r-editor-mounted-begin", 0),
    "编辑器内核（空文档）",
  ],
  [
    "D 第一个编辑器构造完 → 第二个编辑器 onMounted",
    (r) => nthEvent(r, "r-editor-mounted-begin", 1),
    (r) => nthEvent(r, "r-editor-instance-created", 0),
    "IPC 派发文件 + 建第二个 tab",
  ],
  [
    "D 第二个编辑器 onMounted → 构造完（真文档）",
    (r) => nthEvent(r, "r-editor-instance-created", 1),
    (r) => nthEvent(r, "r-editor-mounted-begin", 1),
    "编辑器内核（真文档）",
  ],
  [
    "D 第二个编辑器构造完 → 可交互",
    (r) => r.rendererInfo.metricAnchor.interactiveMs,
    (r) => nthEvent(r, "r-editor-instance-created", 1),
    "事件接线 + 探针往返",
  ],
  [
    "E loadFile → 窗口可见（ready-to-show）",
    (r) => r.rendererInfo.metricAnchor.windowVisibleMs,
    (r) => r.marksMainFromCreateMs["m-page-load-start"],
    "合成器出帧",
  ],
  [
    "F 可交互 → 稳定就绪",
    (r) => r.rendererInfo.metricAnchor.stableReadyMs,
    (r) => r.rendererInfo.metricAnchor.interactiveMs,
    "启动期后台任务",
  ],
  [
    "F   └ 系统字体枚举",
    (r) => r.marksRendererFromCreateMs["r-fonts-resolved"],
    (r) => r.rendererInfo.metricAnchor.interactiveMs,
    "启动期后台任务",
  ],
  [
    "F   └ 工作区扫描",
    (r) => r.marksRendererFromCreateMs["r-workspace-resolved"],
    (r) => r.rendererInfo.metricAnchor.interactiveMs,
    "启动期后台任务",
  ],
];

const stableMed = med(tRuns.map((r) => r.rendererInfo.metricAnchor.stableReadyMs));
console.log(
  "  段".padEnd(42) +
    "中位数".padStart(9) +
    "占可交互".padStart(10) +
    "占稳定".padStart(9) +
    "  n   性质"
);
for (const [label, endFn, startFn, kind] of STAGE_GROUPS) {
  const vals = tRuns
    .map((r) => {
      const e = endFn(r);
      const s = startFn(r);
      if (typeof e !== "number" || typeof s !== "number") return null;
      return e - s;
    })
    .filter((v) => v != null);
  if (vals.length === 0) {
    console.log("  " + label.padEnd(40) + "—".padStart(9) + "  (这批数据里没有这一段)");
    continue;
  }
  const p = med(vals);
  // 占比用「逐轮比值」再取中位数，而不是「中位数之比」：段与段之间是正相关的，
  // 直接把各段中位数加起来会对不上可交互的中位数。
  const ratio = med(
    tRuns
      .map((r) => {
        const e = endFn(r);
        const s = startFn(r);
        if (typeof e !== "number" || typeof s !== "number") return null;
        return ((e - s) / r.rendererInfo.metricAnchor.interactiveMs) * 100;
      })
      .filter((v) => v != null)
  );
  console.log(
    "  " +
      label.padEnd(40) +
      fmt(p).padStart(9) +
      ratio.toFixed(1).padStart(9) +
      "%" +
      ((p / stableMed) * 100).toFixed(1).padStart(8) +
      "%" +
      "  " +
      String(vals.length).padStart(3) +
      "  " +
      kind
  );
}

// 自检：A→D 这些段首尾相接，加起来应该正好等于可交互时间
{
  const chain = STAGE_GROUPS.filter(([l]) => /^[ABCD] /.test(l));
  const sums = tRuns
    .map((r) => {
      let sum = 0;
      let ok = true;
      for (const [, endFn, startFn] of chain) {
        const e = endFn(r);
        const s = startFn(r);
        if (typeof e !== "number" || typeof s !== "number") {
          ok = false;
          break;
        }
        sum += e - s;
      }
      return ok ? sum - r.rendererInfo.metricAnchor.interactiveMs : null;
    })
    .filter((v) => v != null);
  console.log(
    `  （自检）A–D 段首尾相接求和 − 可交互：n=${sums.length}  中位 ${r1(med(sums))}ms  max|偏差| ${r1(Math.max(...sums.map(Math.abs)))}ms`
  );
}

if (medianRun) {
  console.log("");
  console.log("  ── 中位轮次的完整时间线（可交互最接近中位数的那一轮）──");
  const tl = timelineOf(medianRun);
  let prev = 0;
  for (const x of tl) {
    const d = x.t - prev;
    console.log(`    ${fmt(x.t).padStart(8)}  ${fmt(d).padStart(8)}  [${x.side}] ${x.k}`);
    prev = x.t;
  }
}

// ── 编辑器核心占比（ADR 第 7 条）─────────────────────────────────────────
console.log("");
console.log("══ 编辑器内核占比（ADR 0001 第 7 条的 30% 门槛）════════════════════════════");
console.log("  说明：r-core-* 打点包住 MilkupEditor 构造函数，即 Markdown 解析 + ProseMirror");
console.log("        schema/插件链 + EditorView 建 DOM 与装饰器 + 插件初始化。");
console.log(
  "        启动期会构造两次编辑器（先空文档、再命令行打开的真文档），这里按 events 流水全量相加。"
);
console.log("");
for (const s of SCENARIOS) {
  const runs = byScenario.get(s.id);
  if (!runs?.length) continue;
  const rows = runs.map((r) => ({
    segs: coreSegments(r),
    inter: r.rendererInfo.metricAnchor.interactiveMs,
  }));
  const totalCore = rows.map((x) => x.segs.reduce((a, g) => a + (g.coreTotal ?? 0), 0));
  const totalComponent = rows.map((x) => x.segs.reduce((a, g) => a + (g.componentTotal ?? 0), 0));
  const inter = rows.map((x) => x.inter);
  const parts = (key) => rows.map((x) => x.segs.reduce((a, g) => a + (g[key] ?? 0), 0));
  const share = (v) => (med(v) / med(inter)) * 100;
  console.log(`  ${s.title}`);
  console.log(
    `    n=${rows.length}  内核合计中位数 ${fmt(med(totalCore))}（${share(totalCore).toFixed(1)}% 可交互）` +
      `  编辑器组件全流程 ${fmt(med(totalComponent))}（${share(totalComponent).toFixed(1)}%）`
  );
  console.log(
    `      拆开：解析 ${fmt(med(parts("parse")))} / 插件链 ${fmt(med(parts("plugins")))} / 建 view+DOM+装饰 ${fmt(med(parts("view")))} / 插件初始化+tooltip+搜索面板 ${fmt(med(parts("initRest")))}`
  );
  console.log(
    `      构造次数中位数 ${med(rows.map((x) => x.segs.length))}，每次字符数 ${[...new Set(rows.flatMap((x) => x.segs.map((g) => g.chars)))].join(" / ")}`
  );
  // 逐次构造拆开：空文档那次和真文档那次要分开看，才能区分
  // 「启动路径固定开销」和「输入规模带来的成本」
  if (rows.length) {
    const mid = rows[Math.floor(rows.length / 2)];
    mid.segs.forEach((g, i) => {
      console.log(
        `      第 ${i + 1} 次构造（${g.chars} 字符）：内核 ${fmt(g.coreTotal)} = 解析 ${fmt(g.parse)} + 插件链 ${fmt(g.plugins)} + 建view ${fmt(g.view)} + 插件初始化 ${fmt(g.initRest)}；组件全流程 ${fmt(g.componentTotal)}`
      );
    });
  }
}

// ── 内存 ──────────────────────────────────────────────────────────────────
console.log("");
console.log("══ 峰值内存 ═══════════════════════════════════════════════════════════════");
console.log("  口径：app.getAppMetrics()，对全部 Electron 进程求和，取启动全程最大值。");
for (const s of SCENARIOS) {
  const runs = byScenario.get(s.id);
  if (!runs?.length) continue;
  const ws = runs.map((r) => r.memory?.peak?.totalKb).filter((x) => typeof x === "number");
  const pv = runs.map((r) => r.memory?.peakPrivate?.privateKb).filter((x) => typeof x === "number");
  const atInt = runs.map((r) => r.rendererInfo?.memoryMilestones?.atInteractive?.totalKb);
  const atIntPv = runs.map(
    (r) => r.rendererInfo?.memoryMilestones?.atInteractivePrivate?.privateKb
  );
  const mb = (kb) => (kb == null ? "—" : Math.round(kb / 1024) + "MB");
  console.log(
    `  ${s.title.padEnd(22)} 工作集峰值 中位 ${mb(med(ws))} (min ${mb(Math.min(...ws.filter(Boolean)))} max ${mb(Math.max(...ws.filter(Boolean)))})` +
      `  私有字节峰值 中位 ${mb(med(pv))}  可交互时刻 工作集 ${mb(med(atInt))} 私有 ${mb(med(atIntPv))}`
  );
  // 峰值时刻的逐进程拆解（取中位轮次）
  const pick = runs[Math.floor(runs.length / 2)];
  const bd = pick.memory?.peak?.breakdown ?? [];
  console.log(
    "      逐进程（" +
      fmt(pick.rendererInfo.metricAnchor.interactiveMs) +
      " 那轮的中位轮次）：" +
      bd
        .map(
          (p) =>
            `${p.type} 工作集${Math.round(p.workingSetKb / 1024)}MB/私有${Math.round(p.privateBytesKb / 1024)}MB`
        )
        .join("  ")
  );
  // Browser + Tab 的私有字节（峰值时刻的拆解）——剔除 GPU/Utility 之后的稳定口径
  const btPriv = runs
    .map((r) => {
      const bd2 = r.memory?.peak?.breakdown ?? [];
      const b = bd2.find((p) => p.type === "Browser");
      const t = bd2.find((p) => p.type === "Tab");
      return b && t ? b.privateBytesKb + t.privateBytesKb : null;
    })
    .filter((x) => typeof x === "number");
  if (btPriv.length) {
    console.log(
      `      Browser+Tab 私有字节合计（峰值时刻）中位 ${Math.round(med(btPriv) / 1024)}MB   ← 剔除 GPU/Utility 之后的稳定口径`
    );
  }
  // 三个候选口径各自的批内标准差：判断哪个能当 CI 判据就看这个
  const sd = (v) => {
    if (v.length < 2) return null;
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    return Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length) / 1024;
  };
  console.log(
    `      批内标准差：工作集合计 ${r1(sd(ws))}MB   私有字节合计 ${r1(sd(pv))}MB   Browser+Tab 私有 ${r1(sd(btPriv))}MB`
  );
}

// ── 时钟 ──────────────────────────────────────────────────────────────────
console.log("");
console.log("══ 时钟口径 ═══════════════════════════════════════════════════════════════");
const t0d = pooled.map((r) => r.clock?.t0MinusOsCreateMs).filter((x) => typeof x === "number");
const boot = pooled
  .map((r) => r.clock?.bootstrapToMainModuleEvalMs)
  .filter((x) => typeof x === "number");
const launcher = pooled
  .map((r) => r.clock?.launcherToOsCreateMs)
  .filter((x) => typeof x === "number");
const cim = pooled.map((r) => r.clock?.osCreateCimDeltaMs).filter((x) => typeof x === "number");
console.log(
  `  t0 比真实进程创建晚        n=${t0d.length}  中位 ${r1(med(t0d))}ms  (min ${r1(Math.min(...t0d))} max ${r1(Math.max(...t0d))})`
);
console.log(
  `  进程创建 → 主进程 JS       n=${boot.length}  中位 ${r1(med(boot))}ms  (min ${r1(Math.min(...boot))} max ${r1(Math.max(...boot))})`
);
console.log(`  启动器 spawn → 进程创建    n=${launcher.length}  中位 ${r1(med(launcher))}ms`);
if (cim.length)
  console.log(
    `  WMI 交叉校验差（两来源）    n=${cim.length}  中位 ${r1(med(cim))}ms  max ${r1(Math.max(...cim))}ms`
  );

// ── 两次构建对比 ──────────────────────────────────────────────────────────
if (all.length >= 2) {
  console.log("");
  console.log("══ 批次对比（两次独立构建的同一场景）═════════════════════════════════════");
  for (const s of SCENARIOS) {
    const per = all
      .map(({ label, runs }) => {
        const rs = runs.filter((r) => r.run.scenario === s.id);
        if (rs.length < 2) return null;
        return {
          label,
          n: rs.length,
          inter: rs.map((r) => r.rendererInfo.metricAnchor.interactiveMs),
        };
      })
      .filter(Boolean);
    if (per.length < 2) continue;
    console.log(`  ${s.title}`);
    for (const p of per) {
      const p50 = percentile(p.inter, 50);
      const mean = p.inter.reduce((a, b) => a + b, 0) / p.inter.length;
      const sd = Math.sqrt(p.inter.reduce((a, b) => a + (b - mean) ** 2, 0) / p.inter.length);
      console.log(
        `    ${p.label.padEnd(12)} n=${String(p.n).padStart(3)}  可交互 P50 ${fmt(p50)}  P95 ${fmt(percentile(p.inter, 95))}  σ ${r1(sd)}ms  min ${fmt(Math.min(...p.inter))}  max ${fmt(Math.max(...p.inter))}`
      );
    }
    const a = per[0];
    const b = per[1];
    const pa50 = percentile(a.inter, 50);
    const pb50 = percentile(b.inter, 50);
    const pa95 = percentile(a.inter, 95);
    const pb95 = percentile(b.inter, 95);
    console.log(
      `    差值        P50 ${r1(pb50 - pa50)}ms (${(((pb50 - pa50) / pa50) * 100).toFixed(2)}%)   P95 ${r1(pb95 - pa95)}ms (${(((pb95 - pa95) / pa95) * 100).toFixed(2)}%)`
    );
  }
}
console.log("");
