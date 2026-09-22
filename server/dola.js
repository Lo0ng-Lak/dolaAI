import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadAccounts, saveAccounts } from "./store.js";
import { closeAccountSession, getAccountSession, markAccount, listOpenSessions, parkAccountSession, sessionPurpose } from "./sessions.js";
import { clampDailyLimit, normalizeAccountQuota } from "../shared/quota.js";
import { buildPromptWithSpecs, continueAfterDurationRefusal, forcedDuration, stripSpecBlock } from "../shared/promptSpec.js";
import { durationSeconds, forcedDurationLabel, getCachedStudioRelay, resolveStudioRelayPath } from "./extension.js";
import { createLiveJob, setRunContext, startVideoWatch, updateJob } from "./videos.js";
import { scheduleCollect } from "./collect.js";
import { mapDolaPercent, readDolaTaskState } from "./progress.js";

export const DOLA_URL = "https://www.dola.com/chat/";
let running = false;
let cancelled = false;
let rotateAccountCursor = 0;

export function cancelRun() {
  if (!running) return { ok: false, running: false };
  cancelled = true;
  return { ok: true, running: true };
}

export function getStatus() {
  const extension = getCachedStudioRelay();
  return {
    running,
    browserOpen: listOpenSessions().length > 0,
    openAccounts: listOpenSessions(),
    url: DOLA_URL,
    extension: extension
      ? { ready: true, source: extension.source, path: extension.path, name: extension.name }
      : { ready: false },
  };
}

async function clickByTexts(target, texts, timeout = 2500) {
  for (const text of texts) {
    const loc = target.getByText(text, { exact: false }).first();
    try {
      if (await loc.isVisible({ timeout })) {
        await loc.click({ timeout });
        return text;
      }
    } catch {
      // try next
    }
  }
  return null;
}

async function pageNeedsLogin(page) {
  return page
    .getByText(/sign in|log in|session expired|please sign in|đăng nhập/i)
    .first()
    .isVisible({ timeout: 2500 })
    .catch(() => false);
}

