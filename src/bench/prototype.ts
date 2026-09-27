/* ============================================================================
 * PROTOTYPE / THROWAWAY — 启动性能基准「渲染进程侧」打点。
 *
 * 存在的唯一理由：给 Issue #18 的启动基准提供可复用的时间戳、可交互判定、
 * 稳定就绪判定和场景状态注入。本文件不做任何优化，也不改变启动行为。
 * 基准原型结束后整个 src/bench/ 目录连同 src 里的调用点一起删除。
 *
 * 关闭方式：不给 Electron 传 MILKUP_BENCH_RUN 环境变量时，
 * benchActive === false，所有函数直接 return，唯一副作用是 preload 里多了
 * 一个值为 null 的只读字段。
 * ==========================================================================*/

/** 挂在 window 上、供主进程 executeJavaScript 兜底读取的调试对象 */
export const BENCH_GLOBAL_KEY = "__MILKUP_BENCH__";

interface BenchBridge {
  runId: string;
  seed: Record<string, string> | null;
}

function readBridge(): BenchBridge | null {
  const api = (globalThis as any).electronAPI;
  const cfg = api?.__bench;
  if (!cfg || !cfg.runId) return null;
  return cfg as BenchBridge;
}

const bridge = readBridge();

/** 本次运行是否处于基准模式 */
export const benchActive = bridge !== null;

export const benchRunId = bridge?.runId ?? null;

/** 绝对墙钟（ms，浮点）。主进程与渲染进程共用这一个时钟，所以两边的时间戳可直接相减。 */
function wallNow(): number {
  return performance.timeOrigin + performance.now();
}

const marks: Record<string, number> = {};
const info: Record<string, unknown> = { runId: benchRunId };
let finished = false;

// ── 场景状态注入 ───────────────────────────────────────────────────────────
// 只写应用自己会写的 localStorage 键（milkup-config 等），不改任何代码路径。
if (bridge?.seed) {
  for (const [key, value] of Object.entries(bridge.seed)) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      marks["r-seed-error"] = wallNow();
      info.seedError = String(error);
    }
  }
  marks["r-seed-applied"] = wallNow();
}

// 模块求值即打点：ESM 会按 import 顺序求值，本文件在 main.ts 里是第一个 import，
// 所以这个点约等于「渲染进程开始执行 JS」。
marks["r-module-eval"] = wallNow();

function pushState(extra?: Record<string, unknown>): void {
  if (!benchActive || finished) return;
  try {
    Object.assign(info, extra);
    (globalThis as any).electronAPI.__benchPush({ marks, info });
  } catch {
    /* 基准数据回传失败不能影响应用 */
  }
}

/**
 * 打一个时间点。
 * @param name 阶段名
 * @param note 附加信息（会进 info，不参与时间计算）
 */
export function benchMark(name: string, note?: unknown): void {
  if (!benchActive) return;
  marks[name] = wallNow();
  pushState(note === undefined ? undefined : { [name + "Note"]: note });
  checkStableReady();
}

// ── 可交互判定 ─────────────────────────────────────────────────────────────

const INPUT_MARKER = "ZQXBENCHMARK";
const INTERACTIVE_ATTEMPT_LIMIT = 8;

const interactiveLatch = { done: false, verified: false };
const stableLatch = { done: false };

let interactiveAttempts = 0;
let interactiveDetails: Record<string, unknown> = {};

/** 等待 n 个渲染帧；返回时至少已经走过一次合成。
 *
 * 关键：不能只靠 requestAnimationFrame。这台机器上跑真实应用时，
 * 窗口被别的窗口完全盖住会让 Chromium 停止产帧，rAF 永不回调，基准会挂死。
 * 所以每个 rAF 都同时挂一个 setTimeout 兜底，并记录到底是不是 rAF 真的回调了。
 */
let rafCallbacks = 0;
let rafTimeouts = 0;

function nextFrame(n = 1): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    let left = n;
    const step = () => {
      left -= 1;
      if (left > 0) requestAnimationFrame(step);
      else done();
    };
    const guard = setTimeout(() => {
      rafTimeouts += 1;
      done();
    }, Math.max(120, n * 150));
    requestAnimationFrame(() => {
      rafCallbacks += 1;
      clearTimeout(guard);
      step();
    });
  });
}

