import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { EXTENSION_DIR, PROFILE_ROOT } from "./paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_EXTENSION = path.resolve(__dirname, "..", "studiorelay", "studiorelay");

let cached = null;

export function getCachedStudioRelay() {
  return cached;
}

export async function resolveStudioRelayPath() {
  if (cached?.path && (await isStudioRelayDir(cached.path))) return cached;

  const source = await findExtensionSource();
  if (!source) {
    cached = null;
    return null;
  }

  const dest = EXTENSION_DIR;
  if (path.resolve(source.path) !== path.resolve(dest)) {
    await copyExtension(source.path, dest);
  }

  if (!(await isStudioRelayDir(dest))) {
    cached = { path: source.path, source: source.source, name: "DragonBMT", id: await readExtensionId(source.path) };
    return cached;
  }

  cached = {
    path: dest,
    source: source.source,
    name: "DragonBMT",
    id: await readExtensionId(dest),
  };
  return cached;
}

async function findExtensionSource() {
  const candidates = [
    process.env.STUDIORELAY_PATH,
    REPO_EXTENSION,
    EXTENSION_DIR,
    process.resourcesPath ? path.join(process.resourcesPath, "studiorelay") : null,
  ].filter(Boolean);

  for (const dir of candidates) {
    if (await isStudioRelayDir(dir)) {
      return { path: dir, source: sourceLabel(dir) };
    }
  }

  return findInstalledStudioRelay();
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

async function copyExtension(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.cp(from, to, {
    recursive: true,
    force: true,
    filter: (src) => !/\.pem$/i.test(src),
  });
}

export function extensionIdFromKey(key) {
  const der = Buffer.from(String(key).replace(/\s+/g, ""), "base64");
  const hash = crypto.createHash("sha256").update(der).digest().subarray(0, 16);
  let id = "";
  for (const byte of hash) {
    id += String.fromCharCode(97 + ((byte >> 4) & 0xf));
    id += String.fromCharCode(97 + (byte & 0xf));
  }
  return id;
}

async function readExtensionId(dir) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));
    if (manifest.key) return extensionIdFromKey(manifest.key);
  } catch {
    // fall through
  }
  return "dragonbmtlocalext";
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

function chromeInstallTime() {
  return String(BigInt(Date.now()) * 1000n + 11644473600000000n);
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value));
  await fs.rename(tmp, file).catch(async () => {
    await fs.writeFile(file, JSON.stringify(value));
    await fs.rm(tmp, { force: true }).catch(() => {});
  });
}

function extensionPrefBlock(id, manifest, extPath, existing = {}) {
  return {
    ...existing,
    active_bit: 1,
    creation_flags: 38,
    from_webstore: false,
    granted_permissions: {
      api: manifest.permissions || [],
      explicit_host: manifest.host_permissions || [],
      scriptable_host: manifest.host_permissions || [],
    },
    install_time: existing.install_time || chromeInstallTime(),
    location: 4,
    manifest,
    path: extPath,
    state: 1,
    was_installed_by_default: true,
    was_installed_by_oem: false,
    withholding_permissions: false,
  };
}

async function mergeExtensionPrefs(prefsFile, id, manifest, extPath) {
  const prefs = await readJsonFile(prefsFile, {});
  prefs.extensions = prefs.extensions || {};
  prefs.extensions.ui = { ...(prefs.extensions.ui || {}), developer_mode: true };
  prefs.extensions.settings = prefs.extensions.settings || {};
  prefs.extensions.settings[id] = extensionPrefBlock(id, manifest, extPath, prefs.extensions.settings[id]);
  await writeJsonFile(prefsFile, prefs);
}

