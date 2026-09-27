# Milkup 启动性能基线报告

> **PROTOTYPE / THROWAWAY。** 本文件与 `bench/`、`src/bench/` 以及 `src/` 里的打点调用点一样，
> 只为 Issue #18 采集基线数据。基线确认之后它们应该一起删掉。
>
> 阶段 1 的打点方案见 [`STAGE1.md`](./STAGE1.md)。本文件是阶段 2 的**正式数据**，
> 阶段 1 冒烟数据的时钟口径不同（见 §3.2），**不要和本文件的数字混着引用**。

---

## 1. 结论速览

| 项目 | 结果 |
| --- | --- |
| 主场景（普通文档）可交互时间 | **P50 771ms / P95 784ms**（min 754 / max 810 / σ 10.9，n=20，从**操作系统进程创建**算起） |
| 主场景窗口可见 | P50 635ms / P95 650ms |
| 主场景稳定就绪 | P50 1238ms / P95 1270ms |
| 时钟修正 | 阶段 1 的 `t0` 系统性**偏晚 32ms**（29.7–36.3ms，σ ≈1，n=69）。阶段 1 三个指标全部低估约 32ms。另有 183ms 的进程引导时间阶段 1 完全看不到。 |
| 两次独立构建 | 产物**逐文件 SHA256 完全一致**；同场景 P50 差 −4ms（−0.52%），P95 差 +6ms（+0.79%） |
| **ADR 第 7 条（编辑器核心 >30% 要另开 Spec）** | **不触发。** 主场景编辑器内核 21ms = 可交互的 **2.7%**；把整个编辑器组件算进去也只有 **9.7%**。最极端的大文档场景内核 18.2% / 组件 29.1%，仍未越过 30% |
| **ADR 第 9 条（首屏体积预算）** | **三项全 FAIL，且不是产物变大的问题。** 预算写下来之前的那个提交（`3c1f0d9`）就已经 FAIL。**这三个数字现在不能当 CI 门槛用**，见 §9 |
| ADR 第 10 条（内存） | 现有口径（全部进程工作集）方差主要来自 GPU 进程，**不适合当 CI 判据**。建议改用「Browser+Tab 私有字节」，批内 σ 0.4–2.2MB，见 §10 |
| WSL 场景 | **未测**，本机 WSL 不可用，硬缺口 |
| 重启后启动 | 走了 `activate` 分支，2 次抽检成功：**可交互 307ms**，约为冷启动的 40% |

---

## 2. 环境

| 项目 | 值 |
| --- | --- |
| 系统 | Windows 11 家庭中文版 10.0.26200（win32 x64） |
| CPU | AMD Ryzen 7 5800H，8 核 16 线程，基准频率 3.2GHz |
| 内存 | 16GB（Node 报 15724MB 可用） |
| 磁盘 | KIOXIA KB40ZNV512G NVMe SSD |
| 电源方案 | 平衡 |
| Electron | 37.10.3（Chromium 138.0.7204.251） |
| Node（主进程内） | 22.21.1 / V8 13.8.258.32-electron.0 |
| 驱动 Node（跑基准用） | v24.19.0 |
| 构建 | `pnpm build`（esbuild 主进程/preload + vite 7.3.6 渲染进程），**生产构建，未使用 dev server** |
| 基准分支 | `prototype/startup-benchmark`，基于 `0edfb93`（ADR 0001 所在提交） |

绝对路径：