/** 打个「等 n 帧之后」的时间点，供不方便直接用内部 helper 的调用方 */
export function benchMarkAfterFrames(name: string, n = 2, note?: unknown): void {
  if (!benchActive) return;
  void nextFrame(n).then(() => benchMark(name, note));
}

function editorMarkdown(editor: any): string {
  try {
    return typeof editor?.getMarkdown === "function" ? editor.getMarkdown() : "";
  } catch {
    return "";
  }
}

/**
 * 真的派发一次输入，并确认文档内容真的变了，才认为「可交互」。
 *
 * 做法：
 *  1. 聚焦 ProseMirror 的 contenteditable，把选区放到文档开头；
 *  2. document.execCommand('insertText') —— 走 Chromium 编辑管线，
 *     和输入法/粘贴回退同一条路径，是真输入而不是伪造事件；
 *  3. 等 ProseMirror 的 MutationObserver（微任务）把 DOM 变更刷进 state，
 *     再回读 view.state.doc.textContent 和 editor.getMarkdown()，
 *     确认标记文字真的进了文档模型。
 *
 * 只有第 3 步通过，才把 marks['r-input-dispatched'] 视为可交互时间。
 */
async function tryInputOnce(getEditor: () => any): Promise<boolean> {
  const editor = getEditor();
  if (!editor || !editor.view) return false;

  const dom = editor.view.dom as HTMLElement | undefined;
  if (!dom) return false;

  interactiveAttempts += 1;

  try {
    (globalThis as any).focus?.();
    dom.focus?.();
    editor.view.focus?.();
  } catch {
    /* 聚焦失败不代表不可输入，继续试 */
  }

  const before = editor.view.state.doc.textContent ?? "";
  const beforeMd = editorMarkdown(editor);

  let dispatched = false;
  try {
    dispatched = document.execCommand("insertText", false, INPUT_MARKER);
  } catch (error) {
    interactiveDetails.execCommandError = String(error);
  }

  // 可交互时间 = 这次输入真正进入编辑管线之后立刻取的时刻。
  marks["r-input-dispatched"] = wallNow();
  interactiveDetails.execCommandReturned = dispatched;
  interactiveDetails.attempt = interactiveAttempts;

  // 等微任务（ProseMirror 的 MutationObserver）+ 两帧，让 DOM 变更进入 state。
  await Promise.resolve();
  await nextFrame(2);

  const afterDocText = editor.view.state.doc?.textContent ?? "";
  const afterMd = editorMarkdown(editor);
  const domHasMarker = (dom.textContent ?? "").includes(INPUT_MARKER);
  const docHasMarker = afterDocText.includes(INPUT_MARKER);
  const mdHasMarker = afterMd.includes(INPUT_MARKER);

  interactiveDetails = {
    ...interactiveDetails,
    hasFocus: document.hasFocus(),
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    rafCallbacks,
    rafTimeouts,
    domHasMarker,
    docHasMarker,
    mdHasMarker,
    docDelta: afterDocText.length - before.length,
    mdDelta: afterMd.length - beforeMd.length,
    attempt: interactiveAttempts,
  };

  // 以「文档模型真的变了」为准，DOM 变了但模型没变不算数。
  return docHasMarker && mdHasMarker && domHasMarker;
}

/**
 * 启动可交互探测。由 MilkupEditor.vue 在编辑器实例建好之后调用一次。
 * @param getEditor 取当前 MilkupEditor 实例（此时组件内已挂好）
 */
export function benchProbeInteractive(getEditor: () => any): void {
  if (!benchActive) return;

  const run = async () => {
    marks["r-probe-begin"] = wallNow();
    for (let i = 0; i < INTERACTIVE_ATTEMPT_LIMIT; i += 1) {
      const ok = await tryInputOnce(getEditor);
      if (ok) {
        interactiveLatch.verified = true;
        break;
      }
      await nextFrame(2);
    }
    marks["r-input-verified"] = wallNow();
    interactiveLatch.done = true;
    interactiveDetails.verified = interactiveLatch.verified;
    interactiveDetails.attempts = interactiveAttempts;
    pushState({ interactive: interactiveDetails });
    maybeFinish();
  };

  void run();
}

