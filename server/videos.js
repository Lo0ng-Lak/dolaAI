import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { VIDEO_DIR, VIDEO_OUT, VIDEO_RAW, VIDEOS_FILE } from "./paths.js";
import { PRESET_HEIGHT, upscaleLabel, upscaleVideo } from "./upscale.js";

let runContext = {
  accountEmail: "",
  duration: "30s",
  resolution: "2160p",
  lanczos: true,
};
let emit = {
  log: () => {},
  video: () => {},
};
const seen = new Set();
const ingesting = new Set();
let watcherStarted = false;
let records = [];

export function bindVideoEvents(handlers) {
  emit = { ...emit, ...handlers };
}

export function setRunContext(patch) {
  runContext = { ...runContext, ...patch };
}

export async function loadVideos() {
  try {
    records = JSON.parse(await fsp.readFile(VIDEOS_FILE, "utf8"));
    if (!Array.isArray(records)) records = [];
  } catch {
    records = [];
  }
  for (const item of records) {
    if (item.rawPath) seen.add(item.rawPath);
    if (item.outputPath) seen.add(item.outputPath);
  }
  return records.map(toPublic);
}

async function saveVideos() {
  await fsp.mkdir(DATA_PARENT, { recursive: true });
  await fsp.writeFile(VIDEOS_FILE, JSON.stringify(records, null, 2));
}

const DATA_PARENT = path.dirname(VIDEOS_FILE);

export function listVideos() {
  return records.map(toPublic);
}

export function getVideoRecord(id) {
  return records.find((item) => item.id === id) || null;
}

export function listPendingJobs(accountId) {
  return records.filter(
    (item) =>
      item.accountId === accountId &&
      !item.rawPath &&
      !item.libraryReady &&
      !["failed", "lanczos_failed", "upscaled"].includes(item.status),
  );
}

function liveProgress(item) {
  if (item.libraryReady || item.status === "upscaled") return 100;
  if (item.status === "failed" || item.status === "lanczos_failed") return Math.min(99, item.progress || 0);
  const reported = Number(item.progress);
  if (Number.isFinite(reported) && reported > 0) {
    return Math.min(item.status === "processing" ? 99 : 99, Math.max(0, Math.round(reported)));
  }
  if (item.status === "processing") return 90;
  if (item.status === "collecting") return 85;
  if (item.status === "sending") return 5;
  return 8;
}

function statusLabel(item) {
  if (item.libraryReady || item.status === "upscaled") return "Hoàn thành";
  if (item.status === "sending") return "Đang gửi";
  if (item.dolaStage === "queued") return "Đang chờ Dola";
  if (item.status === "collecting") return "Đang lấy video";
  if (item.status === "processing") return "Đang Lanczos";
  if (item.status === "lanczos_failed") return "Lanczos lỗi";
  if (item.status === "failed") return "Lỗi";
  if (item.progressSource === "dola") return "Đang tạo trên Dola";
  return "Đang tạo";
}

function qualityLabel(item) {
  const map = {
    "1080p": "1080p Full HD",
    "1440p": "2K 1440p",
    "2160p": "4K 2160p",
  };
  const quality = map[item.resolution] || item.resolution || "1080p";
  if (item.libraryReady) return `${quality} Lanczos · không watermark`;
  if (item.status === "lanczos_failed") return `Lanczos lỗi · ${quality}`;
  if (item.status === "generating" || item.status === "sending" || item.status === "collecting") {
    return statusLabel(item);
  }
  return `Đang Lanczos ${quality}`;
}

export function toPublic(item) {
  const ready = Boolean(item.libraryReady) || (item.status === "upscaled" && item.outputPath);
  return {
    id: item.id,
    title: item.title,
    account: item.account,
    accountId: item.accountId || "",
    duration: item.duration,
    ratio: item.ratio || "16:9",
    prompt: item.prompt || "",
    status: item.status,
    statusLabel: statusLabel(item),
    progress: liveProgress(item),
    progressSource: item.progressSource || "",
    dolaStage: item.dolaStage || "",
    resolution: item.resolution,
    createdAt: item.createdAt,
    bytes: item.bytes || 0,
    watermarkFree: true,
    libraryReady: ready,
    height: item.height || 0,
    qualityLabel: qualityLabel(item),
    error: item.error || "",
    url: ready ? `/api/videos/${item.id}/file` : "",
    rawUrl: item.rawPath ? `/api/videos/${item.id}/file?kind=raw` : "",
  };
}

