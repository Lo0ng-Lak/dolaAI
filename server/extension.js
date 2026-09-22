import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_EXTENSION = path.resolve(__dirname, "..", "studiorelay", "studiorelay");

let cached = null;

export function getCachedStudioRelay() {
  return cached;
}

export async function resolveStudioRelayPath() {
  if (cached?.path) return cached;

  const candidates = [
    process.env.STUDIORELAY_PATH,
    REPO_EXTENSION,
    process.resourcesPath ? path.join(process.resourcesPath, "studiorelay") : null,
  ].filter(Boolean);

  for (const dir of candidates) {
    if (await isStudioRelayDir(dir)) {
      cached = { path: dir, source: sourceLabel(dir), name: "DragonBMT" };
      return cached;
    }
  }

  const installed = await findInstalledStudioRelay();
  if (installed) {
    cached = installed;
    return cached;
  }

  cached = null;
  return null;
}

function sourceLabel(dir) {
  if (process.env.STUDIORELAY_PATH && path.resolve(dir) === path.resolve(process.env.STUDIORELAY_PATH)) {
    return "env";
  }
  if (path.resolve(dir) === REPO_EXTENSION) return "repo";
  if (process.resourcesPath && dir.startsWith(process.resourcesPath)) return "app";
  return "local";
}

async function isStudioRelayDir(dir) {
  try {
    const raw = await fs.readFile(path.join(dir, "manifest.json"), "utf8");
    const manifest = JSON.parse(raw);
    return /dragonbmt|studiorelay/i.test(String(manifest.name || "")) && Number(manifest.manifest_version) === 3;
  } catch {
    return false;
  }
}

async function findInstalledStudioRelay() {
  const roots = chromeUserDataRoots();
  for (const root of roots) {
    let profiles = [];
    try {
      profiles = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const profile of profiles) {
      if (!profile.isDirectory()) continue;
      const extensionsRoot = path.join(root, profile.name, "Extensions");
      let ids = [];
      try {
        ids = await fs.readdir(extensionsRoot, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const id of ids) {
        if (!id.isDirectory()) continue;
        const versions = await newestVersionDirs(path.join(extensionsRoot, id.name));
        for (const versionDir of versions) {
          if (await isStudioRelayDir(versionDir)) {
            return {
              path: versionDir,
              source: `chrome:${profile.name}`,
              name: "DragonBMT",
            };
          }
        }
      }
    }
  }
  return null;
}

async function newestVersionDirs(extensionIdDir) {
  let entries = [];
  try {
    entries = await fs.readdir(extensionIdDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      dir: path.join(extensionIdDir, entry.name),
      name: entry.name,
    }))
    .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }))
    .map((entry) => entry.dir);
}

function chromeUserDataRoots() {
  const home = os.homedir();
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [path.join(local, "Google", "Chrome", "User Data")];
  }
  if (process.platform === "darwin") {
    return [path.join(home, "Library", "Application Support", "Google", "Chrome")];
  }
  return [path.join(home, ".config", "google-chrome")];
}

export function studioRelayLaunchArgs(extensionPath) {
  if (!extensionPath) return [];
  return [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
  ];
}

export function forcedDurationLabel(value) {
  const seconds = Number(String(value || "30").replace(/\D/g, ""));
  return seconds >= 60 ? "60s" : "30s";
}

export function durationSeconds(value) {
  return forcedDurationLabel(value).replace(/s$/i, "");
}