- 仓库 worktree：`D:\dev\opencode2\Milkup\worktrees\startup-benchmark`
- 测试文档 / 工作区 / Chromium profile / 原始 JSON：`%TEMP%\milkup-bench-PROTOTYPE\`
  （实测 `C:\Users\runni\AppData\Local\Temp\milkup-bench-PROTOTYPE\`）

---

## 3. 方法

### 3.1 场景与轮次

| # | 场景 | 有效状态 | 轮次 |
| --- | --- | --- | --- |
| 1 | 空文档 | 不传文件参数，落在默认 Untitled tab；侧边栏关 | 5 |
| 2 | **普通文档（约 3000 字）· 主场景** | 命令行打开 `PROTOTYPE-normal.md`（3074 字符）；`startupPath:""`、侧边栏关 | 20 |
| 3 | 大文档 20 万字符 | 命令行打开 `PROTOTYPE-large.md`（200275 字符） | 5 |
| 4 | 无工作区 | **与场景 2 有效状态完全相同**（回归护栏，见 §6） | 5 |
| 5 | 本地工作区 | `startupPath` 指向 23 个 md + 3 子目录的目录，侧边栏自动展开 | 5 |
| 6 | WSL 工作区 | **未测**，本机 `wsl --list` 报 `REGDB_CLASSNOTREG` | 0 |

- 每个场景前跑 **1 次 warmup 并丢弃**（把临时 Chromium profile 的磁盘缓存捂热）。
- 每轮之间间隔 1500ms；每轮开始前确认本应用进程（按命令行匹配 `dist-electron/main/index.js`）**一个都不剩**。
- 合计**有效轮次 40**（另加 5 次 warmup，共 45 个 JSON），40/40 交互验证通过，
  0 轮触发任何可疑信号（全部 `ready-to-show` 触发、`visibilityState=visible`、rAF 全部真实回调）。

### 3.2 时钟口径：已修正为「从操作系统进程创建算起」

**阶段 1 的问题**：零点用 `performance.timeOrigin + performance.now() − process.uptime()×1000`。
Windows 上 `process.uptime()` 走 libuv 的 `uv_uptime()`，起点是**本进程第一次调用 `uv_uptime` 的时刻**，
不是 `CreateProcess` 时刻，所以这个零点必然偏晚。

**阶段 2 的做法**：报告写盘前（所有打点结束之后）用 PowerShell 调
`[System.Diagnostics.Process]::GetProcessById($PID).StartTime`，即 Windows `GetProcessTimes` 记录的
**进程创建时刻**，作为正式零点。

| 量 | 中位 | min / max | n |
| --- | --- | --- | --- |
| `t0` 比真实进程创建晚（**旧口径的系统性低估量**） | **31.8ms** | 29.7 / 36.3 | 69 |
| 进程创建 → 主进程 JS 开始执行（**旧口径完全看不到的一段**） | **182.8ms** | 179.3 / 198.3 | 69 |
| 启动器 `spawn` → 进程创建 | 4.7ms | — | 69 |
| WMI `Win32_Process.CreationDate` 与 `GetProcessTimes` 交叉校验差 | **1ms**（max 1ms） | — | 3 |

结论：

1. **阶段 1 的三个指标全部低估约 32ms**（主场景可交互 830ms 实际应为 862ms 量级）。
   偏差本身很稳（σ 1.1ms），是**常数偏移**，不影响阶段之间的相对比较。
2. 更重要的是那 **183ms 的 Electron/Node 引导时间**（进程创建 → 主进程 JS 第一行），
   阶段 1 完全没有测到。它占主场景可交互的 **23.7%**，是整条时间线上最大的一段。
3. 本报告之后所有时间数字**一律从操作系统进程创建算起**。原始 JSON 里同时保留两套口径
   （`marksMainFromCreateMs` / `marksMainFromT0Ms`），可交叉核对。
4. 零点是 OS 记录的创建时刻，粒度约 15.6ms（系统时钟粒度），比 32ms 的偏差小一个量级，不影响结论。
5. 注意：**从启动器 `spawn` 到进程创建只有 4.7ms**，所以「用户双击图标到进程创建」这一段
   在本基准里可以忽略；报告里的数字和「双击图标」的真实感知只差这 4.7ms + 桌面/外壳启动应用的时间。

### 3.3 测量环境修正（必须知道，否则数据会被误读）

基准是从控制台里拉起来的，控制台窗口会盖住 Electron 窗口。Windows 上窗口被判定为遮挡时
Chromium 停产帧，直接导致两个指标失真（实测「稳定就绪」被撑大 380ms，`ready-to-show` 干脆不触发）。

基准模式下做了三件事（**只在传了 `MILKUP_BENCH_RUN` 时生效，正常启动路径零影响**）：

1. 主进程启动参数加 `disable-backgrounding-occluded-windows`、`disable-renderer-backgrounding`、
   `disable-features=CalculateNativeWindowOcclusion`。
2. `BENCH.trackWindow()` 里 `win.setAlwaysOnTop(true, "floating")` + `show()` + `focus()`。
3. 报告里保留 `document.visibilityState`、`rAF 回调次数 / 兜底超时次数`，任何一轮被遮挡都会打
   `⚠ 可疑信号`。**本轮 45 轮全部 `visibilityState=visible`、rAF 全部真实回调、0 次兜底超时。**

代价（诚实说明）：**本基线不覆盖「窗口被完全遮住」这种真实但非目标的使用状态。**
在那种状态下 Chromium 会主动降频，真实耗时会比本基线更差。

### 3.4 其它已知偏差

- **可交互探针会往文档里插一个 `ZQXBENCHMARK` 标记**（走 `document.execCommand("insertText")`，
  和输入法同一条管线），插完直接 `app.quit()`，不落盘。测试文档也在临时目录里。
- 探针的判定时刻是「输入进管线并回读确认文档模型真的变了」，因此**包含应用自身事件接线
  （`change` / `selectionChange` 监听）和一次失败的首轮尝试**，实测约 12–35ms。
  这是一个**偏保守（偏大）**的「可交互」定义。
- 内存采样器每 50ms 调一次 `app.getAppMetrics()`（20 次/秒同步 IPC）。已单独量过代价：
  主场景 6 轮关采样器，可交互 P50 **775ms** vs 开采样器 **771/768ms**，差 ≤7ms，
  **小于批内 σ（≈10ms）——采样器可以忽略不计**。
- 场景 3（大文档）额外走了一帧 loading 遮罩（`await nextFrame()`），这部分是应用自己的行为，
  在帧正常产出的前提下计入。

---

## 4. 正式结果：三指标

> 全部从**操作系统进程创建时刻**算起。n = 去掉 warmup 后的有效轮次。
> P95 用线性插值（`rank = 0.95×(n−1)`）。
> **本节数字只来自 `build1` 这一批**（即按 Issue #18 规定的轮次跑出来的那一批：主场景 20 + 其余各 5）。
> §5 / §7 / §10 的分析会把 `build2`/`nosampler`/`clockcross` 一起并进来（主场景共 49 轮），
> 那一池的可交互 P50/P95 是 772/788ms，与本节的 771/784ms 一致（差 1–4ms，见 §8.2）。

### 4.1 主场景（普通文档，n=20）

| 指标 | P50 | P95 | min | max | mean | σ |
| --- | --- | --- | --- | --- | --- | --- |
| **可交互（主指标）** | **771ms** | **784ms** | 754ms | 810ms | 772ms | **10.9ms** |
| 窗口可见（`ready-to-show`） | 635ms | 650ms | 622ms | 672ms | 638ms | 9.8ms |
| 稳定就绪 | 1238ms | 1270ms | 1195ms | 1281ms | 1237ms | 25.8ms |

### 4.2 五个场景全表

| 场景 | n | 可交互 P50 | 可交互 P95 | 窗口可见 P50 | 窗口可见 P95 | 稳定就绪 P50 | 稳定就绪 P95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 空文档 | 5 | 615ms | 618ms | 631ms | 633ms | 1122ms | 1132ms |
| **2 普通文档（主）** | **20** | **771ms** | **784ms** | **635ms** | **650ms** | **1238ms** | **1270ms** |
| 3 大文档 20 万字符 | 5 | 1313ms | 1360ms | 670ms | 708ms | 1809ms | 1854ms |
| 4 无工作区 | 5 | 772ms | 783ms | 635ms | 647ms | 1217ms | 1266ms |
| 5 本地工作区 | 5 | 762ms | 793ms | 629ms | 662ms | 1248ms | 1261ms |

### 4.3 抖动（min / max / σ）

| 场景 | 可交互 min | max | σ | 窗口可见 σ | 稳定就绪 σ | 交互验证 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 空文档 | 613ms | 618ms | **2.0ms** | 2.3ms | 6.7ms | 5/5 |
| 2 普通文档 | 754ms | 810ms | **10.9ms** | 9.8ms | 25.8ms | 20/20 |
| 3 大文档 | 1245ms | 1367ms | **45.4ms** | 29.0ms | 64.0ms | 5/5 |
| 4 无工作区 | 758ms | 785ms | **8.9ms** | 7.0ms | 24.9ms | 5/5 |
| 5 本地工作区 | 753ms | 800ms | **17.3ms** | 17.9ms | 24.2ms | 5/5 |

**抖动结论**：

- 工具本身很稳。空文档 σ=2ms，主场景 σ=11ms。
- 大文档 σ=45ms（4 倍于主场景），主要来自 20 万字符的 DOM 布局与 GC，属于应用自身抖动。
- **稳定就绪的 σ 系统性高于可交互（2–3 倍）**，因为它包含系统字体枚举，受系统字体缓存状态影响。
- 45 轮（含 warmup）全部通过可交互验证，`ready-to-show` 全部触发，0 轮靠兜底口径。

---

## 5. 阶段拆解（主场景）

> **数据池 = 40 轮（build1）+ 20 轮（build2）+ 6 轮（nosampler）+ 3 轮（clockcross）= 49 轮**
> 主场景有效轮次（全部去掉 warmup）。
> 每段取批内中位数；占比取「逐轮比值」的中位数。
> **自检**：下面 A–D 这些段首尾相接，加起来正好等于可交互时间（49/49 轮偏差 ≤ 1ms），
> 所以这张表是完整分解，没有重叠也没有漏项。

| 段 | 中位耗时 | 占可交互 | 占稳定就绪 | 性质 |
| --- | --- | --- | --- | --- |
| A 进程创建 → 主进程 JS 开始执行 | **183ms** | **23.7%** | 14.7% | Electron/Node 引导 |
| A 主进程 JS → `app.whenReady` | 78ms | 10.1% | 6.3% | Electron/Chromium 初始化 |
| A `whenReady` → IPC 注册完 | 1ms | 0.1% | 0.1% | 主进程 |
| A IPC → `BrowserWindow` 构造完 | 41ms | 5.3% | 3.3% | Chromium 窗口/渲染进程创建 |
| A 构造完 → `loadFile` | 6ms | 0.8% | 0.5% | 主进程 |
| B `loadFile` → 渲染进程第一行 JS | **210ms** | **27.1%** | 16.9% | 首屏 HTML + JS 字节 |
| B 模块图求值 → `createApp()` 前 | 50ms | 6.4% | 4.0% | 首屏 JS 字节（求值） |
| B `createApp()` → `App.onMounted`（Vue 首次渲染，子组件 `onMounted` 就在此刻触发） | 16ms | 2.1% | 1.3% | Vue 首次渲染 |
| C `App.onMounted` → 主题/内边距/拼写配置完 | 11ms | 1.4% | 0.9% | 应用启动期配置 |
| C ⚠ 第一个编辑器 `onMounted` 早于父组件配置完 | **−11ms** | −1.4% | −0.9% | Vue 父子钩子顺序（负值） |
| C 第一个编辑器 `onMounted` → 构造完（空文档） | 21ms | 2.8% | 1.7% | 编辑器内核 |
| D 第一个编辑器构造完 → 第二个编辑器 `onMounted` | **112ms** | **14.4%** | 9.0% | IPC 派发文件 + 建第二个 tab |
| D 第二个编辑器 `onMounted` → 构造完（真文档 3074 字符） | 16ms | 2.1% | 1.3% | 编辑器内核 |
| D 第二个编辑器构造完 → **可交互** | 38ms | 4.9% | 3.1% | 事件接线 + 探针往返 |
| E `loadFile` → 窗口可见（`ready-to-show`） | 327ms | 42.4% | 26.3% | 合成器出帧（**另一条轴**，与 A–D 重叠） |
| F **可交互 → 稳定就绪** | **462ms** | 59.1% | 37.1% | 启动期后台任务 |
| F └ **系统字体枚举** | **387ms** | 50.2% | 31.1% | 启动期后台任务 |
| F └ 工作区扫描 | 13ms | 1.7% | 1.1% | 启动期后台任务 |

**一个反直觉但重要的发现**：Vue 的**子组件 `onMounted` 先于父组件 `onMounted` 触发**，
所以第一个编辑器的 `onMounted`（582ms）比 `App.vue` 的启动期配置完成（593ms）**早 11ms**。
表里那一行 −11ms 就是这个父子钩子顺序，不是测量错误。理解这点才能正确切分 Vue 侧的启动成本。

### 5.1 中位轮次的完整时间线

```
      0ms      0ms  [主] ← 操作系统进程创建时刻（本报告的零点）
    181ms    181ms  [主] m-main-module-eval            Electron/Node 引导
    259ms     78ms  [主] m-app-ready                    Chromium 初始化完成
    260ms      1ms  [主] m-ipc-registered
    301ms     41ms  [主] m-window-created               BrowserWindow 构造完
    308ms      6ms  [主] m-page-load-start              开始 loadFile
    517ms    209ms  [渲] r-module-eval                  首屏 HTML+2.3MB JS 解析执行
    566ms     49ms  [渲] r-before-mount                 其余模块图求值
    582ms     16ms  [渲] r-app-mounted                  App.onMounted（子组件 onMounted 已触发）
    592ms     11ms  [渲] r-theme-applied                主题应用
    593ms      0ms  [渲] r-other/spellcheck-applied     启动期配置完成
    593ms      0ms  [渲] r-after-mount                  app.mount() 返回
    633ms     40ms  [主] m-window-ready-to-show   ★窗口可见
    641ms      8ms  [主] m-window-maximized
    644ms      3ms  [主] m-launch-file-dispatched       命令行文件派发给渲染进程
    716ms     70ms  [渲] r-editor-mounted-begin  [第1次] 空文档编辑器 onMounted
    719ms      3ms  [渲]   r-editor-create-enter
    719ms      0ms  [渲]   r-core-ctor-begin
    723ms      4ms  [渲]   r-core-parse-done             Markdown 解析
    725ms      2ms  [渲]   r-core-state-done             EditorState + 插件链
    729ms      4ms  [渲]   r-core-view-done              EditorView + DOM + 装饰
    732ms      3ms  [渲]   r-core-searchpanel-done       插件初始化收尾
    732ms      0ms  [渲]   r-editor-instance-created
    772ms     40ms  [渲] r-input-dispatched      ★可交互（主指标）
    785ms     13ms  [渲] r-workspace-resolved           工作区扫描完成
    820ms     35ms  [渲] r-input-verified               可交互回读确认
  1.16s    335ms  [渲] r-fonts-resolved                系统字体枚举完成
  1.16s      0ms  [渲] r-stable-ready-tasks-done
  1.20s     46ms  [渲] r-stable-ready           ★稳定就绪