export function createLiveJob(meta = {}) {
  const record = {
    id: meta.id || crypto.randomUUID(),
    title: meta.title || meta.accountEmail || "Tác vụ video",
    account: meta.accountEmail || "",
    accountId: meta.accountId || "",
    duration: meta.duration || "30s",
    ratio: meta.ratio || "16:9",
    prompt: String(meta.prompt || "").replace(/\n+/g, " ").trim(),
    status: meta.status || "sending",
    progress: 5,
    progressSource: "tool",
    lanczos: meta.lanczos !== false && meta.resolution !== "off",
    resolution: meta.resolution || "2160p",
    createdAt: new Date().toISOString(),
    rawPath: "",
    outputPath: "",
    bytes: 0,
    height: 0,
    libraryReady: false,
    watermarkFree: true,
  };
  records.unshift(record);
  saveVideos().catch(() => {});
  emit.video(toPublic(record));
  return record;
}

export function updateJob(id, patch = {}) {
  const record = records.find((item) => item.id === id);
  if (!record) return null;
  Object.assign(record, patch);
  saveVideos().catch(() => {});
  emit.video(toPublic(record));
  return record;
}

export function waitForJobFile(jobId, timeoutMs = 50000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      const record = records.find((item) => item.id === jobId);
      if (record?.rawPath || record?.libraryReady) {
        clearInterval(tick);
        resolve(true);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        clearInterval(tick);
        resolve(false);
      }
    }, 800);
  });
}

export async function removeVideo(id) {
  const index = records.findIndex((item) => item.id === id);
  if (index < 0) return false;
  const record = records[index];
  records.splice(index, 1);
  await saveVideos();
  for (const filePath of [record.rawPath, record.outputPath]) {
    if (!filePath) continue;
    await fsp.unlink(filePath).catch(() => {});
  }
  return true;
}

export async function relanczosVideo(id, preset, log) {
  const record = records.find((item) => item.id === id);
  if (!record?.rawPath) throw new Error("Chưa có bản gốc để Lanczos.");
  const resolution = PRESET_HEIGHT[preset] ? preset : record.resolution || "2160p";
  record.status = "processing";
  record.resolution = resolution;
  record.libraryReady = false;
  await saveVideos();
  emit.video(toPublic(record));
  log?.("info", `Lanczos ${record.title} → ${upscaleLabel(resolution)}`);
  const result = await upscaleVideo(record.rawPath, resolution, VIDEO_OUT, {
    onProgress: (pct) => updateJob(id, { status: "processing", progress: Math.min(99, 90 + Math.round(pct * 0.09)) }),
  });
  record.outputPath = result.outputPath || "";
  record.height = result.height || 0;
  record.bytes = result.bytes || record.bytes;
  record.status = "upscaled";
  record.libraryReady = Boolean(record.outputPath) && !result.skipped;
  record.progress = 100;
  if (record.outputPath) seen.add(record.outputPath);
  await saveVideos();
  emit.video(toPublic(record));
  return toPublic(record);
}

function tickLiveJobs() {
  for (const record of records) {
    if (!["sending", "generating", "collecting", "processing"].includes(record.status)) continue;
    emit.video(toPublic(record));
  }
}

export async function ensureVideoDirs() {
  await fsp.mkdir(VIDEO_RAW, { recursive: true });
  await fsp.mkdir(VIDEO_OUT, { recursive: true });
}

