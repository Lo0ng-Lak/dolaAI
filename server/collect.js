import fs from "node:fs/promises";
import path from "node:path";
import { closeAccountSession, getAccountSession, getOpenPage, parkAccountSession, sessionPurpose } from "./sessions.js";
import { mapDolaPercent, readDolaTaskState } from "./progress.js";
import { VIDEO_RAW } from "./paths.js";
import { getVideoRecord, ingestVideoFile, listPendingJobs, updateJob, waitForJobFile } from "./videos.js";
import { maybeSolveCaptcha } from "./captcha.js";

const fetchedKeys = new Set();
const fetchingJobs = new Set();

const scheduled = new Map();
const watchers = new Map();

function clearJobTimers(jobId) {
  const timers = scheduled.get(jobId);
  if (!timers) return;
  for (const timer of timers) clearTimeout(timer);
  scheduled.delete(jobId);
}

export function cancelCollect(jobId) {
  clearJobTimers(jobId);
}

export function cancelAllCollects() {
  for (const jobId of [...scheduled.keys()]) clearJobTimers(jobId);
  for (const stop of watchers.values()) stop.on = true;
  watchers.clear();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function scheduleCollect({ accountId, jobId, log }) {
  if (!accountId || !jobId) return;
  clearJobTimers(jobId);
  scheduled.set(jobId, []);
  startAccountWatch(accountId, log);
  log?.("info", "Giữ Chrome ẩn nền — xong thì lấy bản không watermark của DragonBMT, không tải bản có logo.");
}

function startAccountWatch(accountId, log) {
  if (watchers.has(accountId)) return;
  const stop = { on: false };
  watchers.set(accountId, stop);

  (async () => {
    try {
      while (!stop.on) {
        const jobs = listPendingJobs(accountId);
        if (!jobs.length) {
          if (sessionPurpose(accountId) === "watch") await closeAccountSession(accountId);
          return;
        }

        let page = getOpenPage(accountId);
        if (!page) {
          const { applyStudioRelaySettings, DOLA_URL, waitForStudioRelay } = await import("./dola.js");
          const opened = await getAccountSession(accountId, log, { offscreen: true, purpose: "watch" });
          page = opened.page;
          if (!/dola\.com/i.test(page.url())) {
            await page.goto(DOLA_URL, { waitUntil: "commit", timeout: 25000 }).catch(() => {});
          }
          await waitForStudioRelay(page, log).catch(() => false);
          await applyStudioRelaySettings(page, { duration: jobs[0].duration || "30s", ratio: jobs[0].ratio || "16:9" }, log).catch(() => {});
          await parkAccountSession(accountId);
        }

        for (const job of jobs) {
          if (stop.on) return;
          if (await waitForJobFile(job.id, 20)) {
            clearJobTimers(job.id);
            continue;
          }
          await peekJob(page, job, log);
        }

        await sleep(4000);
      }
    } catch (err) {
      log?.("warn", `Theo dõi Dola: ${err.message}`);
      await sleep(8000);
      watchers.delete(accountId);
      if (listPendingJobs(accountId).length) startAccountWatch(accountId, log);
      return;
    }
    watchers.delete(accountId);
  })();
}

async function readWatermarkFreeVideos(page) {
  return page
    .evaluate(
      () =>
        new Promise((resolve) => {
          const pack = (list) =>
            (Array.isArray(list) ? list : [])
              .filter((item) => item && String(item.source || "") === "fallback_api" && /^https?:\/\//i.test(String(item.url || "")))
              .map((item) => ({
                url: String(item.url),
                vid: String(item.vid || item.url),
                prompt: String(item.prompt || item.topicTitle || item.title || ""),
                width: Number(item.width) || 0,
                height: Number(item.height) || 0,
              }));
          const finish = (videos) => resolve(pack(videos));
          const onResponse = (event) => {
            window.removeEventListener("DOLA_CHAT_MEDIA_RESPONSE", onResponse);
            finish(event?.detail?.videos || window.__dolaChatVideos || window.chatVideos || []);
          };
          window.addEventListener("DOLA_CHAT_MEDIA_RESPONSE", onResponse, { once: true });
          window.dispatchEvent(new CustomEvent("DOLA_GET_CHAT_MEDIA"));
          setTimeout(() => {
            window.removeEventListener("DOLA_CHAT_MEDIA_RESPONSE", onResponse);
            finish(window.__dolaChatVideos || window.chatVideos || []);
          }, 1200);
        }),
    )
    .catch(() => []);
}

function pickWatermarkFree(videos, job) {
  const unused = videos.filter((item) => !fetchedKeys.has(item.url) && !fetchedKeys.has(item.vid));
  if (!unused.length) return null;
  const hint = String(job.prompt || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24)
    .toLowerCase();
  if (hint) {
    const matched = unused.filter((item) => String(item.prompt || "").toLowerCase().includes(hint));
    if (matched.length) return matched[matched.length - 1];
  }
  return unused[unused.length - 1];
}

async function saveWatermarkFree(page, video, job, log) {
  const key = video.vid || video.url;
  if (fetchedKeys.has(video.url) || fetchedKeys.has(key) || fetchingJobs.has(job.id)) return false;
  fetchingJobs.add(job.id);
  fetchedKeys.add(video.url);
  fetchedKeys.add(key);
  updateJob(job.id, { status: "collecting", progress: Math.max(job.progress || 0, 88), dolaStage: "ready" });
  log?.("info", `${job.account || "Tài khoản"}: DragonBMT đã có bản không watermark — đang lấy file gốc.`);
  try {
    const response = await page.context().request.get(video.url, { timeout: 180000 });
    if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
    const buffer = Buffer.from(await response.body());
    if (buffer.length < 32 * 1024) throw new Error("File không watermark quá nhỏ.");
    await fs.mkdir(VIDEO_RAW, { recursive: true });
    const target = path.join(VIDEO_RAW, `nowm-${String(job.id).slice(0, 8)}-${Date.now()}.mp4`);
    await fs.writeFile(target, buffer);
    await ingestVideoFile(target, { accountEmail: job.account, accountId: job.accountId, log });
    log?.("info", `${job.account || "Tài khoản"}: đã lấy bản xóa watermark. Lanczos rồi mới vào thư viện.`);
    return true;
  } catch (err) {
    fetchedKeys.delete(video.url);
    fetchedKeys.delete(key);
    log?.("warn", `${job.account || "Tài khoản"}: chưa lấy được bản không watermark — ${err.message}. Đợi DragonBMT bắt lại, không tải bản có logo.`);
    return false;
  } finally {
    fetchingJobs.delete(job.id);
  }
}

async function peekJob(page, record, log) {
  await maybeSolveCaptcha(page, log);
  const snapshot = await readDolaTaskState(page, { promptHint: record.prompt || "" });
  const live = getVideoRecord(record.id) || record;
  const videos = await readWatermarkFreeVideos(page);
  const raw = pickWatermarkFree(videos, live);
  const nextProgress = raw ? Math.max(mapDolaPercent(snapshot, live.progress || 8), 88) : mapDolaPercent(snapshot, live.progress || 8);
  updateJob(record.id, {
    status: raw || snapshot.downloadReady || snapshot.stage === "ready"
      ? "collecting"
      : live.status === "failed"
        ? "generating"
        : live.status || "generating",
    progress: nextProgress,
    progressSource: snapshot.percent != null || snapshot.downloadReady || raw ? "dola" : live.progressSource || "dola",
    dolaStage: raw ? "ready" : snapshot.failed ? "queued" : snapshot.stage,
    error: "",
  });
  if (snapshot.failed) {
    const tries = Number(live.okRetries || 0);
    const last = Number(live.lastOkRetryAt || 0);
    if (tries >= 4) {
      log?.("info", `${record.account || "Tài khoản"}: Dola vẫn lỗi tạo — đã gửi lại OK ${tries} lần, đang đợi, không đánh lỗi.`);
      return;
    }
    if (Date.now() - last < 20000) return;
    updateJob(record.id, {
      status: "generating",
      error: "",
      okRetries: tries + 1,
      lastOkRetryAt: Date.now(),
    });
    const { resendOkAfterFail } = await import("./dola.js");
    await resendOkAfterFail(page, { duration: live.duration || "30s", ratio: live.ratio || "16:9" }, log);
    return;
  }
  if (raw) {
    await saveWatermarkFree(page, raw, live, log);
    return;
  }
  if (snapshot.downloadReady || snapshot.stage === "ready") {
    log?.("info", `${record.account || "Tài khoản"}: video đã xong — đang đợi DragonBMT đưa bản không watermark, không bấm tải có logo.`);
  }
}
