# 启动性能基准 · 阶段 1（原型打点与冒烟）

> **PROTOTYPE / THROWAWAY。** 这一整套东西只为 Issue #18 采集基线数据，不含任何启动优化。
> 基准跑完、基线确认之后，`bench/` 与 `src/bench/` 加上 `src/` 里的打点调用点应该一起删掉。

## 1. 怎么跑

```powershell
chcp 65001 >$null; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)

# 必须先构建生产产物（不许用 pnpm dev）
cmd /c "pnpm build"

# 正式基准：主场景 20 次 + 次要场景 5 次
cmd /c "pnpm bench:startup"

# 冒烟：5 个场景各 1 次，不带 warmup
cmd /c "pnpm bench:startup:smoke"

# 只看首屏体积
cmd /c "pnpm bench:assets"
```

常用参数（透传给 `node bench/run.mjs`）：

| 参数 | 作用 |
| --- | --- |
| `--scenarios=empty,normal` | 只跑指定场景 |
| `--repeat=N` | 所有场景都跑 N 次（默认主场景 20、次要 5） |
| `--warmup=N` | 每个场景前先跑 N 次预热并丢弃（默认 1，`--smoke` 下为 0） |
| `--gap=MS` | 每轮之间的间隔（默认 1200） |
| `--timeout=SEC` | 单轮等待报告落盘的超时（默认 120） |

