import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browsers = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ms-playwright");
const exe = path.join(browsers, "chromium-1243", "chrome-win64", "chrome.exe");
if (fs.existsSync(exe)) process.exit(0);

const cli = path.join(root, "node_modules", "playwright", "cli.js");
const child = spawn(process.execPath, [cli, "install", "chromium"], {
  cwd: root,
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
