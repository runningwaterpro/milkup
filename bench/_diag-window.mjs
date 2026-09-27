/* PROTOTYPE / THROWAWAY — 一次性诊断脚本：确认这台机器上 Electron 窗口到底
 * 有没有真正可见/合成、rAF 是否触发、execCommand 是否能改文档。
 * 阶段 1 排查用，不属于基准本体。
 *
 * 注意：Windows 上 electron.exe 是 GUI 子系统程序，console.log 到不了 stdout，
 * 所以诊断结果写文件。*/
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const pnpmDir = path.join(repoRoot, "node_modules", ".pnpm");
const electron = fs
  .readdirSync(pnpmDir)
  .filter((d) => d.startsWith("electron@"))
  .map((d) => path.join(pnpmDir, d, "node_modules", "electron", "dist", "electron.exe"))
  .find((c) => fs.existsSync(c));

const tmp = path.join(process.env.TEMP ?? ".", "milkup-bench-PROTOTYPE");
fs.mkdirSync(tmp, { recursive: true });

const outFile = path.join(tmp, "diag.txt");
const probeMain = path.join(tmp, "probe-main.js");
const probeHtml = path.join(tmp, "probe.html");
const probeRenderer = path.join(tmp, "probe-renderer.js");

fs.writeFileSync(probeHtml, '<!doctype html><html><body style="margin:0"><h1 id="h">hi</h1></body></html>');

const rendererSource = [
  "new Promise((resolve) => {",
  "  let rafCount = 0;",
  "  const start = performance.now();",
  "  const tick = () => {",
  "    rafCount += 1;",
  "    if (performance.now() - start < 1000) requestAnimationFrame(tick);",
  "    else finish();",
  "  };",
  "  const finish = () => {",
  '    const probe = document.createElement("div");',
  '    probe.contentEditable = "true";',
  '    probe.textContent = "abc";',
  "    document.body.appendChild(probe);",
  "    probe.focus();",
  "    const before = probe.textContent;",
  "    let execOk = null;",
  '    try { execOk = document.execCommand("insertText", false, "ZQZ"); } catch (e) { execOk = "threw:" + e; }',
  "    resolve(JSON.stringify({",
  "      visibilityState: document.visibilityState,",
  "      hasFocus: document.hasFocus(),",
  "      rafCountPerSecond: rafCount,",
  "      execOk: execOk,",
  "      domChanged: probe.textContent !== before,",
  "      domText: probe.textContent,",
  "      windowOuter: [window.outerWidth, window.outerHeight]",
  "    }));",
  "  };",
  "  requestAnimationFrame(tick);",
  "  setTimeout(() => { if (rafCount === 0) finish(); }, 1500);",
  "})",
].join("\n");
fs.writeFileSync(probeRenderer, rendererSource);

const mainSource = [
  'const fs = require("node:fs");',
  'const { app, BrowserWindow } = require("electron");',
  "const OUT = " + JSON.stringify(outFile) + ";",
  "const HTML = " + JSON.stringify(probeHtml) + ";",
  "const RENDERER_PROBE_PATH = " + JSON.stringify(probeRenderer) + ";",
  "const t0 = Date.now() - process.uptime() * 1000;",
  'const log = (...a) => fs.appendFileSync(OUT, (Date.now() - t0) + "ms " + a.join(" ") + "\\n");',
  'fs.writeFileSync(OUT, "");',
  'log("script start uptime=" + process.uptime());',
  'process.on("uncaughtException", (e) => { log("UNCAUGHT", String((e && e.stack) || e)); app.exit(1); });',
  "app.whenReady().then(() => {",
  '  log("app ready");',
  '  const win = new BrowserWindow({ width: 900, height: 600, show: true });',
  '  log("constructed visible=" + win.isVisible() + " bounds=" + JSON.stringify(win.getBounds()));',
  '  for (const ev of ["show", "ready-to-show", "focus", "blur", "hide", "restore", "maximize", "unmaximize"]) {',
  '    win.on(ev, () => log("win event " + ev + " visible=" + win.isVisible()));',
  "  }",
  '  win.webContents.on("paint", () => log("PAINT"));',
  '  win.webContents.on("did-finish-load", () => log("did-finish-load"));',
  '  win.webContents.on("console-message", (_e, _l, m) => log("renderer:", String(m).slice(0, 160)));',
  "  win.loadFile(HTML);",
  '  const RENDERER_PROBE = fs.readFileSync(RENDERER_PROBE_PATH, "utf-8");',
  '  log("maximize at 900ms (模拟应用真实行为)");',
  "  setTimeout(() => win.maximize(), 900);",
  "  setTimeout(() => {",
  "    win.webContents",
  "      .executeJavaScript(RENDERER_PROBE)",
  '      .then((r) => log("renderer state " + r))',
  '      .catch((e) => log("executeJavaScript failed " + String(e)));',
  "    setTimeout(() => {",
  '      log("final visible=" + win.isVisible() + " minimized=" + win.isMinimized() + " bounds=" + JSON.stringify(win.getBounds()));',
  "      app.exit(0);",
  "    }, 2500);",
  "  }, 2500);",
  "});",
].join("\n");
fs.writeFileSync(probeMain, mainSource);

console.log("probe main:", probeMain);
console.log("electron  :", electron);
const child = spawn(electron, [probeMain, `--user-data-dir=${path.join(tmp, "probe-profile")}`], {
  stdio: "ignore",
  windowsHide: false,
});
const started = Date.now();
const poll = setInterval(() => {
  const done = () => fs.existsSync(outFile) && fs.readFileSync(outFile, "utf-8").includes("final");
  if (done() || Date.now() - started > 30_000) {
    clearInterval(poll);
    console.log(fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf-8") : "(no diag file)");
    try {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
    process.exit(done() ? 0 : 1);
  }
}, 250);