```

### 5.2 归类小结

从进程创建到**可交互**（772ms）可以切成互不重叠的几块（合计正好 772ms）：

| 块 | 耗时 | 占比 | 能不能动 |
| --- | --- | --- | --- |
| A Electron/Node/Chromium 固定开销 | **309ms** | **40.0%** | 应用层几乎动不了 |
| B 首屏字节（HTML 解析 + 2.3MB JS 拉取/求值） | **260ms** | **33.7%** | **能动**，对应 ADR 第 9 条体积预算 |
| Vue 首次渲染 + 启动期配置 | 27ms | 3.5% | 能动（收益小） |
| Vue 父子钩子顺序（负） | −11ms | −1.4% | 不可动（框架行为） |
| 编辑器内核（两次构造） | 37ms | 4.8% | 见 §7 |
| IPC 派发文件 + 建第二个 tab | **112ms** | **14.5%** | **能动**（见 §7.3，和「建两次编辑器」是同一件事） |
| 事件接线 + 探针往返 | 38ms | 4.9% | 探针定义本身有偏保守成分 |

**最大的一块不是应用代码，是 Electron 冷启动（309ms，40%）和首屏字节（260ms，34%）。**
这两个加起来占 73.7%，其中首屏字节那一半是应用唯一能真正控制的大头。

**稳定就绪比可交互多出的 462ms 里，387ms（84%）是系统字体枚举**，
完全落在可交互之后——这和 Issue #18 预研线索里 PowerShell 字体枚举 471–701ms 对得上。
字体枚举只影响稳定就绪，不影响主指标，这正是 ADR 第 6 条要解决的。

---

## 6. 回归护栏：场景 2 vs 场景 4

场景 2（普通文档）和场景 4（无工作区）**有效状态完全相同**，唯一区别是 localStorage 里
有没有留下过「曾经配过工作区」的痕迹。两者数字之差 = **工具自身方差**。

| 指标 | 场景 2（n=20） | 场景 4（n=5） | 差值 |
| --- | --- | --- | --- |
| 可交互 P50 | 771ms | 772ms | **+1ms（+0.1%）** |
| 可交互 σ | 10.9ms | 8.9ms | — |

两者在 P50 上差 1ms，护栏通过。**但要注意**：两批数据在时间上相隔约 2.5 分钟
（场景 2 的 20 轮跑完之后才跑场景 4），所以这个「1ms」里也包含了机器状态漂移。
可以下的结论是「工具方差在 1% 量级，不会把 5% 级的优化收益吃掉」；
**不能**用它论证「工具方差小于 1ms」。

---

## 7. 编辑器核心占比与 ADR 第 7 条

ADR 第 7 条：「本轮不重构 Markdown 解析器、语法标记、装饰器或 ProseMirror 插件。
**如果这些部分实测占比超过 30%，另开 Spec。**」

口径：在 `MilkupEditor` 构造函数内按「解析 / EditorState+插件链 / EditorView+DOM+装饰器 /
插件初始化」四段打点（`r-core-*`）。注意 **启动期会构造两次编辑器**：先一个空文档（默认
Untitled tab），命令行文件到达后再建一个真文档。两者都算进「启动路径上的编辑器核心开销」。

| 场景 | 构造次数 | 内核合计 | 占可交互 | 编辑器组件全流程 | 占可交互 |
| --- | --- | --- | --- | --- | --- |
| 1 空文档 | 1（0 字符） | 9ms | **1.4%** | 23ms | 3.7% |
| **2 普通文档（主）** | 2（0 + 3074 字符） | **21ms** | **2.7%** | **75ms** | **9.7%** |
| 3 大文档 20 万字符 | 2（0 + 200275 字符） | 239ms | **18.2%** | 382ms | **29.1%** |
| 4 无工作区 | 2（0 + 3074 字符） | 21ms | 2.7% | 77ms | 10.0% |
| 5 本地工作区 | 2（0 + 3074 字符） | 21ms | 2.7% | 74ms | 9.7% |

主场景逐次拆开：

```
第 1 次构造（0 字符）    ：内核 8ms  = 解析 1 + 插件链 3 + 建 view 4 + 插件初始化 1
第 2 次构造（3074 字符）：内核 12ms = 解析 4 + 插件链 2 + 建 view 4 + 插件初始化 3
编辑器组件全流程合计 75ms（含 createEditorInstance 的事件接线、outline 初始化等）
```

### 7.1 判断：**ADR 第 7 条不触发**

- 主场景（也就是 ADR 第 2 条里 P95 缩短 25% 所针对的那个场景），
  编辑器核心只占可交互时间的 **2.7%**；即使把整个 `MilkupEditor` 组件的前后流程都算进去
  也只有 **9.7%**。离 30% 差一个数量级。
- 最极端的大文档场景内核 18.2%、组件全流程 29.1%，**仍未越过 30%**，
  而且这是 65 倍输入规模的极端输入，不是日常场景。
- 结论：本轮可以按第 7 条放心做「不碰编辑器内核」的优化。
  **即便把所有编辑器内核时间全部优化掉，主场景 P95 只能从 784ms 降到约 770ms（−1.8%）**，
  远达不到第 2 条要求的 25%。真正的大头在 §5.2 的 A 段和 B 段。

### 7.2 「启动路径上的解析开销」vs「大文档专属的输入规模成本」

这两者必须分开，否则会用大文档的数字去论证一件对日常场景不成立的事。

| | 空文档那次（固定开销） | 普通文档那次（3074 字符） | 大文档那次（200275 字符） |
| --- | --- | --- | --- |
| Markdown 解析 | 1ms | 4ms | **65ms** |
| EditorState + 插件链 | 3ms | 2ms | **46ms** |
| EditorView + DOM + 装饰器 | 4ms | 4ms | **99ms** |
| 插件初始化 + tooltip + 搜索面板 | 1ms | 3ms | **32ms** |
| **内核合计** | **8ms** | **12ms** | **242ms** |

- **启动路径上的固定开销 ≈ 8ms**（空文档那次，和输入规模无关）。
- 3000 字符的真实解析成本 **12ms**，占主场景可交互的 1.6%。
- 输入规模从 3074 → 200275 字符（**65 倍**），内核耗时从 12ms → 242ms（**20 倍**），
  多出 230ms。大文档场景比普通文档慢 541ms，其中 **230ms（43%）是编辑器内核**，
  剩下 311ms 在更大的 DOM、布局、outline 遍历、loading 遮罩那一帧等处。
- 也就是说：**大文档比普通文档多出来的那 541ms 里，只有约 43% 是「解析」，
  且这部分与 ADR 第 7 条无关（它属于极端输入规模，不是启动路径常态）。**

### 7.3 顺带发现的一个真实问题（不在本轮范围，但值得记）

**启动期把整个编辑器核心构造了两次**：先建一个空文档编辑器（8ms 内核 + 23ms 组件全流程），
命令行文件到达后（§5 表里那段 112ms）再建一个真文档编辑器。为了打开一个文件，
先白建一次完整编辑器实例。**这 112ms 里既有建第二个 tab 的开销，也有第一次白建的开销**，
按 ADR 第 2 条的门槛（≥50ms 且 ≥3%），它是本轮唯一一个「不碰编辑器内核、
量级又够门槛」的方向。本轮**只记录，不做**。

---

## 8. 两次独立构建复现

### 8.1 产物层面：完全一致

| 项目 | 结果 |
| --- | --- |
| 构建 1 | `git checkout lang/index.js` + 删 `dist`/`dist-electron`/`node_modules/.vite` + `pnpm build` |
| 构建 2 | 同上，完全重来 |
| 逐文件对比（130 个产物：`dist/assets/*` + `dist/index.html`） | **文件名、字节数、SHA256 全部相同** |
| 指纹存档 | `bench/builds/build1/manifest.txt`、`bench/builds/build2/manifest.txt` |

**这条比预期更强**：Vite 生产构建在这个仓库里是确定性的，构建之间**产物层面方差为 0**。
所以 ADR 第 2 条要求的「两次独立构建中复现」，对本项目来说本质上等价于
「两批独立测量中复现」——因为两次构建出来的是同一份字节。

### 8.2 测量层面（主场景，各 20 轮 + 1 warmup）

| 批次 | n | 可交互 P50 | 可交互 P95 | σ | min | max |
| --- | --- | --- | --- | --- | --- | --- |
| 构建 1 | 20 | 771ms | 784ms | 10.6ms | 754ms | 810ms |
| 构建 2 | 20 | 768ms | 789ms | 9.8ms | 761ms | 802ms |
| **差值** | — | **−4ms（−0.52%）** | **+6ms（+0.79%）** | — | — | — |
| 追加：关内存采样器 | 6 | 775ms | 787ms | 8.0ms | 764ms | 788ms |

### 8.3 这决定了后续优化要多大幅度才算真实收益

- 批内 σ ≈ 10ms，批间 P50 差 4ms、P95 差 6ms，都远小于 ADR 第 2 条要求的
  「至少节省 50ms / 至少提升 3%」。**换句话说，门槛定在 50ms 是合理的、留足了余量的**，
  本机这套工具能稳定分辨 50ms 级的差异（约 5σ）。
- 建议后续判据按这个用：**同一场景、同一台机器、同一批 profile，跑满 20 轮，比较 P50 和 P95，
  同时要求 P95 下降 ≥ 3% 且 ≥ 50ms，并复现一批。** 单轮或 5 轮数据不要用来下收益结论。
- 注意：这是**单机**结论。换机器（尤其 CPU 差异）后 σ 会变，门槛要重新标定。

---

## 9. 首屏体积与 ADR 第 9 条

### 9.1 实测（当前构建，口径 = `dist/index.html` 显式引用的资源）

| 资源 | 原始 | Gzip |
| --- | --- | --- |
| `assets/main-BoLMQNP7.js`（入口 `<script type=module>`） | 277.2 KB | 91.1 KB |
| `assets/theme-main-Blr_GU7W.js`（`<link rel=modulepreload>`，入口的静态依赖 chunk） | 2.026 MB | 0.682 MB |
| `assets/theme-main-bEVEDN9h.css` | 73.4 KB | 15.6 KB |
| `assets/main-CwMXMRTN.css` | 137.0 KB | 20.2 KB |
| **首屏 JS 合计** | **2.297 MB（2352.3 KB）** | **0.771 MB（789.8 KB）** |
| **首屏 CSS 合计** | 0.205 MB | **35.9 KB** |
| （参考）`dist/assets` 全部 67 个 js | 5.341 MB | 1.638 MB |

### 9.2 三项预算：全 FAIL

```
FAIL  首屏 JS 原始   实际 2352.3 KB  预算 2150.4 KB（2.1MB）  超出 201.9 KB（+9.4%）
FAIL  首屏 JS Gzip   实际  789.8 KB  预算  720.0 KB          超出  69.8 KB（+9.7%）
FAIL  首屏 CSS Gzip  实际   35.9 KB  预算   30.0 KB          超出   5.9 KB（+19.7%）
```

### 9.3 是口径问题还是产物变大了？——**是预算本身对不上，不是产物变大**

**证据一：和写预算之前的那个提交比，产物几乎没变。**
`0edfb93`（ADR 0001 所在提交）的父提交是 `3c1f0d9`。用现成的 `3c1f0d9` 构建产物对比：

| 指标 | 当前 | 3c1f0d9 | 差值 | 相对 |
| --- | --- | --- | --- | --- |
| 首屏 JS 原始 | 2.297 MB | 2.291 MB | **+5936 B** | **+0.25%** |
| 首屏 JS Gzip | 0.771 MB | 0.769 MB | +2623 B | +0.33% |
| 首屏 CSS Gzip | 35.9 KB | 35.9 KB | −1 B | 0.00% |
| assets 里 js 个数 | 67 | 67 | 0 | 0.00% |

而 `3c1f0d9` 的产物**同样是三项全 FAIL**（2351.4 / 787.3 / 35.9 vs 预算 2150.4 / 720 / 30）。
**预算被写下来的时候就已经 FAIL 了。** 而且当前这 +5.9KB 的增长正好是本基准原型
（`src/bench/` + `src/core/editor.ts` 里的打点）打进首屏的体积——基准原型删掉后会回到基线值。
*（口径说明：`3c1f0d9` 的 dist 是 `editor-zoom-pr` worktree 里已有的产物，我只读不写；
该 worktree `git status` 只有 `lang/index.js` 被构建改写，src 是干净的 3c1f0d9。
严格做法是在干净 worktree 里重新构建一遍复核。）*

**证据二：`theme-main-*.js` 是首屏真正要加载的，不是被 modulepreload 提前拉进来的。**

```
$ grep -o 'from"\./theme-main-[^"]*"' dist/assets/main-BoLMQNP7.js | head -1
from"./theme-main-Blr_GU7W.js"
```

入口 chunk 对它的是**静态 import**，不是 `import()`。按 ES 模块语义，
`theme-main-*.js` 没有下载并求值完，入口模块体一行都不会执行。
`r-module-eval`（渲染进程第一行 JS）能跑起来，就证明这个 2.026MB chunk 已经加载完成。
`<link rel="modulepreload">` 只是 Vite 对这个静态依赖的**并行下载提示**，不是「可选预取」。

（想拿运行时证据也拿不到：Chromium 的 DevTools `Network` 域和 `Page.getResourceTree`
都不上报 `file://` 的 ES module 加载，`performance.getEntriesByType("resource")` 在 `file://`
下返回空数组——这三条路都试过了。静态 import + 模块求值顺序是这里的决定性证据。）

### 9.4 三种口径下的预算校验

| 口径 | 首屏 JS 原始 | 首屏 JS Gzip | 首屏 CSS Gzip |
| --- | --- | --- | --- |
| **A 入口 + modulepreload chunk + 全部 CSS**（本工具默认，唯一说得通的口径） | FAIL 2352.3 / 2150.4 | FAIL 789.8 / 720.0 | FAIL 35.9 / 30.0 |
| B 入口 + 全部 CSS（不含 modulepreload chunk） | PASS 277.2 | PASS 91.1 | FAIL 35.9 |
| C 只有入口 script | PASS 277.2 | PASS 91.1 | 不适用 |

**判断：ADR 第 9 条的三个数字对不上任何一种说得通的口径。**

- 口径 B/C 下 JS 会**大幅超标**（预算 2.1MB 相当于给 277KB 的入口留了 7.7 倍余量），
  这不是一个「CI 门槛」该有的样子——门槛要卡住回归，不是永远 PASS。
- 口径 A 下三项都以 **9%–20%** 的幅度 FAIL，且在写预算时就已经 FAIL。
- CSS 那 30KB 无论哪种口径都 FAIL（35.9KB），说明预算不是照着「只算某一份 CSS」写的。

### 9.5 结论与建议

1. **这三个数字现在不能直接当 CI 门槛用**，一上线 CI 就是红的，而且红得没有意义
   （它卡的是历史遗留，不是新引入的回归）。
2. 建议把 ADR 第 9 条改成：**先固定口径 A（明确写成「`index.html` 显式引用的全部资源：
   入口 module script + 其静态依赖 chunk + 全部 stylesheet」），再按当前产物 + 5% 余量重设预算**：
   - 首屏 JS 原始 ≤ 2.45 MB（当前 2352.3 KB）
   - 首屏 JS Gzip ≤ 810 KB（当前 789.8 KB）
   - 首屏 CSS Gzip ≤ 38 KB（当前 35.9 KB）
   这三个数字才有卡回归的意义。**改 ADR 预算不在本轮范围内，需要你拍板。**
3. 顺带：`theme-main-*.js` 一个 chunk 就占首屏 JS 的 **88%**（2.026 / 2.297 MB）。
   首屏 JS Gzip 预算超了 9.7%，几乎全部来自它。按需拆包本身是有效的
   （全部 67 个 js 共 5.341MB，首屏只吃 45%），但**这个 chunk 内部装了什么值得单独查**
   （codemirror 语言包 / 主题 / 编辑器 schema 都在里面），这是本轮之后最大的单一体积优化方向。

---

## 10. 峰值内存与 ADR 第 10 条

ADR 第 10 条：「峰值内存增加不超过 30MB，典型启动增加不超过 10MB。」这是**增量**判据，
所以先要确定一个方差足够小、能当增量基线的**口径**。

### 10.1 用了什么口径

主进程每 50ms 调一次 `app.getAppMetrics()`，对**全部** Electron 进程
（Browser / Tab / GPU / Utility）分别求和，记两套：

- **工作集** `memory.workingSetSize` —— OS 视角的驻留物理页，含共享页
- **私有字节** `memory.privateBytes` —— 该进程独有的提交内存

取启动全程（从进程创建到报告写盘）的最大值作为「峰值内存」，并保存峰值时刻的逐进程拆解；
另外在「窗口可见」「可交互」「稳定就绪」三个里程碑各取一次「该时刻之前的最大值」。

采样器侵入代价：已量化，**≤7ms，小于 σ**（§3.4），可以忽略。

### 10.2 实测（n 与 §4 相同）

| 场景 | 工作集峰值 中位 (min–max) | 私有字节峰值 中位 | 可交互时刻 工作集 / 私有 | Browser+Tab 私有 中位 |
| --- | --- | --- | --- | --- |
| 1 空文档 | 420MB (419–423) | 282MB | 347MB / 181MB | **101MB** |
| 2 普通文档 | 472MB (447–490) | 372MB | 395MB / 242MB | **141MB** |
| 3 大文档 | 718MB (715–737) | 673MB | 627MB / 574MB | **232MB** |
| 4 无工作区 | 475MB (474–480) | 375MB | 401MB / 279MB | **143MB** |
| 5 本地工作区 | 476MB (456–489) | 404MB | 393MB / 271MB | **146MB** |

中位轮次的逐进程拆解（峰值时刻）：

| 场景 | Browser 工作集/私有 | Tab 工作集/私有 | GPU 工作集/私有 | Utility 工作集/私有 |
| --- | --- | --- | --- | --- |
| 1 空文档 | 116 / 45MB | 109 / 56MB | **150 / 168MB** | 48 / 13MB |
| 2 普通文档 | 118 / 80MB | 118 / 62MB | **187 / 221MB** | 48 / 13MB |
| 3 大文档 | 119 / 80MB | **207 / 151MB** | **358 / 442MB** | 48 / 13MB |

### 10.3 哪个口径能当 CI 判据

批内标准差（同一场景多轮之间）：

| 场景 | 工作集合计 σ | 私有字节合计 σ | **Browser+Tab 私有 σ** |
| --- | --- | --- | --- |
| 1 空文档 | 1.3MB | 1.1MB | **0.4MB** |
| 2 普通文档 | 7.1MB | 5.2MB | **1.9MB** |
| 3 大文档 | 9.0MB | 9.9MB | **1.2MB** |
| 4 无工作区 | 2.2MB | 2.7MB | **1.7MB** |
| 5 本地工作区 | 12.8MB | 2.3MB | **2.2MB** |

**判断：**

1. **GPU 进程是方差的主要来源，也和应用没关系。** 阶段 1 记录过 GPU 工作集 80MB–456MB
   的巨大跨度；本轮在修正了窗口遮挡（§3.3）之后收敛到 150–358MB，但仍然是唯一的大方差项，
   而且它随机器的 GPU 驱动、屏幕分辨率、其它程序抢 GPU 而变。**把 GPU 算进 CI 判据 = 判据必假。**
2. **工作集整体也不适合**：它含共享页，受系统页缓存和共享 DLL 影响，σ 1.3–12.8MB。
3. **建议 ADR 第 10 条的口径改成「Browser + Tab 两个进程的私有字节」**：
   - 正好是跑应用代码的两个进程（主进程 + 渲染进程）
   - 批内 σ 只有 **0.4–2.2MB**，而 ADR 的门槛是 10MB / 30MB，判据有 5–75 倍余量
   - 跨场景的量级差异也读得出来：空文档 101MB → 普通文档 141MB → 大文档 232MB，
     大文档比普通文档多 91MB，落在「峰值增加不超过 30MB」的量级附近，说明这条判据不是摆设
4. Utility 进程（48/13MB）很稳定，可以并入也可以剔除，不影响结论。
5. **注意这些绝对值是在 §3.3 的帧修正配置下测的**。遮挡修正会改变 GPU 的行为，
   所以「工作集 472MB」这类数字换到别的测量配置下会变；Browser+Tab 私有字节受影响小得多，
   这也是选它的另一个理由。
6. 采样只在 Windows 上验证过。macOS/Linux 的 `getAppMetrics` 字段口径不同，
   ADR 第 8 条说不承诺这两个平台的百分比，内存门槛也建议只对 Windows 设。

---

## 11. 重启后启动抽检（`activate` 分支）

**做成了，但只做到了「代码路径抽检」，不是「真实双击图标」抽检。** 说清楚区别：

### 11.1 做法

1. 冷启动到稳定就绪（和 §4 主场景完全一样）。
2. 销毁唯一窗口 → `app.emit("activate")` → 走 `src/main/index.ts` 里 `activate` 分支的
   `createWindow()` 重新建窗。
3. 第二个渲染进程从零开始跑同一套打点，零点 = `app.emit("activate")` 那一刻。

两个必须说明的妥协：

- **Windows 上「进程还在、窗口全没了」这个状态默认活不下来**：`window-all-closed` 会直接
  `app.quit()`。为了能真正走到 `activate` 分支，基准代码在销毁窗口那几百毫秒内
  临时把 `app.quit` 换成空操作，新窗口建起来后立刻恢复。**这不碰冷启动路径**（冷启动全程
  `app.quit` 都是原版），但它确实是一次合成触发，不是真的用户双击。
- **`activate` 分支不调用 `sendLaunchFileIfExists()`**，所以重启后开的是**空文档**，
  没有命令行文件。这条分支在真实使用中（macOS 从 Dock 唤起）就是这个行为。
  因此它应该和**场景 1（空文档）**比，不是和场景 2（普通文档）比。

### 11.2 结果（2 次抽检，σ 极小）

| 指标 | 重启后启动（零点 = activate） | 对比：冷启动空文档 | 对比：冷启动普通文档 |
| --- | --- | --- | --- |
| 可交互 | **307ms** (305.8 / 308.1) | 615ms | 771ms |
| 窗口可见 | **323ms** (321.8 / 323.9) | 631ms | 635ms |
| 稳定就绪 | **772ms** (766.8 / 777.5) | 1122ms | 1238ms |

**读出来的结论**：重启后窗口重建比冷启动快约 **2 倍**（可交互 307ms vs 615ms 空文档）。
省掉的是 §5 里 A 段的绝大部分（183ms 进程引导 + 78ms `app.whenReady` + 40ms 渲染进程创建 ≈ 300ms），
剩下的 B 段（首屏 2.3MB JS）和 C 段（Vue 挂载 + 编辑器构造）一分钱没省——
**这说明首屏字节和应用启动期工作是真正的可优化项，而 Electron 冷启动开销不是。**

n=2，只能当量级参考，不能当 P50/P95。

---

## 12. 缺口与不可信项

### 12.1 硬缺口

| 缺口 | 原因 | 影响 |
| --- | --- | --- |
| **WSL 工作区场景（场景 6）未测** | 本机 WSL 不可用（`wsl --list` 报 `REGDB_CLASSNOTREG`） | ADR 第 5 条关于 WSL 工作区的分支**完全没有基线**。要么找一台能跑 WSL 的机器补，要么在 Issue #18 里明确写「本轮不覆盖」 |
| 「重启后启动」只做到代码路径抽检 | Windows 上必须合成触发 `activate`（见 §11.1） | 数字可用作量级参考，不能当作真实用户场景的 P50 |

### 12.2 我认为不可信 / 需要打折的数字

| 数字 | 为什么打折 |
| --- | --- |
| **阶段 1 冒烟数据（830ms 等）** | 时钟零点偏晚 32ms，且测量环境被窗口遮挡污染。**不要引用** |
| **「窗口可见」这个指标本身** | 它取 `ready-to-show`，而 `ready-to-show` 等的是**合成器出帧**，不是应用做完。所以空文档场景它（631ms）反而**晚于**可交互（615ms）。它反映的是「用户什么时候能看见窗口」，但它的值被帧生产支配，不能用来判断应用侧优化效果 |
| **大文档场景（场景 3）的 n=5** | σ=45ms，是主场景的 4 倍。5 轮定 P95 很勉强（P95 由最慢那一轮主导）。要定这个场景的门槛至少要 20 轮 |
| **场景 4 vs 场景 2 的 1ms 差值** | 两批相隔 2.5 分钟，含机器漂移。只能说「工具方差在 1% 量级」，不能说「小于 1ms」 |
| **所有内存绝对值** | 在 §3.3 的帧修正配置下测的。GPU 那一列尤其依赖这个配置。Browser+Tab 私有字节受影响小 |
| **单平台结论** | 只有 Windows 11 + 这台机器。ADR 第 8 条本来就不承诺 macOS/Linux 相同百分比，但**「优化收益 25%」这个目标本身也只在 Windows 上验证过** |
| **`3c1f0d9` 产物对比** | 复用了别的 worktree 里已有的 dist（只读），没有自己重新构建复核。src 状态是干净的，但严格说缺一次独立重建 |
| **「可交互」的定义偏保守** | 探针的回读确认 + 一次失败的首轮尝试约 12–35ms 计入。真实用户「能开始打字」的时刻可能比这个数早十几毫秒。**这对基线无害**（所有对比都用同一定义），但不要把它当成「用户按键生效延迟」 |
| **CI 门槛不能用 §9 的三个数** | 见 §9.5 |

### 12.3 这套基线能用来做什么、不能用来做什么

**能**：
- 判断「某个优化在主场景省了多少 ms」，前提是同机、同 profile、跑满 20 轮、比 P50 和 P95。
- 判断「有没有把某个场景搞慢」（回归护栏场景 4 就在干这个）。
- 给 ADR 第 7 条一个明确的量化依据（编辑器核心 2.7%）。

**不能**：
- 跨机器比较绝对值。
- 用 5 轮数据定 P95。
- 拿「窗口可见」当优化目标。
- 覆盖 WSL 工作区、窗口被遮挡、macOS/Linux。

---

## 13. 原始数据与复现

### 13.1 原始 JSON 路径（不要删）

根目录：`%TEMP%\milkup-bench-PROTOTYPE\`（实测 `C:\Users\runni\AppData\Local\Temp\milkup-bench-PROTOTYPE\`）

| 路径 | 内容 |
| --- | --- |
| `runs\build1\summary.json` + 45 个 `build1-*.json` | **正式基线数据**（主场景 20 + 其余各 5，含 5 次 warmup 的 JSON） |
| `runs\build2\summary.json` + 21 个 `build2-*.json` | 第二次独立构建的复现数据（主场景 20） |
| `runs\restart\summary.json` + 2 个 JSON | 重启后启动（`activate`）抽检 |
| `runs\nosampler\summary.json` + 7 个 JSON | 关内存采样器的对照 |
| `runs\clockcross\summary.json` + 3 个 JSON | 时钟双来源（WMI 交叉校验） |
| `runs\smoke2..5, netprobe, netprobe2\` | 调试用，噪声，可删 |
| `build1-console.log` / `build2-console.log` / `restart-console.log` / `nosampler-console.log` / `clockcross.log` / `analyze.log` | 完整控制台输出 |
| `docs\PROTOTYPE-normal.md` / `docs\PROTOTYPE-large.md` | 测试文档 |
| `workspace\` | 场景 5 的工作区（23 个 md + 3 个子目录） |
| `profile\` | 基准专用 Chromium profile（与用户真实配置隔离） |

每轮一个 JSON 里的关键字段：

- `clock.*` —— 两套时钟口径、`t0MinusOsCreateMs`、WMI 交叉校验差
- `marksMainFromCreateMs` / `marksRendererFromCreateMs` —— 正式口径的阶段打点
- `marksMainFromT0Ms` / `marksRendererFromT0Ms` —— 阶段 1 旧口径，用于交叉核对
- `marksMainAbs` / `marksRendererAbs` —— 绝对墙钟
- `rendererInfo.metricAnchor` / `metricAnchorFromT0` —— 三个指标
- `rendererInfo.metricAnchorRound2FromActivate` —— 重启后启动那轮
- `rendererInfo.events` —— **全量有序打点流水**（同名打点不会被覆盖，阶段拆解和编辑器逐次构造都靠它）
- `rendererInfo.memoryMilestones` / `memory.peak` / `memory.peakPrivate` / `memory.samples`
- `rendererInfo.raf` / `rendererInfo.interactive` —— 帧健康度和交互验证证据

### 13.2 阶段 2 新增/改动的工具

| 文件 | 作用 |
| --- | --- |
| `bench/analyze.mjs` | 离线分析：阶段拆解（含「A–D 段求和 == 可交互」自检）、编辑器核心逐次构造拆解、峰值内存逐进程 σ、时钟统计、批次对比 |
| `bench/run.mjs` | 新增 `--label`（每批数据独立目录）、`--mode=activate`、`--nosampler`、`--clockcross`、`--netprobe`；汇总输出 P50/P95/min/max/mean/σ 并落 `summary.json` |
| `bench/assets-size.mjs` | 新增三种「首屏」口径对照（`printCalibers`）和两 dist 体积对比（`printDiff`） |
| `src/bench/prototype-main.ts` | 改用 OS 进程创建时刻作零点（+WMI 交叉校验）；内存峰值记工作集/私有两套 + 三个里程碑快照；`activate` 模式重启抽检；帧修正开关 |
| `src/bench/prototype.ts` | 渲染进程带 `session` 标识、`events` 全量有序流水；暴露全局 `__benchMark` |
| `src/core/editor.ts` | 编辑器构造函数内 4 段打点（`r-core-*`，走全局函数，**不加 import，不改模块图**） |
| `src/renderer/components/editor/MilkupEditor.vue` | 编辑器组件 4 个打点（onMounted / createEditorInstance 进出口） |
| `bench/builds/build{1,2}/manifest.txt` | 两次构建的 130 个产物指纹（文件名 + 字节数 + SHA256） |

### 13.3 复现命令

```powershell
chcp 65001 >$null; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
cd D:\dev\opencode2\Milkup\worktrees\startup-benchmark

# 构建（会顺手改写 lang/index.js，提交前记得 git checkout -- lang/index.js）
git checkout -- lang/index.js
Remove-Item -Recurse -Force dist, dist-electron -ErrorAction SilentlyContinue
if (Test-Path node_modules\.vite) { Remove-Item -Recurse -Force node_modules\.vite }
cmd /c "pnpm build"

# 正式基线：主场景 20 次 + 其余各 5 次
cmd /c "pnpm bench:startup" -- --label=build1 --gap=1500

# 第二次独立构建 + 复现
git checkout -- lang/index.js
Remove-Item -Recurse -Force dist, dist-electron -ErrorAction SilentlyContinue
if (Test-Path node_modules\.vite) { Remove-Item -Recurse -Force node_modules\.vite }
cmd /c "pnpm build"
node bench\run.mjs --label=build2 --scenarios=normal --gap=1500

# 重启后启动抽检（activate 分支）
node bench\run.mjs --label=restart --scenarios=normal --repeat=2 --warmup=0 --mode=activate --gap=1500

# 关内存采样器对照
node bench\run.mjs --label=nosampler --scenarios=normal --repeat=6 --nosampler

# 时钟双来源交叉校验
node bench\run.mjs --label=clockcross --scenarios=normal --repeat=3 --clockcross

# 离线分析（阶段拆解 / 编辑器核心占比 / 内存 / 两次构建对比）
node bench\analyze.mjs build1,build2,nosampler,clockcross

# 首屏体积：三种口径 + 与 3c1f0d9 基线产物对比
node bench\assets-size.mjs
node bench\assets-size.mjs "D:\dev\opencode2\Milkup\worktrees\startup-benchmark\dist" "D:\dev\opencode2\Milkup\worktrees\editor-zoom-pr\dist"
```

工具的用法和踩过的坑见 [`STAGE1.md`](./STAGE1.md)；阶段 2 新增的开关见各文件顶部注释。

---

## 14. 给 Issue #18 的落地建议（基于本基线）

1. **主场景 P95 = 784ms，目标缩短 25% → 588ms，要砍 196ms。** 按 §5.2 的归类，
   可动的块是 B 段首屏字节（260ms）和 D 段「IPC 派发文件 + 建第二个 tab」（112ms），
   编辑器内核（37ms）按 ADR 第 7 条不用碰。Electron 冷启动那 309ms（40%）应用层动不了。
   **注意：能动的块加起来只有约 372ms，要从里面砍掉 196ms（一半以上），难度不低。**
2. **优先查 `theme-main-*.js`**：2.026MB / 0.682MB Gzip，占首屏 JS 的 88%。它同时也是
   ADR 第 9 条超标的全部原因。把它里面的东西按需拆出去，是唯一能同时改善体积预算和
   B 段启动时间的动作。
3. **系统字体枚举 387ms 全部落在可交互之后**（ADR 第 6 条要做的事），它只影响稳定就绪，
   不影响主指标 P95，但能让稳定就绪从 1238ms 降到约 850ms。
4. **启动期建两次编辑器**（§7.3，112ms 那一段）是一个不碰内核、量级又够 ADR 第 2 条门槛的方向。
5. **窗口可见不要当目标**（§12.2）。
6. **先修 ADR 第 9 条的预算，再上 CI 门槛**（§9.5），否则 CI 一上线就是红的。
7. **WSL 场景要么补测要么明确排除**（§12.1）。