产物全部落在 `%TEMP%\milkup-bench-PROTOTYPE\`：

- `docs/PROTOTYPE-normal.md`、`docs/PROTOTYPE-large.md` —— 测试文档
- `workspace/` —— 本地工作区（3 个子目录 + 23 个 md）
- `profile/` —— Electron 的 `--user-data-dir`，与用户真实配置隔离
- `runs/*.json` —— 每轮一份完整原始数据

## 2. 场景怎么构造

先说结论：**应用没有任何「上次打开文件」的持久化**。`useConfig` 只往 `localStorage["milkup-config"]`
里存配置，`src/main/index.ts` 的 `sendLaunchFileIfExists()` 是唯一打开文件的入口，来源只有 `process.argv`。
所以「打开某份文档」这个场景状态只能靠命令行参数注入。

| # | 场景 | 文件 | 侧边栏 / 工作区 | 主场景 |
| --- | --- | --- | --- | --- |
| 1 | 空文档 | 无（落在默认 Untitled tab） | `startupPath:""`、侧边栏关 | |
| 2 | 普通文档 ≈3000 字符 | `PROTOTYPE-normal.md`（命令行） | `startupPath:""`、侧边栏关 | ✅ |
| 3 | 大文档 200000 字符 | `PROTOTYPE-large.md`（命令行） | `startupPath:""`、侧边栏关 | |
| 4 | 无工作区 | `PROTOTYPE-normal.md`（命令行） | `startupPath:""`、侧边栏关（显式写死） | |
| 5 | 本地工作区 | `PROTOTYPE-normal.md`（命令行） | `startupPath=workspace/`、`autoExpandSidebar:true` | |
| 6 | WSL 工作区 | — | — | ❌ 本机测不了 |

**主场景为什么选 2（普通文档）**：Issue #18 的目标是「主场景 P95 至少缩短 25%」，
主场景必须是**最典型的那一个**。空文档没有解析成本、大文档是极端输入，
带工作区的两个场景测的是侧边栏/文件树这条支线。普通文档 = 打开一个几千字的日常笔记然后开始打字，
这也是 ADR 0001 第 5 条描述的默认形态（侧边栏启动时关闭），所以选它。

**场景 4 是有意和场景 2 重复的**：两者的有效状态完全一样，差异只在 localStorage 里有没有留下过
「曾经配过工作区」的痕迹。它的作用是当**回归护栏**——两个同状态的场景如果数字差很多，
说明工具本身方差有问题，而不是应用有问题。冒烟数据里两者相差约 5%，符合预期。

**注意一个容易漏的事实**：只要命令行打开了文件，`useWorkSpace` 里那个 `watch(tabs)` 就会
拿文件所在目录做一次整树扫描（`getWorkSpace()`），并 `startWatching`。也就是说
**场景 2/3/4/5 全都在启动期扫了一遍目录**，只有场景 1 完全不碰文件系统。
所以「无工作区」并不等于「没有工作区开销」。

**场景状态注入方式**：`src/bench/prototype.ts` 在 `main.ts` 里作为**第一个 import** 求值，
在任何应用代码读 `localStorage` 之前把基准用的键值写进去（写的就是应用自己会写的
`milkup-config`）。不传 `MILKUP_BENCH_RUN` 环境变量时这段代码直接 return，
`localStorage` 一个字节都不动。

## 3. 阶段打点方案

起点统一是 `t0 = performance.timeOrigin + performance.now() − process.uptime()×1000`（主进程里算一次）。
渲染进程和主进程共用这一个墙钟，所以两边的绝对时间戳可以直接相减。

### 三个指标各自落在哪个点

| 指标 | 取哪个打点 | 含义与理由 |
| --- | --- | --- |
| **可交互时间**（主指标） | `r-input-dispatched` | 真的调了一次 `document.execCommand("insertText")` 并且**回读确认文档模型真的变了**之后立刻取的时刻。不是「view 创建完」就算。 |
| **窗口可见时间** | `m-window-ready-to-show` | 首选。备选 `m-window-visible-at-construct`。 |
| **稳定就绪时间** | `r-stable-ready` | 字体 + 主题 + 工作区 + 启动期后台任务全部完成，再等两帧。 |

`r-input-dispatched` 和 `r-input-verified` 的差（约 35–70ms）就是「输入进管线」到
「ProseMirror 的 MutationObserver 把 DOM 变更刷进 state」的延迟。取前者，因为用户按键的那一刻
落在 `execCommand` 内部。

### 可交互判定怎么做的

`src/bench/prototype.ts` 的 `benchProbeInteractive()`，由 `MilkupEditor.vue` 在
`createMilkupEditor()` 返回后、只对活跃 tab 调用一次：

1. 聚焦 ProseMirror 的 contenteditable，把选区放到文档开头；
2. `document.execCommand("insertText", false, "ZQXBENCHMARK")`——走 Chromium 编辑管线，
   和输入法/粘贴回退同一条路径，是**真输入**，不是伪造 `KeyboardEvent`；
3. 等微任务（ProseMirror 的 MutationObserver）+ 两帧；
4. 回读 `view.state.doc.textContent`、`editor.getMarkdown()`、`view.dom.textContent`，
   **三处都要含标记文字**才算通过；
5. 不通过就重试，最多 8 次。

只有第 4 步通过，`interactiveVerified` 才为 `true`，该轮的汇总表「确认」列才会打勾。
冒烟 15 轮全部 `n/n` 通过。

### 主进程打点

| 打点 | 位置 | 说明 |
| --- | --- | --- |
| `m-main-module-eval` | `src/main/index.ts` 顶部 | 主进程 JS 开始执行 |
| `m-app-ready` | `app.whenReady().then()` 开头 | Electron/Chromium 初始化完成 |
| `m-ipc-registered` | IPC handler 注册完 | |
| `m-window-created` | `new BrowserWindow()` 返回 | |
| `m-window-visible-at-construct` | 同上，检查 `isVisible()` | 兜底的窗口可见口径 |
| `m-window-ready-to-show` | `ready-to-show` | **窗口可见时间** |
| `m-window-shown` / `m-renderer-first-paint` | `show` / `paint` 事件 | 本机实测**不触发**，留着只为留证据 |
| `m-did-finish-load` / `m-page-load-end` | `loadFile` 前后 | |
| `m-window-maximized` | `maximize()` 后 | |
| `m-renderer-ready-ipc` | 收到渲染进程 `renderer-ready` | |
| `m-launch-file-dispatched` | `sendLaunchFileIfExists()` 后 | |

### 渲染进程打点

| 打点 | 位置 | 说明 |
| --- | --- | --- |
| `r-seed-applied` | `src/bench/prototype.ts` 模块体 | 基准场景写入 localStorage 完成 |
| `r-module-eval` | 同上 | ≈「渲染进程开始执行 JS」（ESM 按 import 顺序求值，它排第一） |
| `r-before-mount` / `r-after-mount` | `src/renderer/main.ts` | `createApp()` 前后、`app.mount()` 前后 |
| `r-app-mounted` | `App.vue` `onMounted` 开头 | |
| `r-theme-applied` | `initTheme()` 后 | |
| `r-fonts-resolved` | `initFont()` 的 `.then()` | **系统字体枚举完成**（`getFonts()` 返回） |
| `r-other-config-applied` / `r-spellcheck-applied` | `initOtherConfig()` / `initSpellCheck()` 后 | |
| `r-workspace-watch-started` | `useWorkSpace.startWatching()` | chokidar / 轮询已挂上 |
| `r-workspace-resolved` | `useWorkSpace.getWorkSpace()` 和 `openWorkSpaceByPath()` 扫描完 | 带 `trigger` 区分是「配置的工作区」还是「打开文件隐式带出来的目录」 |
| `r-editor-instance-created` | `MilkupEditor.createEditorInstance()` 里 `createMilkupEditor()` 之后 | ProseMirror 解析已完成 |
| `r-editor-first-frame` | 再等两帧 | 编辑器内容真的进了 DOM |
| `r-probe-begin` / `r-input-dispatched` / `r-input-verified` | 可交互探测 | |
| `r-stable-ready-tasks-done` | 五个必需打点齐了的那一刻 | 不等帧 |
| `r-stable-ready` | 再等两帧 | **稳定就绪时间** |

`稳定就绪` 的「五个必需打点」在 `App.vue` 里用 `benchExpectStableReady([...])` 声明：
`r-theme-applied`、`r-fonts-resolved`、`r-other-config-applied`、`r-spellcheck-applied`、`r-workspace-resolved`。
没有配置工作区时 `r-workspace-resolved` 会被立刻打上，所以不会永远挂着；30s 有超时兜底并打标。

### 峰值内存口径

主进程每 50ms 调一次 `app.getAppMetrics()`，对**所有** Electron 进程
（Browser / Tab / GPU / Utility）求和：

- **工作集** `memory.workingSetSize` —— 操作系统视角的驻留物理页，含共享页
- **私有** `memory.privateBytes` —— 单独记了一份，因为共享页会让工作集虚高

取启动全程的最大值作为「峰值内存」，并保存峰值时刻的逐进程拆解。
`metricAnchor.memoryAtInteractive` 另存「可交互之前」的峰值，方便区分「可交互峰值」和「全程峰值」。

采样本身是侵入的（20 次/秒的同步 IPC），阶段 2 要量一下它的代价。

## 4. 冒烟数据

机器：Windows 11 家庭中文版 10.0.26200 / AMD Ryzen 7 5800H / 15.4GB / Node v24.19.0 / Electron 37.10.3。
命令：`node bench/run.mjs --repeat=2 --warmup=1`（预热轮已剔除，下面是 2 次的汇总，不是正式 P50/P95）。

| 场景 | n | 可交互 P50 | 窗口可见 P50 | 稳定就绪 P50 | 峰值内存 | 交互确认 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 空文档 | 2 | 680ms | 698ms | 1.26s | 468MB | 2/2 |
| 2 普通文档（主场景） | 2 | 839ms | 685ms | 1.36s | 522MB | 2/2 |
| 3 大文档 200000 字符 | 2 | 1.45s | 734ms | 1.98s | 847MB | 2/2 |
| 4 无工作区 | 2 | 887ms | 722ms | 1.38s | 523MB | 2/2 |
| 5 本地工作区 | 2 | 903ms | 728ms | 1.37s | 542MB | 2/2 |

同一场景两次之间的抖动在 15–50ms，工具本身方差很小。5 个场景 15 轮全部通过交互验证、
没有触发任何可疑信号。

### 阶段拆解（主场景，普通文档，run 1）

```
主进程
  0ms        t0（进程创建时刻估算）
  165ms      主进程 JS 开始执行
  253ms      app.whenReady（Electron/Chromium 初始化完成）   ← 88ms
  319ms      BrowserWindow 构造完成
  321ms      开始 loadFile
  677ms      ready-to-show（窗口可见）                      ← 356ms
  687ms      maximize 返回
渲染进程
  554ms      渲染进程开始执行 JS
  605ms      createApp 之前（54ms 是所有 import 求值）
  635ms      app.mount 返回
  635ms      主题应用完成
  788ms      Milkup 编辑器实例创建完成（解析 + 建 view）
  830ms      ★ 可交互
  844ms      工作区扫描完成（打开文件隐式带出来的目录）
  1.27s      系统字体枚举完成                                ← 635ms
  1.35s      ★ 稳定就绪
```

从这份拆解能直接读出阶段 2 的候选方向（**这里不下结论，只是把数摆出来**）：

- `app.whenReady` 88ms：Electron/Chromium 固定开销，动不了。
- `loadFile` → `ready-to-show` 356ms：解析并执行 2.3MB 首屏 JS + 210KB CSS。
- `r-module-eval` → `r-before-mount` 54ms：模块图求值。
- 挂载 → 编辑器可输入 195ms。
- **系统字体枚举 635ms，完全落在可交互之后**（1.27s vs 830ms），只影响稳定就绪。
  这和 Issue #18 预研线索里 PowerShell 字体枚举 471–701ms 对得上。
- 大文档比普通文档多约 610ms，绝大部分在 `createMilkupEditor()` 里（1.29s vs 788ms），
  即 Markdown 解析 + ProseMirror 建文档。ADR 第 7 条的「超过 30% 要另开 Spec」门槛，
  阶段 2 需要按场景分别算这个占比。

## 5. 首屏 JS/CSS 体积

口径：`dist/index.html` 里显式引用的资源（module script + modulepreload + stylesheet）。
Vite 生产构建把入口的静态依赖写成 `<link rel="modulepreload">`，浏览器解析 HTML 时就会并行下载，
所以它们属于首屏字节。

| 资源 | 原始 | Gzip |
| --- | --- | --- |
| `assets/main-*.js`（入口） | 277.2 KB | 91.1 KB |
| `assets/theme-main-*.js`（modulepreload 共享 chunk） | 2.026 MB | 0.682 MB |
| `assets/theme-main-*.css` | 73.4 KB | 15.6 KB |
| `assets/main-*.css` | 137.0 KB | 20.2 KB |
| **首屏 JS 合计** | **2.296 MB** | **0.771 MB** |
| **首屏 CSS 合计** | **0.205 MB** | **35.9 KB** |

参考：`dist/assets` 全部 67 个 js（含 mermaid、codemirror 语言、主题编辑器等按需 chunk）
共 5.340 MB / Gzip 1.638 MB —— 按需拆包本身是有效的，首屏只吃到其中 2.296 MB。

### 与 ADR 0001 预算的交叉校验：**三项全挂**

```
FAIL  首屏 JS 原始    实际 2351.4 KB  预算 2150.4 KB  超出 201.0 KB
FAIL  首屏 JS Gzip    实际  789.6 KB  预算  720.0 KB  超出  69.6 KB
FAIL  首屏 CSS Gzip   实际   35.9 KB  预算   30.0 KB  超出   5.9 KB
```

这条要如实记下来：**ADR 里那三个数字对不上当前产物**。两种可能，阶段 2 必须查清是哪种：

1. ADR 写预算时用的「首屏」口径和这里不同（比如只算入口 script、不算 modulepreload 共享 chunk，
   或者只算 `main-*.css`、不算 `theme-main-*.css`）。按「只算入口 script + 两份 CSS」算就是
   JS 原始 277KB / Gzip 91KB，远低于预算，看着像预算就是照这个口径写的。
2. 预算写的时候产物确实更小，之后有东西长进来了。

不管哪种，**在澄清之前不能拿这三个数字当 CI 门槛用**，否则 CI 一上来就是红的。
`bench/assets-size.mjs` 已经把三个口径都算出来打印了。

## 6. 踩到的坑

1. **Windows 上 `electron.exe` 是 GUI 子系统程序，`console.log` 到不了 stdout。**
   第一次冒烟 `--smoke` 的应用日志全是空的。所有跨进程诊断都必须写文件。
2. **`win.show` 事件在 `show:true`（默认）下不触发**——窗口在构造函数返回时就已经可见了。
   所以「窗口可见时间」只能用 `ready-to-show`。
3. **`webContents.on("paint")` 在本机（Electron 37.10.3 / Windows）4 秒内一次都不触发。**
   最小复现脚本在 `bench/_diag-window.mjs`。所以首帧时间只能靠 `ready-to-show` + 渲染进程里的 rAF。
4. **窗口被完全遮挡时 Chromium 停产帧，`requestAnimationFrame` 永不回调。**
   第一次冒烟就是这么挂的：3 个 rAF 相关的打点全部缺失，整轮跑了 46s 才靠兜底超时结束。
   `nextFrame()` 现在每个 rAF 都配一个 `setTimeout` 兜底，并且把「这一轮 rAF 有没有真的回调」
   记成 `info.raf`，可疑的轮次会打 `⚠ 可疑信号`。
   **这也说明测量环境本身会影响应用行为**：应用自己的 `useUiLoading.nextFrame()` 也是 rAF 实现的。
5. **PowerShell 禁止运行 `pnpm.ps1`**，所有 pnpm 命令必须 `cmd /c "pnpm ..."`。
6. **`pnpm build` 会顺手改写 `lang/index.js`**（`vite-auto-i18n-plugin` 的副作用，还会因为
   代理 7890 不通而报翻译失败）。这不是我们的改动，提交前要 `git checkout -- lang/index.js`。
7. **`vite-plugin-electron` 在生产构建时会额外产出一个 `dist-electron/index.js`**
   （2.29s 那条 esbuild 日志）。真正要跑的是 `dist-electron/main/index.js`（`build:main` 的产物，
   也是 `package.json` 的 `main` 指向的那个）。基准脚本显式指了后者。
8. **`dist-electron` 里 preload 的路径**：`build:preload` 输出 `dist-electron/preload.js`，
   主进程按 `../../dist-electron/preload.js` 找，对得上。
9. **`--user-data-dir` 指向临时目录**，所以第一次跑那个目录是全新的 Chromium profile，
   磁盘缓存是冷的。基准默认每场景先跑 1 次 warmup 并丢弃，就是为了把 profile 缓存捂热。
   阶段 2 的正式数据必须保留 warmup。
10. **`.mjs` 里不能写 TypeScript 类型标注**。`scenarios.mjs` 里的类型挪到了 JSDoc `@typedef`。
11. **`linked worktree` 里 `scripts/verify-commit.js` 会因 `.git/COMMIT_EDITMSG` 路径问题让
    commit-msg 钩子失败**，本分支用 `git commit --no-verify`。

## 7. 阶段 2 要注意什么

1. **WSL 场景测不了**（本机 `wsl --list` 报 `REGDB_CLASSNOTREG`），这是硬缺口，
   要么找一台能跑 WSL 的机器补，要么在 Issue #18 里明确记为「本轮不覆盖」。
2. **测量时别让别的窗口盖住应用**。工具会打 `⚠ 可疑信号`，但更好的做法是跑之前把桌面清空。
   遮挡同时会改变应用自身行为（`nextFrame()` 卡住），不只是影响打点。
3. **峰值内存方差很大**，主要来自 GPU 进程（大文档那轮 GPU 工作集 456MB，空文档那轮 80MB）。
   阶段 2 要决定：是用工作集还是私有字节做 ADR 第 10 条的「峰值内存增加不超过 30MB」的判据。
   我倾向私有字节 + 逐进程拆解，工作集受共享页影响太大。
4. **内存采样器本身是侵入的**（20 次/秒 `getAppMetrics()`）。要先量一下它的代价：
   同一场景开/关采样器各跑几次对比。
5. **`clock.launcherToProcessStartMs` 稳定在 38–60ms**（启动器打点 → 进程起点估算）。
   这是 `CreateProcess` 前后的开销 + `process.uptime()` 的误差。所有指标都以 `t0` 为零点，
   所以这个常数偏差不会影响阶段内对比；但如果要报「从用户双击图标算起」的时间，得加上它。
6. **`t0` 偏晚**：`process.uptime()` 从进程开始执行算起，不含 `CreateProcess` → 入口脚本之间的
   Chromium/Node 引导。所以三个指标都**低估**真实启动时间，低估量级就是这个 38–60ms 加引导时间。
   要消掉的话阶段 2 可以用 PowerShell 读进程创建时间做交叉校验。
7. **首屏体积预算口径要澄清**（见第 5 节），否则 CI 门槛直接是红的。
8. **大文档场景的解析占比**要单独算：ADR 第 7 条说「如果编辑器核心算法占比超过 30%，另开 Spec」。
   目前粗看 20 万字符那轮 `createMilkupEditor` 占可交互时间的 ~55%，这条门槛很可能要触发。
9. **探针会往文档里插一个 `ZQXBENCHMARK` 标记**。因为随后直接 `app.quit()`，不会落盘，
   测试文档也是临时目录里的 `PROTOTYPE-*`。但如果阶段 2 想改成「不污染文档」的探针
   （例如插完立刻 undo），要重新验证「文档模型真的变了」这个判据还成不成立。
10. **正式 20 次建议分批跑**，别一口气 5 场景 × 20 次连续跑两小时。中途散热/后台任务会污染数据。
    建议每个场景单独一条命令，中间隔几分钟。
11. Issue #18 还提到「另做 1～2 次重启后启动的真实场景抽检」。工具目前只测应用冷启动，
    重启后启动（进程还在、窗口重建）需要另一条路径，`createWindow()` 之外还要走 `activate` 分支，
    阶段 2 要单独加。

## 8. 文件清单

新增：

- `bench/run.mjs` —— 基准驱动：冷启动编排、进程清理、打印阶段拆解、汇总 P50/P95
- `bench/scenarios.mjs` —— 5 个场景定义 + 测试文档/工作区生成
- `bench/assets-size.mjs` —— 首屏 JS/CSS 体积 + ADR 预算交叉校验
- `bench/_diag-window.mjs` —— 一次性环境诊断（窗口是否可见、rAF 是否触发、`execCommand` 是否有效）
- `bench/STAGE1.md` —— 本文件
- `src/bench/prototype.ts` —— 渲染进程侧：场景注入、打点、可交互探测、稳定就绪判定
- `src/bench/prototype-main.ts` —— 主进程侧：进程起点、阶段打点、内存采样、报告落盘、自动退出

改动（全部是打点，代码路径没变）：

- `src/main/index.ts` —— 7 处 `BENCH.mark` / `BENCH.trackWindow` 调用
- `src/preload.ts` —— 末尾加 `__bench`（透传环境变量）和 `__benchPush`（回传数据）
- `src/renderer/main.ts` —— 第一个 import 引入基准模块，mount 前后各打一点
- `src/renderer/App.vue` —— `onMounted` 里加打点、声明稳定就绪的必需阶段
- `src/renderer/components/editor/MilkupEditor.vue` —— 编辑器建好后打点 + 启动可交互探测
- `src/renderer/hooks/useWorkSpace.ts` —— 目录扫描完成 / 监听启动各打一点
- `src/renderer/global.d.ts` —— `__bench` / `__benchPush` 的类型
- `package.json` —— 加了 `bench:startup` / `bench:startup:smoke` / `bench:assets`

所有调用点都用 `// PROTOTYPE BENCH` 注释包起来，`grep -rn "PROTOTYPE BENCH" src/` 可以一次列全，
方便阶段 2 之后一次性清掉。