// ── 稳定就绪判定 ───────────────────────────────────────────────────────────

let requiredStableMarks: string[] = [];
let stableRequested = false;
let stableTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

/**
 * 声明「稳定就绪」需要等到哪些阶段。全部到齐后再等两帧就打点。
 * @param names 阶段名数组
 */
export function benchExpectStableReady(names: string[]): void {
  if (!benchActive) return;
  requiredStableMarks = names;
  if (stableTimeoutHandle) clearTimeout(stableTimeoutHandle);
  stableTimeoutHandle = setTimeout(() => {
    if (stableLatch.done) return;
    marks["r-stable-ready"] = wallNow();
    stableLatch.done = true;
    pushState({
      stableReadyTimedOut: true,
      stableReadyMissing: requiredStableMarks.filter((n) => !(n in marks)),
    });
    maybeFinish();
  }, 30_000);
}

/** 每次打完点都检查一下稳定就绪条件。由 benchMark 内部调用。 */
function checkStableReady(): void {
  if (!benchActive || stableLatch.done || stableRequested) return;
  if (requiredStableMarks.length === 0) return;
  if (!requiredStableMarks.every((name) => name in marks)) return;
  stableRequested = true;
  // 全部启动期后台任务完成的时刻（不等帧）
  marks["r-stable-ready-tasks-done"] = wallNow();
  // 再等两帧，让这些结果真的反映到画面上
  void nextFrame(2).then(() => {
    marks["r-stable-ready"] = wallNow();
    stableLatch.done = true;
    pushState({ stableReadyTimedOut: false });
    maybeFinish();
  });
}

// ── 收尾 ───────────────────────────────────────────────────────────────────

function maybeFinish(): void {
  if (finished) return;
  if (!interactiveLatch.done || !stableLatch.done) return;
  if (stableTimeoutHandle) clearTimeout(stableTimeoutHandle);
  finished = true;

  try {
    const resources = performance
      .getEntriesByType("resource")
      .map((entry) => ({
        name: entry.name.split("/").pop() ?? entry.name,
        initiatorType: entry.initiatorType,
        startTime: Math.round(entry.startTime * 100) / 100,
        duration: Math.round(entry.duration * 100) / 100,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize,
      }))
      .sort((a, b) => a.startTime - b.startTime);
    info.resources = resources;
  } catch {
    /* 忽略 */
  }

  try {
    const nav = performance.getEntriesByType("navigation")[0];
    if (nav) {
      info.navigation = {
        responseStart: Math.round(nav.responseStart * 100) / 100,
        domInteractive: Math.round(nav.domInteractive * 100) / 100,
        domContentLoadedEventEnd: Math.round(nav.domContentLoadedEventEnd * 100) / 100,
        loadEventEnd: Math.round(nav.loadEventEnd * 100) / 100,
        duration: Math.round(nav.duration * 100) / 100,
        transferSize: nav.transferSize,
        encodedBodySize: nav.encodedBodySize,
        decodedBodySize: nav.decodedBodySize,
      };
    }
  } catch {
    /* 忽略 */
  }

  marks["r-finish"] = wallNow();
  info.raf = { callbacks: rafCallbacks, timeouts: rafTimeouts, healthy: rafTimeouts === 0 };
  try {
    (globalThis as any).electronAPI.__benchPush({ marks, info, done: true });
  } catch {
    /* 忽略 */
  }
  // 方便人工用 devtools 查
  (globalThis as any)[BENCH_GLOBAL_KEY] = { marks, info };
}

// 模块求值结束时把初始状态推给主进程
if (benchActive) {
  (globalThis as any)[BENCH_GLOBAL_KEY] = { marks, info };
  pushState();
  // 兜底：如果两个判定都因为异常没收敛，30s 后也要把数据交出去
  setTimeout(() => {
    if (finished) return;
    // 兜底：两个判定都因为异常没收敛时，45s 后也要把数据交出去
    interactiveLatch.done = true;
    stableLatch.done = true;
    maybeFinish();
  }, 45_000);
}
