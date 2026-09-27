/* ============================================================================
 * PROTOTYPE / THROWAWAY — 启动性能基准的场景定义与测试文档生成。
 *
 * 只负责：造 5 个场景需要的状态（测试文档、工作区目录、localStorage 种子）。
 * 不做测量，测量在 bench/run.mjs。
 * ==========================================================================*/

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 所有测试产物都放在临时目录，文件名带 PROTOTYPE 标记，方便一眼认出来 */
export const BENCH_TMP_ROOT = path.join(os.tmpdir(), "milkup-bench-PROTOTYPE");

export const PROFILE_DIR = path.join(BENCH_TMP_ROOT, "profile");

/** 普通文档的目标字符数（中文「字」= 字符） */
export const NORMAL_DOC_CHARS = 3000;
/** 大文档的目标字符数 */
export const LARGE_DOC_CHARS = 200000;

const WORDS = [
  "启动性能",
  "渲染进程",
  "主进程",
  "工作区",
  "编辑器内核",
  "语法标记",
  "延迟加载",
  "内存峰值",
  "体积预算",
  "可交互时间",
  "窗口可见",
  "字体枚举",
  "语言包",
  "公式渲染",
  "主题样式",
  "文件监听",
  "首屏加载",
  "主线程",
  "合成帧",
  "布局抖动",
];

function makeParagraph(index, seed) {
  const lines = [];
  const lineCount = 3 + (seed % 3);
  for (let i = 0; i < lineCount; i += 1) {
    const parts = [];
    const wordCount = 6 + ((seed + i * 3) % 8);
    for (let w = 0; w < wordCount; w += 1) {
      parts.push(WORDS[(seed + index * 7 + w * 11) % WORDS.length]);
    }
    lines.push(parts.join("，") + "。");
  }
  return lines.join("\n");
}

/** 生成不少于 targetChars 个字符的中文 Markdown */
export function makeChineseMarkdown(targetChars, seed = 1) {
  const blocks = [];
  let size = 0;
  let index = 0;
  while (size < targetChars) {
    const heading = "\n## PROTOTYPE 小节 " + (index + 1) + "\n\n";
    const body = makeParagraph(index, seed + index) + "\n\n";
    const list =
      "- " +
      WORDS[(index + 3) % WORDS.length] +
      "条目 " +
      (index + 1) +
      "\n- " +
      WORDS[(index + 5) % WORDS.length] +
      "条目 " +
      (index + 2) +
      "\n\n";
    blocks.push(heading, body, list);
    size += heading.length + body.length + list.length;
    index += 1;
  }
  let text =
    "# PROTOTYPE 基准测试文档\n\n> 本文件由 bench/scenarios.mjs 自动生成，勿手工编辑。\n\n" +
    blocks.join("");
  // 补齐到目标字符数（末尾追加句子，不改变结构）
  let filler = 0;
  while (text.length < targetChars) {
    text += "补充句子 " + filler + "：" + WORDS[filler % WORDS.length] + "。";
    filler += 1;
  }
  return text;
}