export async function writeChromeDownloadPrefs(profileDir, downloadDir) {
  await fsp.mkdir(downloadDir, { recursive: true });
  const prefsFile = path.join(profileDir, "Preferences");
  let prefs = {};
  try {
    prefs = JSON.parse(await fsp.readFile(prefsFile, "utf8"));
  } catch {
    prefs = {};
  }
  const normalized = downloadDir.replace(/\//g, path.sep);
  prefs.download = {
    ...(prefs.download || {}),
    default_directory: normalized,
    prompt_for_download: false,
    directory_upgrade: true,
  };
  prefs.savefile = {
    ...(prefs.savefile || {}),
    default_directory: normalized,
  };
  await fsp.writeFile(prefsFile, JSON.stringify(prefs));
}

export async function attachSessionDownloads(context, { account, log } = {}) {
  await ensureVideoDirs();
  await startVideoWatch(log);
  if (account?.email) setRunContext({ accountEmail: account.email, accountId: account.id });

  const bindPage = async (page) => {
    try {
      const session = await context.newCDPSession(page);
      await session.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: VIDEO_RAW,
        eventsEnabled: true,
      }).catch(async () => {
        await session.send("Page.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: VIDEO_RAW,
        });
      });
    } catch {
      // Chrome version may ignore CDP download routing; folder watch still catches files.
    }
  };

  for (const page of context.pages()) await bindPage(page);
  context.on("page", (page) => {
    bindPage(page);
  });

  context.on("download", async (download) => {
    try {
      const name = (download.suggestedFilename() || `video-${Date.now()}.mp4`).replace(/[<>:"/\\|?*]/g, "_");
      const target = path.join(VIDEO_RAW, name);
      await download.saveAs(target);
      await ingestVideoFile(target, { accountEmail: account?.email, accountId: account?.id, log });
    } catch (err) {
      log?.("warn", `Không lưu được file tải: ${err.message}`);
    }
  });
}

export async function startVideoWatch(log) {
  if (watcherStarted) return;
  watcherStarted = true;
  await ensureVideoDirs();
  if (!records.length) await loadVideos();

  const extra = path.join(os.homedir(), "Downloads", "TheBrandAI_Videos");
  const dirs = [VIDEO_RAW, extra];
  for (const dir of dirs) {
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    try {
      fs.watch(dir, { recursive: true }, (_event, filename) => {
        if (!filename || !/\.mp4$/i.test(filename)) return;
        queueIngest(path.join(dir, filename), log);
      });
    } catch {
      // fall back to polling
    }
  }

  setInterval(() => {
    scanDirs(dirs, log).catch(() => {});
  }, 2500);
  setInterval(tickLiveJobs, 4000);
  await scanDirs(dirs, log);
}

function queueIngest(filePath, log) {
  setTimeout(() => {
    ingestVideoFile(filePath, { log }).catch((err) => {
      log?.("warn", err.message);
    });
  }, 1200);
}

async function scanDirs(dirs, log) {
  for (const dir of dirs) {
    const files = await listMp4s(dir);
    for (const filePath of files) {
      await ingestVideoFile(filePath, { log }).catch(() => {});
    }
  }
}

async function listMp4s(dir) {
  const found = [];
  async function walk(current) {
    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.mp4$/i.test(entry.name) && !/\.(crdownload|tmp)$/i.test(entry.name)) {
        found.push(full);
      }
    }
  }
  await walk(dir);
  return found;
}

async function waitUntilStable(filePath) {
  let previous = -1;
  for (let i = 0; i < 20; i += 1) {
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat || stat.size < 32 * 1024) {
      await sleep(700);
      continue;
    }
    if (stat.size === previous) return stat;
    previous = stat.size;
    await sleep(800);
  }
  return fsp.stat(filePath).catch(() => null);
}

function matchPendingJob({ accountId, accountEmail }) {
  const pending = records.filter((item) => !item.rawPath && ["sending", "generating", "collecting"].includes(item.status));
  const byId = accountId ? pending.filter((item) => item.accountId === accountId) : [];
  const byEmail = accountEmail ? pending.filter((item) => item.account === accountEmail) : [];
  const pool = byId.length ? byId : byEmail.length ? byEmail : pending;
  return pool.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0] || null;
}