export async function installExtensionIntoProfile(userDataDir, extension = cached) {
  const ext = extension || (await resolveStudioRelayPath());
  if (!ext?.path || !userDataDir) return null;

  const id = ext.id || (await readExtensionId(ext.path));
  const manifest = JSON.parse(await fs.readFile(path.join(ext.path, "manifest.json"), "utf8"));
  const version = String(manifest.version || "2.0");
  const copies = [
    path.join(userDataDir, "Default", "Extensions", id, version),
    path.join(userDataDir, "Extensions", id, version),
  ];
  for (const unpacked of copies) {
    await copyExtension(ext.path, unpacked);
  }

  await writeJsonFile(path.join(userDataDir, "External Extensions", `${id}.json`), {
    external_dir: ext.path.replace(/\\/g, "/"),
  });

  await mergeExtensionPrefs(path.join(userDataDir, "Default", "Preferences"), id, manifest, ext.path);
  await mergeExtensionPrefs(path.join(userDataDir, "Preferences"), id, manifest, ext.path);

  const localStateFile = path.join(userDataDir, "Local State");
  const localState = await readJsonFile(localStateFile, {});
  localState.extensions = localState.extensions || {};
  localState.extensions.ui = { ...(localState.extensions.ui || {}), developer_mode: true };
  await writeJsonFile(localStateFile, localState);

  return { ...ext, id, unpacked: copies[0] };
}

async function listChromeProfileDirs() {
  const dirs = [];
  try {
    const entries = await fs.readdir(PROFILE_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(path.join(PROFILE_ROOT, entry.name));
    }
  } catch {
    // no tool profiles yet
  }

  for (const root of chromeUserDataRoots()) {
    dirs.push(root);
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!/^(Default|Profile \d+|Guest Profile)$/i.test(entry.name)) continue;
        dirs.push(path.join(root, entry.name));
      }
    } catch {
      // Chrome not installed
    }
  }
  return [...new Set(dirs)];
}

async function registerChromeExternal(ext) {
  const id = ext.id || (await readExtensionId(ext.path));
  const payload = { external_dir: ext.path.replace(/\\/g, "/") };
  const homes = [
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Google", "Chrome", "External Extensions"),
    ...chromeUserDataRoots().map((root) => path.join(root, "External Extensions")),
  ];
  for (const dir of homes) {
    await writeJsonFile(path.join(dir, `${id}.json`), payload).catch(() => {});
  }
}

export async function installDragonBmtEverywhere() {
  const ext = await resolveStudioRelayPath();
  if (!ext?.path) return { ok: false, profiles: 0 };
  await registerChromeExternal(ext);
  const dirs = await listChromeProfileDirs();
  let profiles = 0;
  for (const dir of dirs) {
    try {
      await installExtensionIntoProfile(dir, ext);
      profiles += 1;
    } catch {
      // profile may be locked by a running Chrome
    }
  }
  return { ok: true, profiles, id: ext.id, name: ext.name };
}

export async function wakeDragonBmtOnPage(page) {
  const ext = await resolveStudioRelayPath();
  if (!ext?.path) throw new Error("Thiếu DragonBMT trong app.");
  const ready = await page
    .waitForFunction(
      () => Boolean(window.__studioRelaySessionShieldActive || window.__isStudioRelayProModeActive),
      null,
      { timeout: 800 },
    )
    .catch(() => null);
  if (!ready) {
    // Không nhét inject.js lần nữa — trùng hook fetch sẽ 401 và đẩy ra login khi gửi prompt.
  }
  return ext;
}

export function studioRelayLaunchArgs(extensionPath, extraPaths = [], extraDisableFeatures = []) {
  const paths = [extensionPath, ...extraPaths]
    .filter(Boolean)
    .map((item) => path.resolve(item));
  if (!paths.length) return [];
  const features = ["DisableLoadExtensionCommandLineSwitch", ...extraDisableFeatures].filter(Boolean);
  return [
    `--disable-extensions-except=${paths.join(",")}`,
    `--load-extension=${paths.join(",")}`,
    `--disable-features=${features.join(",")}`,
    "--enable-unsafe-extension-debugging",
  ];
}

export function forcedDurationLabel(value) {
  const seconds = Number(String(value || "30").replace(/\D/g, ""));
  return seconds >= 60 ? "60s" : "30s";
}

export function durationSeconds(value) {
  return forcedDurationLabel(value).replace(/s$/i, "");
}
