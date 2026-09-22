import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function defaultBrowsersPath() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ms-playwright");
}

export function pinPlaywrightBrowsersPath() {
  const current = String(process.env.PLAYWRIGHT_BROWSERS_PATH || "");
  if (!current || /cursor-sandbox-cache|temp[\\/]/i.test(current)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = defaultBrowsersPath();
  }
  return process.env.PLAYWRIGHT_BROWSERS_PATH;
}

pinPlaywrightBrowsersPath();

export async function ensurePlaywrightChromium(log) {
  pinPlaywrightBrowsersPath();
  const exe = chromium.executablePath();
  try {
    await fs.access(exe);
    return exe;
  } catch {
    // missing
  }
  log?.("info", "Chưa có Chromium của tool — đang tải (một lần, khoảng 200MB)...");
  const cli = path.resolve(import.meta.dirname, "../node_modules/playwright/cli.js");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "install", "chromium"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: pinPlaywrightBrowsersPath() },
      stdio: "inherit",
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Tải Chromium thất bại (mã ${code}). Chạy: npx playwright install chromium`)),
    );
    child.on("error", reject);
  });
  await fs.access(chromium.executablePath());
  return chromium.executablePath();
}