export async function ingestVideoFile(filePath, { accountEmail, accountId, log } = {}) {
  const resolved = path.resolve(filePath);
  if (!/\.mp4$/i.test(resolved) || /\.(crdownload|tmp)$/i.test(resolved)) return null;
  if (ingesting.has(resolved) || seen.has(resolved)) return null;
  if (resolved.startsWith(path.resolve(VIDEO_OUT))) return null;

  ingesting.add(resolved);
  try {
    const stat = await waitUntilStable(resolved);
    if (!stat || stat.size < 32 * 1024) return null;
    if (seen.has(resolved)) return null;

    const rawPath = await archiveRaw(resolved);
    if (seen.has(rawPath) || records.some((item) => item.rawPath === rawPath)) {
      seen.add(resolved);
      seen.add(rawPath);
      return null;
    }

    seen.add(resolved);
    seen.add(rawPath);

    const email = accountEmail || runContext.accountEmail || "";
    const id = accountId || runContext.accountId || "";
    const pending = matchPendingJob({ accountId: id, accountEmail: email });
    const title = path.basename(rawPath);
    const resolution =
      pending?.resolution && pending.resolution !== "off"
        ? pending.resolution
        : runContext.resolution && runContext.resolution !== "off"
          ? runContext.resolution
          : "off";
    const doLanczos = pending?.lanczos !== false && resolution !== "off" && runContext.lanczos !== false;
    const record = pending || {
      id: crypto.randomUUID(),
      title,
      account: email || "DragonBMT",
      accountId: id,
      duration: runContext.duration || "30s",
      ratio: "16:9",
      prompt: "",
      resolution,
      lanczos: doLanczos,
      createdAt: new Date().toISOString(),
      outputPath: "",
      height: 0,
      watermarkFree: true,
    };
    record.title = record.title || title;
    record.account = record.account || email || "DragonBMT";
    record.accountId = record.accountId || id;
    record.status = doLanczos ? "processing" : "upscaled";
    record.progress = doLanczos ? 90 : 100;
    record.progressSource = "tool";
    record.resolution = record.resolution || resolution;
    record.rawPath = rawPath;
    record.bytes = stat.size;
    record.libraryReady = false;
    if (!pending) records.unshift(record);
    import("./collect.js").then((mod) => mod.cancelCollect(record.id)).catch(() => {});
    await saveVideos();
    emit.video(toPublic(record));

    if (!doLanczos) {
      record.outputPath = rawPath;
      record.libraryReady = true;
      record.status = "upscaled";
      record.progress = 100;
      await saveVideos();
      emit.video(toPublic(record));
      emit.log("info", `Đã nhận bản gốc (tắt Lanczos): ${title}. Đưa vào thư viện.`);
      return toPublic(record);
    }

    emit.log("info", `Đã nhận bản gốc không watermark: ${title}. Chưa vào thư viện — đang Lanczos ${resolution}.`);
    emit.log("info", `Lanczos: đang nâng ${title} → ${upscaleLabel(resolution)}`);
    try {
      const result = await upscaleVideo(rawPath, resolution, VIDEO_OUT, {
        onProgress: (pct) => {
          record.status = "processing";
          record.progress = Math.min(99, 90 + Math.round(pct * 0.09));
          emit.video(toPublic(record));
        },
      });
      const expected = PRESET_HEIGHT[resolution] || 0;
      record.outputPath = result.outputPath || "";
      record.height = result.height || 0;
      record.bytes = result.bytes || stat.size;
      record.status = "upscaled";
      record.libraryReady = Boolean(record.outputPath) && !result.skipped;
      record.progress = 100;
      if (expected && record.height && Math.abs(record.height - expected) > 8) {
        emit.log("warn", `Lanczos ${title}: chiều cao ${record.height}p, cài đặt ${expected}p.`);
      }
      if (record.outputPath) seen.add(record.outputPath);
      await saveVideos();
      emit.video(toPublic(record));
      emit.log("info", `Đã vào thư viện: ${path.basename(record.outputPath)} · ${qualityLabel(record)}`);
    } catch (err) {
      record.status = "lanczos_failed";
      record.libraryReady = false;
      await saveVideos();
      emit.video(toPublic(record));
      emit.log("error", `Lanczos lỗi ${title}: ${err.message}. Chưa đưa vào thư viện.`);
    }

    return toPublic(record);
  } finally {
    ingesting.delete(resolved);
  }
}

async function archiveRaw(filePath) {
  const resolved = path.resolve(filePath);
  if (resolved.startsWith(path.resolve(VIDEO_RAW))) return resolved;
  await ensureVideoDirs();
  const target = path.join(VIDEO_RAW, path.basename(resolved));
  if (target === resolved) return resolved;
  try {
    await fsp.copyFile(resolved, target);
    return target;
  } catch {
    return resolved;
  }
}

export async function openVideoFolder(kind = "lanczos") {
  await ensureVideoDirs();
  const target = kind === "raw" ? VIDEO_RAW : VIDEO_OUT;
  await new Promise((resolve, reject) => {
    const cmd = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
    execFile(cmd, [target], (error) => {
      if (error && process.platform === "win32") resolve();
      else if (error) reject(error);
      else resolve();
    });
  });
  return target;
}

export function clearVideoRecords() {
  records = [];
  return saveVideos();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