/** 幂等地准备测试文档和工作区目录 */
export function ensureFixtures() {
  fs.mkdirSync(BENCH_TMP_ROOT, { recursive: true });
  const normalDocDir = path.join(BENCH_TMP_ROOT, "docs");
  const workspaceDir = path.join(BENCH_TMP_ROOT, "workspace");
  fs.mkdirSync(normalDocDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const normalDoc = path.join(normalDocDir, "PROTOTYPE-normal.md");
  const largeDoc = path.join(normalDocDir, "PROTOTYPE-large.md");
  writeIfMissing(normalDoc, makeChineseMarkdown(NORMAL_DOC_CHARS, 3));
  writeIfMissing(largeDoc, makeChineseMarkdown(LARGE_DOC_CHARS, 11));

  // 本地工作区：3 个子目录（各 10 个文件）+ 根目录 20 个文件，模拟一个真实规模的本地项目
  for (let d = 0; d < 3; d += 1) {
    const sub = path.join(workspaceDir, "PROTOTYPE-sub-" + (d + 1));
    fs.mkdirSync(sub, { recursive: true });
    for (let f = 0; f < 10; f += 1) {
      writeIfMissing(
        path.join(sub, "PROTOTYPE-note-" + (d + 1) + "-" + (f + 1) + ".md"),
        makeChineseMarkdown(600, 100 + d * 10 + f)
      );
    }
  }
  for (let f = 0; f < 20; f += 1) {
    writeIfMissing(
      path.join(workspaceDir, "PROTOTYPE-root-" + (f + 1) + ".md"),
      makeChineseMarkdown(600, 200 + f)
    );
  }

  return { normalDoc, largeDoc, workspaceDir, normalDocDir };
}

function writeIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) return;
  fs.writeFileSync(filePath, content, "utf-8");
}

// ── 场景 ───────────────────────────────────────────────────────────────────

/** @typedef {{id:string,title:string,primary:boolean,note:string,
 *   openFile:(f:any)=>string|null, seed:(f:any)=>Record<string,string>|null}} Scenario */

function configJson(partial) {
  return JSON.stringify(partial);
}

/** 侧边栏关闭 + 没有配置启动工作区（最常见状态） */
const NO_WORKSPACE_CONFIG = () =>
  configJson({ workspace: { startupPath: "", autoExpandSidebar: false, sortBy: "name", sidebarWidth: null } });

export const SCENARIOS = [
  {
    id: "empty",
    title: "1 空文档",
    primary: false,
    openFile: () => null,
    seed: NO_WORKSPACE_CONFIG,
    note: "不传文件参数，落在默认 Untitled tab；侧边栏关闭。",
  },
  {
    id: "normal",
    title: "2 普通文档(约3000字)",
    primary: true,
    openFile: (f) => f.normalDoc,
    seed: NO_WORKSPACE_CONFIG,
    note: "主场景。命令行打开 3000 字文档，侧边栏关闭——最典型的日常使用形态。",
  },
  {
    id: "large",
    title: "3 大文档(200000字符)",
    primary: false,
    openFile: (f) => f.largeDoc,
    seed: NO_WORKSPACE_CONFIG,
    note: "命令行打开 20 万字符文档；会触发大文件 loading 遮罩路径。",
  },
  {
    id: "no-workspace",
    title: "4 无工作区",
    primary: false,
    openFile: (f) => f.normalDoc,
    seed: NO_WORKSPACE_CONFIG,
    note: "显式 startupPath=\"\" 且侧边栏关闭，模拟「开过工作区又关掉」的老档案。有效状态与场景 2 等价，用作工具自身方差的回归护栏。",
  },
  {
    id: "local-workspace",
    title: "5 本地工作区",
    primary: false,
    openFile: (f) => f.normalDoc,
    seed: (f) =>
      configJson({
        workspace: {
          startupPath: f.workspaceDir,
          // 自动展开 = ADR 里的「侧边栏自动展开时保持当前同步扫描」路径
          autoExpandSidebar: true,
          sortBy: "name",
          sidebarWidth: 260,
        },
      }),
    note: "命令行打开 3000 字文档 + startupPath 指向本地工作区目录（23 个 md + 3 个子目录）+ 侧边栏自动展开。",
  },
  {
    id: "wsl-workspace",
    title: "6 WSL 工作区(不测)",
    primary: false,
    openFile: (f) => f.normalDoc,
    seed: () => null,
    note: "本机 WSL 不可用（wsl --list 报 REGDB_CLASSNOTREG），阶段 1 不测，见 STAGE1.md 缺口说明。",
  },
];

export function getScenario(id) {
  const found = SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error("未知场景：" + id);
  return found;
}

export const PRIMARY_SCENARIO_ID = (SCENARIOS.find((s) => s.primary) || { id: "normal" }).id;
