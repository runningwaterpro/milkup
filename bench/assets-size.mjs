/* ============================================================================
 * PROTOTYPE / THROWAWAY — 首屏 JS/CSS 体积统计。
 *
 * 口径：dist/index.html 里显式引用的资源（module script + modulepreload + stylesheet）。
 * Vite 生产构建会把入口的静态依赖写成 <link rel="modulepreload">，浏览器会在
 * 解析 HTML 时就并行下载它们，所以它们属于「首屏字节」。
 *
 * 用法：node bench/assets-size.mjs [distDir]
 * ==========================================================================*/

import * as fs from "node:fs";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

/** ADR 0001 第 9 条的确定性预算 */
export const BUDGET = {
  jsRawBytes: 2.1 * 1024 * 1024,
  jsGzipBytes: 720 * 1024,
  cssGzipBytes: 30 * 1024,
};

export function readFirstScreenAssets(distDir = path.join(repoRoot, "dist")) {
  const htmlPath = path.join(distDir, "index.html");
  const html = fs.readFileSync(htmlPath, "utf-8");
  const refs = [...html.matchAll(/(?:src|href)="\.\/assets\/([^"]+)"/g)].map((m) => m[1]);
  const unique = [...new Set(refs)];

  const files = unique.map((name) => {
    const abs = path.join(distDir, "assets", name);
    const buf = fs.readFileSync(abs);
    return {
      name,
      kind: name.endsWith(".css") ? "css" : "js",
      raw: buf.length,
      gzip: gzipSync(buf, { level: 9 }).length,
    };
  });

  const sum = (kind, field) =>
    files.filter((f) => f.kind === kind).reduce((acc, f) => acc + f[field], 0);

  // 入口 script 本身（不含 modulepreload 的共享 chunk）
  const entry = files.find((f) => f.name.startsWith("main-") && f.name.endsWith(".js"));

  // dist/assets 下所有 js（包含按需 chunk：mermaid、codemirror 语言、主题编辑器）
  const allJs = fs
    .readdirSync(path.join(distDir, "assets"))
    .filter((n) => n.endsWith(".js"))
    .map((n) => {
      const buf = fs.readFileSync(path.join(distDir, "assets", n));
      return { name: n, raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length };
    });

  return {
    files,
    firstScreen: {
      jsRaw: sum("js", "raw"),
      jsGzip: sum("js", "gzip"),
      cssRaw: sum("css", "raw"),
      cssGzip: sum("css", "gzip"),
    },
    entryOnly: entry ? { name: entry.name, raw: entry.raw, gzip: entry.gzip } : null,
    allAssetsJs: {
      count: allJs.length,
      raw: allJs.reduce((a, f) => a + f.raw, 0),
      gzip: allJs.reduce((a, f) => a + f.gzip, 0),
      top5: [...allJs].sort((a, b) => b.raw - a.raw).slice(0, 5),
    },
  };
}

const mb = (n) => (n / 1024 / 1024).toFixed(3) + " MB";
const kb = (n) => (n / 1024).toFixed(1) + " KB";

export function printAssetsReport(distDir) {
  const r = readFirstScreenAssets(distDir);
  console.log("");
  console.log("── 首屏资源体积（dist/index.html 显式引用的资源）────────────────────────");
  console.log(
    "  " +
      "资源".padEnd(36) +
      "原始".padStart(12) +
      "Gzip".padStart(12)
  );
  for (const f of r.files) {
    const size = f.raw > 200 * 1024 ? mb(f.raw) : kb(f.raw);
    const gsize = f.gzip > 200 * 1024 ? mb(f.gzip) : kb(f.gzip);
    console.log("  " + f.name.padEnd(36) + size.padStart(12) + gsize.padStart(12));
  }
  const fs_ = r.firstScreen;
  console.log("  " + "-".repeat(60));
  console.log(
    "  " + "首屏 JS 合计".padEnd(36) + mb(fs_.jsRaw).padStart(12) + mb(fs_.jsGzip).padStart(12)
  );
  console.log(
    "  " + "首屏 CSS 合计".padEnd(34) + mb(fs_.cssRaw).padStart(12) + kb(fs_.cssGzip).padStart(12)
  );
  if (r.entryOnly) {
    console.log(
      "  （参考）入口 script 自身：" +
        r.entryOnly.name +
        "  " +
        kb(r.entryOnly.raw) +
        " / gzip " +
        kb(r.entryOnly.gzip)
    );
  }
  console.log(
    "  （参考）dist/assets 全部 " +
      r.allAssetsJs.count +
      " 个 js： " +
      mb(r.allAssetsJs.raw) +
      " / gzip " +
      mb(r.allAssetsJs.gzip)
  );
  console.log("");
  console.log("── 与 ADR 0001 确定性预算交叉校验 ──────────────────────────────────");
  const check = (label, actual, limit) => {
    const ok = actual <= limit;
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(22)} 实际 ${kb(actual).padStart(10)}  预算 ${kb(limit).padStart(10)}` +
        (ok ? "" : `  超出 ${kb(actual - limit)}`)
    );
    return ok;
  };
  check("首屏 JS 原始", fs_.jsRaw, BUDGET.jsRawBytes);
  check("首屏 JS Gzip", fs_.jsGzip, BUDGET.jsGzipBytes);
  check("首屏 CSS Gzip", fs_.cssGzip, BUDGET.cssGzipBytes);
  console.log("");
  return r;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  printAssetsReport(process.argv[2]);
}