export async function openAccountBrowser(accountId, log) {
  const { account, page } = await getAccountSession(accountId, log, { purpose: "login" });
  await startVideoWatch(log);
  await page.goto(DOLA_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(800);
  const needLogin = await pageNeedsLogin(page);
  if (needLogin) {
    await waitForStudioRelay(page, log);
    await applyStudioRelaySettings(page, { duration: "30s", ratio: "16:9" }, log);
    await markAccount(accountId, { status: "need_login", sessionOk: false, lastCheck: new Date().toISOString() });
    log("info", `${account.email}: chưa login — giữ Chrome để đăng nhập Google. Xong thì cookie giữ trong profile.`);
  } else {
    await markAccount(accountId, { status: "active", sessionOk: true, lastCheck: new Date().toISOString() });
    log("info", `${account.email}: cookie đã đăng nhập — tắt Chrome.`);
    await closeAccountSession(accountId);
  }
  return { accountId, needLogin };
}

export async function checkAccountSession(accountId, log) {
  const keep = sessionPurpose(accountId) === "run" || sessionPurpose(accountId) === "watch";
  const { account, page } = await getAccountSession(accountId, log);
  await page.goto(DOLA_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1200);
  const needLogin = await pageNeedsLogin(page);
  const patch = {
    status: needLogin ? "need_login" : "active",
    sessionOk: !needLogin,
    lastCheck: new Date().toISOString(),
  };
  await markAccount(accountId, patch);
  if (!keep) {
    await closeAccountSession(accountId);
    log(needLogin ? "warn" : "info", `${account.email}: ${needLogin ? "chưa đăng nhập / hết phiên" : "phiên còn hiệu lực"} — đã tắt Chrome.`);
  } else {
    log(needLogin ? "warn" : "info", `${account.email}: ${needLogin ? "chưa đăng nhập / hết phiên" : "phiên còn hiệu lực"}.`);
  }
  return patch;
}

async function selectCreateVideo(page, log) {
  const hit = await clickByTexts(page, [
    "Create Videos",
    "Create Video",
    "Generate Videos",
    "Generate Video",
  ], 4000);
  if (hit) {
    log("info", `Đã chọn ${hit}.`);
    return;
  }
  throw new Error('Không thấy nút "Create Videos". Kiểm tra phiên đã đăng nhập.');
}

async function selectFastMode(page, log) {
  const pro = page.getByText(/^\s*(✨\s*)?pro\s*>?\s*$/i).first();
  if (await pro.isVisible({ timeout: 600 }).catch(() => false)) {
    const fast = await clickByTexts(page, ["Fast", "⚡ Fast"], 1500);
    if (fast) log("info", "Đã chuyển Fast để DragonBMT ép 30/60s.");
  }
}

async function selectModel25(page, log) {
  const already = page.getByText(/Seedance\s*2\.5|Dreamina\s*Seedance\s*2\.5/i).first();
  if (await already.isVisible({ timeout: 1200 }).catch(() => false)) {
    const label = (await already.innerText().catch(() => "")).trim();
    if (label && !/2\.0|1\.0/.test(label)) {
      log("info", "Model 2.5 đã được chọn.");
      return;
    }
  }

  await clickByTexts(page, ["Dreamina Seedance 2.0 Fast", "2.0 Fast", "Seedance 2.0", "Model"], 2500);
  await page.waitForTimeout(400);
  const picked = await clickByTexts(page, ["Dreamina Seedance 2.5", "Seedance 2.5", "2.5"], 3000);
  if (!picked) throw new Error("Không chọn được Dreamina Seedance 2.5.");
  log("info", `Đã chọn model ${picked}.`);
}

async function writeImages(images) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dola-refs-"));
  const files = [];
  for (const image of images || []) {
    if (!image?.data) continue;
    const name = (image.name || `ref-${files.length + 1}.png`).replace(/[<>:"/\\|?*]/g, "_");
    const filePath = path.join(dir, name);
    await fs.writeFile(filePath, Buffer.from(image.data, "base64"));
    files.push(filePath);
  }
  return { dir, files };
}

async function uploadImages(page, files, log) {
  if (!files.length) {
    log("warn", "Task không có ảnh tham chiếu — chỉ gửi prompt.");
    return;
  }
  let input = page.locator('input[type="file"]').first();
  if ((await input.count()) === 0) {
    await clickByTexts(page, ["Upload", "Attach", "Image", "Photo", "Add"], 1500);
    input = page.locator('input[type="file"]').first();
  }
  if ((await input.count()) === 0) throw new Error("Không thấy ô tải ảnh trên Dola.");
  await input.setInputFiles(files);
  log("info", `Đã gửi ${files.length} ảnh tham chiếu.`);
  await page.waitForTimeout(800);
}

async function fillPrompt(page, prompt, log) {
  const editable = page.locator('[contenteditable="true"]');
  if (await editable.count()) {
    const box = editable.last();
    await box.click();
    await box.evaluate((el, text) => {
      el.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, text);
    }, prompt);
    log("info", "Đã dán prompt vào khung chat.");
    return;
  }
  const area = page.locator("textarea").last();
  if (await area.count()) {
    await area.fill(prompt);
    log("info", "Đã dán prompt vào textarea.");
    return;
  }
  throw new Error("Không thấy ô nhập prompt trên Dola.");
}

async function sendMessage(page, log) {
  const named = page.getByRole("button", { name: /send|submit|gửi/i }).first();
  if (await named.isVisible({ timeout: 800 }).catch(() => false)) {
    await named.click();
    log("info", "Đã bấm gửi.");
    return;
  }
  await page.locator('[contenteditable="true"], textarea').last().click();
  await page.keyboard.press("Control+Enter");
  log("info", "Đã gửi prompt bằng Ctrl+Enter.");
}

export async function waitForStudioRelay(page, log) {
  const ready = await page
    .waitForFunction(
      () =>
        Boolean(
          window.__studioRelaySessionShieldActive ||
            window.__isStudioRelayBypassRequest ||
            window.__isStudioRelayProModeActive,
        ),
      { timeout: 6000 },
    )
    .catch(() => null);
  if (!ready) {
    log("warn", "DragonBMT chưa gắn vào tab Dola. Kiểm tra extension đã được nạp.");
    return false;
  }
  log("info", "DragonBMT đã gắn vào tab Dola.");
  return true;
}

export async function applyStudioRelaySettings(page, settings, log) {
  const duration = durationSeconds(forcedDurationLabel(settings.duration));
  const ratio = settings.ratio || "16:9";
  await page.evaluate(
    ({ duration: nextDuration, ratio: nextRatio }) => {
      window.__dolaActiveModel = "fast";
      const payload = {
        ratio: nextRatio,
        duration: nextDuration,
        autoDownload: true,
        offPeakTurbo: true,
        autoNextPrompt: true,
      };
      for (const type of [
        "SET_RATIO_OVERRIDE",
        "PURZA_UPDATE_SETTINGS",
        "ZDOLA_APPLY_SETTINGS",
        "SET_ACTIVE_RATIO",
      ]) {
        window.postMessage({ type, ...payload }, "*");
      }
    },
    { duration, ratio },
  );
  log("info", `DragonBMT ép ${duration}s · ${ratio}`);
}

async function pageHasDurationRefusal(page, timeout = 1800) {
  return page
    .getByText(/không thể.*(?:30|60)|không hỗ trợ.*(?:30|60)|can't.*(?:30|60)|cannot.*(?:30|60)|not support.*(?:30|60)|unable.*(?:30|60)|unsupported.*(?:duration|30|60)|max(?:imum)?(?: duration)?(?: is)?\s*(?:10|15|30)|only(?: supports?)?\s*(?:10|15|30)\s*s|does not support/i)
    .first()
    .isVisible({ timeout })
    .catch(() => false);
}

async function pageLooksBusy(page) {
  return page
    .getByText(/generat|đang tạo|in progress|queued|rendering/i)
    .first()
    .isVisible({ timeout: 350 })
    .catch(() => false);
}

async function waitForDurationRefusal(page, log, ms = 7000) {
  const deadline = Date.now() + ms;
  let sawBusy = false;
  while (Date.now() < deadline) {
    if (await pageHasDurationRefusal(page, 500)) return true;
    if (await pageLooksBusy(page)) {
      if (sawBusy) {
        log("info", "Dola đã nhận task — không chờ thêm thông báo từ chối.");
        return false;
      }
      sawBusy = true;
    }
    await page.waitForTimeout(280);
  }
  log("info", "Dola chưa báo từ chối duration — giữ nguyên prompt vừa gửi.");
  return false;
}

async function dismissDurationDialog(page) {
  await clickByTexts(page, [
    "Got it",
    "OK",
    "Okay",
    "Continue",
    "Dismiss",
    "Close",
    "Understand",
    "Đã hiểu",
    "Đóng",
    "Tiếp tục",
    "Bỏ qua",
  ], 800);
}

async function continueSameTaskAfterRefusal(page, settings, log) {
  const duration = forcedDuration(settings);
  await dismissDurationDialog(page);
  if (settings.extension !== false) {
    await applyStudioRelaySettings(page, settings, log);
  }
  const followUp = continueAfterDurationRefusal(settings);
  await fillPrompt(page, followUp, log);
  await sendMessage(page, log);
  log("info", `Dola đã báo không làm ${duration} — đã gửi câu "OK vẫn tiếp tục" cho đúng task này. DragonBMT vẫn ép ${duration}.`);
}

async function ensureDolaReady(page, settings, log) {
  const onDola = /dola\.com/i.test(page.url());
  if (!onDola) {
    await page.goto(DOLA_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1000);
  }
  if (await pageNeedsLogin(page)) {
    throw new Error("Phiên hết đăng nhập. Mở trình duyệt của tài khoản này và đăng nhập lại.");
  }
  if (settings.extension !== false) {
    const attached = await waitForStudioRelay(page, log);
    if (attached) await applyStudioRelaySettings(page, settings, log);
  }
  try {
    await selectCreateVideo(page, log);
  } catch (err) {
    log("warn", `${err.message} — gửi trên màn hình hiện tại.`);
  }
  await page.waitForTimeout(300);
  await selectFastMode(page, log);
  try {
    await selectModel25(page, log);
  } catch (err) {
    log("warn", err.message);
  }
}

async function runOneTask(page, task, settings, log, { setupPage = true } = {}) {
  if (!task.prompt?.trim()) throw new Error(`${task.title}: prompt trống.`);
  const forced = forcedDuration(settings);
  const prompt = buildPromptWithSpecs(task.prompt, { ...settings, duration: forced });
  if (setupPage) await ensureDolaReady(page, { ...settings, duration: forced }, log);
  else if (settings.extension !== false) await applyStudioRelaySettings(page, { ...settings, duration: forced }, log);

  const packed = await writeImages(task.images);
  try {
    if (setupPage) await uploadImages(page, packed.files, log);
    log("info", `Gửi ${forced} qua DragonBMT · ${settings.ratio || "16:9"} · ${settings.model || "Seedance 2.5"}`);
    await fillPrompt(page, prompt, log);
    await sendMessage(page, log);
    log("info", `Đã gửi prompt gốc (${forced}). Đợi Dola báo duration...`);
    const refused = await waitForDurationRefusal(page, log);
    if (refused) {
      await continueSameTaskAfterRefusal(page, { ...settings, duration: forced }, log);
    } else {
      log("info", `Không có thông báo từ chối — task ${task.title} tiếp tục với ${forced} qua DragonBMT.`);
    }
  } finally {
    await fs.rm(packed.dir, { recursive: true, force: true }).catch(() => {});
  }
}

function pickAccounts(all, selectedIds, rotate) {
  const pool = all.filter((a) => selectedIds.includes(a.id)).map((account) => normalizeAccountQuota(account));
  if (!pool.length) throw new Error("Chưa chọn tài khoản để chạy task.");
  if (!rotate) return pool;
  const ordered = [...pool.slice(rotateAccountCursor % pool.length), ...pool.slice(0, rotateAccountCursor % pool.length)];
  rotateAccountCursor += 1;
  return ordered;
}

function pickAccountWithQuota(pool, rotate) {
  const eligible = pool.filter((account) => account.remaining > 0);
  if (!eligible.length) return null;
  if (!rotate) return eligible[0];
  const picked = eligible[rotateAccountCursor % eligible.length];
  rotateAccountCursor += 1;
  return picked;
}

async function consumeDailyQuota(accountId, defaultLimit, log) {
  const accounts = await loadAccounts();
  let updated = null;
  const next = accounts.map((account) => {
    const normalized = normalizeAccountQuota(account, defaultLimit);
    if (normalized.id !== accountId) return normalized;
    normalized.sentToday += 1;
    normalized.remaining = Math.max(0, normalized.dailyLimit - normalized.sentToday);
    normalized.quotaFull = normalized.remaining <= 0;
    updated = normalized;
    return normalized;
  });
  await saveAccounts(next);
  if (updated) {
    log(
      "info",
      `${updated.email}: hôm nay ${updated.sentToday}/${updated.dailyLimit} video · còn ${updated.remaining}. Ngày mai reset.`,
    );
  }
  return updated;
}

export async function runTasks(payload, log) {
  if (running) throw new Error("Đang chạy task khác. Đợi xong rồi chạy tiếp.");
  running = true;
  cancelled = false;
  try {
    const tasks = payload?.tasks || [];
    const settings = payload?.settings || {};
    const selectedIds = payload?.accountIds || [];
    if (!tasks.length) throw new Error("Không có task để chạy.");
    if (settings.extension !== false) {
      const extension = (await resolveStudioRelayPath()) || getCachedStudioRelay();
      if (extension?.path) {
        log("info", `Chạy qua DragonBMT (${extension.source}). Duration/download do extension xử lý.`);
      } else {
        log("warn", "Không tìm thấy DragonBMT. Cài extension hoặc giữ thư mục studiorelay/ trong project.");
      }
    }

    const forced = forcedDuration(settings);
    const runSettings = { ...settings, duration: forced, extension: true };
    setRunContext({
      duration: forced,
      resolution: settings.resolution || "2160p",
      lanczos: settings.resolution !== "off",
    });
    await startVideoWatch(log);
    log("info", `Ép ${forced} qua DragonBMT. Nếu Dola báo không hỗ trợ thì gửi "OK vẫn tiếp tục" trên đúng task đó.`);

    const defaultLimit = clampDailyLimit(settings.dailyLimit, 2);
    const accounts = (await loadAccounts()).map((account) =>
      normalizeAccountQuota({
        ...account,
        dailyLimit: account.dailyLimit || defaultLimit,
      }, defaultLimit),
    );
    await saveAccounts(accounts);
    pickAccounts(accounts, selectedIds, Boolean(settings.rotateAccounts));
    const loggedIn = accounts.filter((account) => selectedIds.includes(account.id) && account.status === "active" && account.sessionOk);
    if (!loggedIn.length) {
      throw new Error("Chưa có tài khoản đã đăng nhập. Mở trình duyệt, login Google một lần, rồi chạy.");
    }
    if (loggedIn.length < selectedIds.length) {
      log("warn", `Bỏ ${selectedIds.length - loggedIn.length} tài khoản chưa login / hết phiên.`);
    }
    const runAccountIds = loggedIn.map((account) => account.id);
    const repeats = Math.max(1, Number(settings.videoCount) || 1);
    const queue = tasks.flatMap((task) => Array.from({ length: repeats }, () => task));
    let sent = 0;
    const setupOnce = new Set();
    const busy = new Set();
    const hideChrome = settings.hideChrome !== false;
    const startDelay = Math.max(0, Number(settings.startDelay) || 0);
    const nextDelay = Math.max(0, Number(settings.nextDelay) || 0);
    const concurrency = Math.min(
      8,
      Math.max(1, Math.floor(Number(settings.concurrency) || 2)),
      runAccountIds.length || 1,
      queue.length || 1,
    );
    if (startDelay) {
      log("info", `Chờ ${startDelay}s trước khi chạy.`);
      await new Promise((resolve) => setTimeout(resolve, startDelay * 1000));
    }

    log("info", `Chạy song song tối đa ${concurrency} trình duyệt. 1 email = 1 Chrome. IP theo proxy từng tài khoản.`);

    let pickChain = Promise.resolve();
    const withPickLock = (fn) => {
      const run = pickChain.then(fn, fn);
      pickChain = run.catch(() => {});
      return run;
    };

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const runJob = async (task, account) => {
      setRunContext({ accountEmail: account.email, accountId: account.id });
      const firstOnAccount = !setupOnce.has(account.id);
      log(
        "info",
        `${task.title} → ${account.email} · 1 phiên riêng · còn ${account.remaining}/${account.dailyLimit} hôm nay · ${forced}`,
      );
      const job = createLiveJob({
        accountEmail: account.email,
        accountId: account.id,
        duration: forced,
        ratio: settings.ratio || "16:9",
        prompt: stripSpecBlock(task.prompt || ""),
        resolution: settings.resolution || "2160p",
        lanczos: settings.resolution !== "off",
        title: account.email,
        status: "sending",
      });
      try {
        const { page } = await getAccountSession(account.id, log, { purpose: "run" });
        await runOneTask(page, task, runSettings, log, { setupPage: firstOnAccount });
        setupOnce.add(account.id);
        sent += 1;
        await consumeDailyQuota(account.id, defaultLimit, log);
        const snapshot = await readDolaTaskState(page, { promptHint: stripSpecBlock(task.prompt || "") });
        updateJob(job.id, {
          status: snapshot.failed ? "failed" : "generating",
          progress: mapDolaPercent(snapshot, 8),
          progressSource: snapshot.percent != null || snapshot.downloadReady ? "dola" : "tool",
          dolaStage: snapshot.stage,
          error: snapshot.failed ? "Dola báo tạo video thất bại." : "",
        });
        if (hideChrome) {
          await parkAccountSession(account.id);
          log("info", `${account.email}: đã gửi. Ẩn Chrome, giữ phiên nền để đọc % và tải file.`);
        } else {
          log("info", `${account.email}: đã gửi. Giữ Chrome theo cài đặt.`);
        }
        if (snapshot.failed) {
          log("error", `${account.email}: Dola báo lỗi ngay sau khi gửi.`);
          return;
        }
        scheduleCollect({ accountId: account.id, jobId: job.id, log });
      } catch (err) {
        if (job) updateJob(job.id, { status: "failed", error: err.message });
        log("error", `${task.title} / ${account.email}: ${err.message}`);
        if (hideChrome && !/đăng nhập|sign in|hết phiên/i.test(err.message)) {
          await closeAccountSession(account.id);
          setupOnce.delete(account.id);
        }
      }
    };

    const worker = async () => {
      while (true) {
        if (cancelled) {
          log("warn", "Đã hủy chạy — dừng các task còn lại.");
          queue.splice(0, queue.length);
          return;
        }
        const claimed = await withPickLock(async () => {
          if (cancelled || !queue.length) return null;
          const live = (await loadAccounts()).map((account) => normalizeAccountQuota(account, defaultLimit));
          const free = live.filter((account) => runAccountIds.includes(account.id) && !busy.has(account.id));
          const account = pickAccountWithQuota(free, Boolean(settings.rotateAccounts));
          if (!account) return { wait: busy.size > 0 };
          const task = queue.shift();
          busy.add(account.id);
          return { task, account };
        });

        if (!claimed) return;
        if (claimed.wait) {
          if (!queue.length) return;
          await sleep(800);
          continue;
        }
        if (!claimed.task) {
          const leftover = queue.splice(0, queue.length);
          for (const skipped of leftover) {
            log("warn", `Bỏ ${skipped.title}: hết hạn hôm nay (1–2 video / tài khoản).`);
          }
          log("warn", leftover.length
            ? `Hết hạn mức. ${leftover.length} task còn lại chạy ngày mai, có thể đổi proxy.`
            : "Hết hạn mức hôm nay. Ngày mai chạy tiếp, có thể đổi proxy.");
          return;
        }

        try {
          await runJob(claimed.task, claimed.account);
        } finally {
          busy.delete(claimed.account.id);
        }
        if (nextDelay && queue.length) await sleep(nextDelay * 1000);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    log("info", `Đã gửi ${sent} lượt. Theo dõi hoàn thiện ở danh sách tác vụ video.`);
    return { sent, accounts: await loadAccounts(), openAccounts: listOpenSessions() };
  } finally {
    running = false;
  }
}

export async function importCookies(accountId, cookies, log) {
  if (!Array.isArray(cookies) || !cookies.length) {
    throw new Error("Cookie không hợp lệ. Dán JSON mảng cookie của chính tài khoản này.");
  }
  const { account, context, page } = await getAccountSession(accountId, log, { purpose: "login" });
  const normalized = cookies
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain || ".dola.com",
      path: c.path || "/",
      httpOnly: Boolean(c.httpOnly),
      secure: c.secure !== false,
      sameSite: c.sameSite || "Lax",
    }))
    .filter((c) => c.name && c.value);
  await context.addCookies(normalized);
  await page.goto(DOLA_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const needLogin = await pageNeedsLogin(page);
  await markAccount(accountId, {
    status: needLogin ? "need_login" : "active",
    sessionOk: !needLogin,
    lastCheck: new Date().toISOString(),
  });
  if (!needLogin) {
    await closeAccountSession(accountId);
    log("info", `${account.email}: đã nạp ${normalized.length} cookie — phiên Active, tắt Chrome.`);
  } else {
    log("warn", `${account.email}: đã nạp ${normalized.length} cookie nhưng vẫn chưa login — giữ Chrome.`);
  }
  return { count: normalized.length, needLogin };
}

export async function replaceAccounts(next) {
  return saveAccounts(next);
}
