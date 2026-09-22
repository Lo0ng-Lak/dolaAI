import { closeAccountSession, getAccountSession, getOpenPage, parkAccountSession, sessionPurpose } from "./sessions.js";
import { clickReadyDownloads, mapDolaPercent, readDolaTaskState } from "./progress.js";
import { getVideoRecord, listPendingJobs, updateJob, waitForJobFile } from "./videos.js";

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
  log?.("info", "Giữ Chrome ẩn nền — đọc % liên tục, xong thì tải, không mở/tắt đi mở lại.");
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
            await page.goto(DOLA_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
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

async function peekJob(page, record, log) {
  const snapshot = await readDolaTaskState(page, { promptHint: record.prompt || "" });
  const live = getVideoRecord(record.id) || record;
  const nextProgress = mapDolaPercent(snapshot, live.progress || 8);
  updateJob(record.id, {
    status: snapshot.failed
      ? "failed"
      : snapshot.downloadReady || snapshot.stage === "ready"
        ? "collecting"
        : live.status || "generating",
    progress: nextProgress,
    progressSource: snapshot.percent != null || snapshot.downloadReady ? "dola" : live.progressSource || "dola",
    dolaStage: snapshot.stage,
    error: snapshot.failed ? "Dola báo tạo video thất bại." : live.error || "",
  });
  if (snapshot.failed) {
    clearJobTimers(record.id);
    log?.("error", `${record.account || "Tài khoản"}: Dola báo lỗi tạo video.`);
    return;
  }
  if (snapshot.downloadReady || snapshot.stage === "ready") {
    const clicked = await clickReadyDownloads(page);
    if (clicked) log?.("info", "Video đã xong trên Dola — đang tải vào tool.");
  }
}
