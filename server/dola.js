import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadAccounts, saveAccounts } from "./store.js";
import { closeAccountSession, getAccountSession, markAccount, listOpenSessions, parkAccountSession, sessionPurpose } from "./sessions.js";
import { clampDailyLimit, normalizeAccountQuota } from "../shared/quota.js";
import { buildPromptWithSpecs, continueAfterDurationRefusal, forcedDuration, normalizeRatio, stripSpecBlock } from "../shared/promptSpec.js";
import { durationSeconds, forcedDurationLabel, getCachedStudioRelay, resolveStudioRelayPath } from "./extension.js";
import { createLiveJob, setRunContext, startVideoWatch, updateJob } from "./videos.js";
import { scheduleCollect } from "./collect.js";
import { mapDolaPercent, readDolaTaskState } from "./progress.js";
import { armFetchGate, restoreSession, snapshotSession } from "./authLock.js";
import { maybeSolveCaptcha } from "./captcha.js";

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

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickByTexts(target, texts, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const text of texts) {
      const loc = target.getByText(text, { exact: false }).locator("visible=true").last();
      if (await loc.isVisible({ timeout: 120 }).catch(() => false)) {
        try {
          await loc.click({ timeout: 1500, force: true });
          return text;
        } catch {
          // try next label
        }
      }
    }
    await sleepMs(150);
  }
  return null;
}

async function waitForComposer(page, log, ms = 12000) {
  const found = await page
    .waitForFunction(() => {
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          rect.width > 16 &&
          rect.height > 12 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || "1") > 0.1 &&
          rect.bottom > 0 &&
          rect.top < innerHeight
        );
      };
      return [...document.querySelectorAll('[contenteditable="true"], textarea, [role="textbox"]')].some(visible);
    }, null, { timeout: ms })
    .catch(() => null);
  if (!found) log?.("warn", "Chưa thấy ô chat Dola đang hiện trên trang.");
  return Boolean(found);
}

async function clickCreateVideoChip(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return (
        rect.width > 16 &&
        rect.height > 12 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        Number(style.opacity || "1") > 0.1 &&
        rect.bottom > 0 &&
        rect.top < innerHeight
      );
    };
    const re = /create\s*videos?/i;
    const nodes = [...document.querySelectorAll('button, [role="button"], [role="tab"]')];
    const hit = nodes.find((el) => {
      const text = `${el.innerText || ""} ${el.getAttribute("aria-label") || ""}`.replace(/\s+/g, " ").trim();
      if (!re.test(text) || text.length > 48) return false;
      if (el.closest('[contenteditable="true"], textarea')) return false;
      return visible(el);
    });
    if (!hit) return "";
    const overlay = hit.querySelector("div.absolute.opacity-0");
    (overlay || hit).click();
    if (typeof hit.click === "function") hit.click();
    return (hit.innerText || "Create Videos").replace(/\s+/g, " ").trim().slice(0, 40);
  });
}

function isGoogleLoginUrl(url) {
  return /accounts\.google\.com|accounts\.youtube\.com/i.test(url || "") && !/dola\.com/i.test(url || "");
}

async function readLoginState(page) {
  const url = page.url();
  if (isGoogleLoginUrl(url)) {
    return { needLogin: true, loggedIn: false, reason: "Đang ở trang đăng nhập Google." };
  }
  if (/dola\.com\/(login|signin|auth|account)/i.test(url) && !/dola\.com\/chat/i.test(url)) {
    return { needLogin: true, loggedIn: false, reason: "Dola đang ở trang login." };
  }

  return page
    .evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          rect.width > 8 &&
          rect.height > 8 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || "1") > 0.05 &&
          rect.bottom > 0 &&
          rect.top < innerHeight
        );
      };
      const textOf = (el) =>
        `${el.innerText || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`.replace(/\s+/g, " ").trim();

      const composer = [...document.querySelectorAll('[contenteditable="true"], textarea, [role="textbox"]')].some(visible);
      const videoChip = [...document.querySelectorAll("button, [role='button'], [role='tab'], span, div")].some(
        (el) => visible(el) && /create\s*video|generate\s*video|tạo\s*video/i.test(textOf(el)),
      );
      const messageBox = [...document.querySelectorAll("[placeholder], [data-placeholder]")].some((el) =>
        /message/i.test(el.getAttribute("placeholder") || el.getAttribute("data-placeholder") || ""),
      );
      if (composer || videoChip || messageBox) {
        return { needLogin: false, loggedIn: true, reason: "Đã vào chat Dola (ô Message / Create Videos)." };
      }

      const googleBtn = [...document.querySelectorAll("button, a, [role='button']")].find((el) => {
        if (!visible(el)) return false;
        return /sign in with google|continue with google|đăng nhập.*google/i.test(textOf(el));
      });
      if (googleBtn) {
        return { needLogin: true, loggedIn: false, reason: "Thấy nút Sign in with Google." };
      }

      const signIn = [...document.querySelectorAll("button, a")].find((el) => {
        if (!visible(el)) return false;
        return /^(sign in|log in|đăng nhập)$/i.test((el.innerText || "").replace(/\s+/g, " ").trim());
      });
      if (signIn) {
        const rect = signIn.getBoundingClientRect();
        if (rect.width > 88 && rect.height > 28) {
          return { needLogin: true, loggedIn: false, reason: "Thấy nút Đăng nhập." };
        }
      }

      return { needLogin: false, loggedIn: false, reason: "Trang chưa hiện chat lẫn login." };
    })
    .catch(() => ({ needLogin: false, loggedIn: false, reason: "Không đọc được trang." }));
}

async function hasGoogleSessionCookies(context) {
  if (!context?.cookies) return false;
  const cookies = await context.cookies().catch(() => []);
  return cookies.some(
    (cookie) =>
      /\.google\.com$/i.test(cookie.domain || "") &&
      /^(SID|HSID|SSID|APISID|SAPISID|__Secure-1PSID)$/i.test(cookie.name || "") &&
      Boolean(cookie.value),
  );
}

async function inspectSession(page, log, context, waitMs = 2000) {
  const deadline = Date.now() + waitMs;
  let state = await readLoginState(page);
  while (Date.now() < deadline && !state.loggedIn && !state.needLogin) {
    await sleepMs(200);
    state = await readLoginState(page);
  }

  if (state.loggedIn) return state;
  if (state.needLogin) return state;

  const url = page.url();
  if (isGoogleLoginUrl(url)) {
    return { needLogin: true, loggedIn: false, reason: "Đang ở trang đăng nhập Google." };
  }
  const googleCookies = await hasGoogleSessionCookies(context);
  if (googleCookies && /dola\.com/i.test(url)) {
    return { needLogin: false, loggedIn: true, reason: "Cookie Google còn và đang ở Dola." };
  }
  return { needLogin: true, loggedIn: false, reason: "Chưa login — không thấy ô chat và không có cookie Google." };
}

const HIGH_DEMAND_RE =
  /experiencing high demand|high demand right now|please try again later|too many requests|rate limit|server (is )?busy|quá tải|thử lại sau/;

async function isHighDemand(page) {
  return page
    .evaluate((source) => {
      const re = new RegExp(source, "i");
      const text = String(document.body?.innerText || "");
      return re.test(text);
    }, HIGH_DEMAND_RE.source)
    .catch(() => false);
}

async function dismissHighDemand(page) {
  return clickByTexts(page, ["Try again", "Try Again", "Retry", "Thử lại"], 1000);
}

async function sessionKickedOut(page) {
  if (page.isClosed()) return true;
  if (isGoogleLoginUrl(page.url())) return true;
  if (/dola\.com\/(login|signin|auth)/i.test(page.url()) && !/dola\.com\/chat/i.test(page.url())) return true;
  if (await isHighDemand(page)) return false;
  return page
    .evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          rect.width > 80 &&
          rect.height > 28 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || "1") > 0.4 &&
          rect.bottom > 0 &&
          rect.top < innerHeight
        );
      };
      return [...document.querySelectorAll("button, a, [role='button']")].some((el) => {
        if (!visible(el)) return false;
        return /sign in with google|continue with google|đăng nhập.*google/i.test(
          `${el.innerText || ""} ${el.getAttribute("aria-label") || ""}`,
        );
      });
    })
    .catch(() => false);
}

async function holdSession(page, snap, log) {
  if (!(await sessionKickedOut(page))) return true;
  log?.("warn", "Dola định đá phiên — đang giữ cookie/token, không cho logout.");
  await restoreSession(page, page.context(), snap);
  await sleepMs(500);
  if (await sessionKickedOut(page)) {
    await restoreSession(page, page.context(), snap);
    await sleepMs(400);
  }
  if (await sessionKickedOut(page)) return false;
  log?.("info", "Đã giữ phiên — vẫn ở Dola, không phải login lại.");
  return true;
}

const NET_KEEP = 30;
const NET_ERROR_BODY =
  /high demand|try again later|too many requests|system error|internal server error|"is_limit"\s*:\s*true|"status_code"\s*:\s*[1-9]|"error_code"\s*:\s*[1-9]|"code"\s*:\s*"?(?:4\d\d|5\d\d)\b/i;
const UPLOAD_OK_URL = /CommitImageUpload|CommitUpload|commit_upload|upload.*commit|\/upload\b|tos-[^/]*\/.+|ibytedtos|imagex|bytevcloud/i;

function pushNet(page, entry) {
  const list = page._dolaNet || (page._dolaNet = []);
  list.push({ at: Date.now(), ...entry });
  if (list.length > NET_KEEP) list.splice(0, list.length - NET_KEEP);
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.slice(0, 90);
  } catch {
    return String(url || "").slice(0, 90);
  }
}

function attachNetWatch(page) {
  if (!page || page._dolaNetWatch) return;
  page._dolaNetWatch = true;
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (!/dola\.com|byteintl|ibytedtos|bytedance|dola\.ai/i.test(url)) return;
    const type = request.resourceType();
    if (type !== "fetch" && type !== "xhr" && type !== "document" && type !== "eventsource") return;
    const reason = request.failure()?.errorText || "failed";
    if (/ERR_ABORTED/i.test(reason)) return;
    pushNet(page, { kind: "fail", method: request.method(), url: shortUrl(url), reason });
  });
  page.on("response", async (response) => {
    const request = response.request();
    const url = response.url();
    const uploadHost = /ibytedtos|byteintl|volces|bytevcloud|imagex|tos-|upload/i.test(url);
    if (!/dola\.com/i.test(url) && !uploadHost) return;
    const type = request.resourceType();
    if (type !== "fetch" && type !== "xhr") return;
    const status = response.status();
    const method = request.method();
    if (
      status >= 200 &&
      status < 300 &&
      (method === "POST" || method === "PUT") &&
      UPLOAD_OK_URL.test(url)
    ) {
      const list = page._dolaUploads || (page._dolaUploads = []);
      list.push({ at: Date.now(), url: shortUrl(url), commit: /commit/i.test(url) });
      if (list.length > NET_KEEP) list.splice(0, list.length - NET_KEEP);
    }
    if (uploadHost && status < 400) return;
    const post = method === "POST";
    if (!post && status < 400) return;
    const rewrote = await page.evaluate(() => window.__DOLA_REWRITE_READY === true).catch(() => null);
    let body = "";
    if (status >= 400 || post) {
      body = await Promise.race([
        response.text().catch(() => ""),
        sleepMs(20000).then(() => ""),
      ]);
    }
    const snippet = String(body || "").replace(/\s+/g, " ");
    const isJson = /^\s*[{[]/.test(snippet);
    const bad = status >= 400 || (isJson && NET_ERROR_BODY.test(snippet));
    if (!bad) return;
    const hit = snippet.match(NET_ERROR_BODY);
    const at = hit ? Math.max(0, hit.index - 80) : 0;
    pushNet(page, {
      kind: "http",
      method: request.method(),
      url: shortUrl(url),
      status,
      rewrote,
      body: snippet.slice(at, at + 240),
    });
  });
}

function explainNet(page, log, sinceMs = 30000) {
  const list = (page?._dolaNet || []).filter((item) => Date.now() - item.at <= sinceMs);
  if (!list.length) {
    log("info", "Mạng: không thấy request Dola nào lỗi — lỗi đến từ phía Dola trả lời trong chat.");
    return { proxy: false, rewrite: false, server: true };
  }
  let proxy = false;
  let rewrite = false;
  for (const item of list.slice(-4)) {
    if (item.kind === "fail") {
      proxy = proxy || /TUNNEL|PROXY|CONNECTION|TIMED_OUT|NETWORK|RESET|CLOSED|SSL/i.test(item.reason);
      log("warn", `Mạng: ${item.method} ${item.url} hỏng (${item.reason}) — thường do proxy.`);
    } else {
      rewrite = rewrite || item.rewrote === true;
      log(
        "warn",
        `Mạng: ${item.method} ${item.url} → ${item.status}${item.rewrote ? " (lúc DragonBMT đang đổi request)" : " (request gốc, chưa đổi)"}${item.body ? ` · ${item.body}` : ""}`,
      );
    }
  }
  return { proxy, rewrite, server: !proxy && !rewrite };
}

async function gotoDola(page, log, { viaProxy = Boolean(page?._viaProxy), reload = false, timeout = 25000 } = {}) {
  attachNetWatch(page);
  await page.bringToFront().catch(() => {});
  if (page.url().startsWith("chrome-extension://")) {
    throw new Error("Đang đứng ở cửa sổ extension, không phải tab Dola.");
  }
  const already = /dola\.com\/chat/i.test(page.url());
  if (already && !reload) {
    const ready = await waitForComposer(page, null, 2500);
    if (ready) {
      log?.("info", "Tab Dola đã mở ô chat — đợi trang đứng yên.");
      await maybeSolveCaptcha(page, log);
      await reloadDolaForExtension(page, log);
      await sleepMs(400);
      return;
    }
  }
  log?.("info", viaProxy ? "Đang mở Dola qua proxy..." : "Đang mở Dola...");
  try {
    await page.goto(DOLA_URL, { waitUntil: "load", timeout });
    const ready = await waitForComposer(page, log, 12000);
    if (!ready) throw new Error("Dola mở xong nhưng chưa hiện ô chat. Không gửi khi còn trang trắng / trang chủ chưa load.");
    await maybeSolveCaptcha(page, log);
    await reloadDolaForExtension(page, log);
    await sleepMs(400);
  } catch (err) {
    const msg = String(err?.message || err);
    if (/ERR_PROXY|ERR_TUNNEL|ERR_SOCKS|ERR_CONNECTION|Timeout|timed out/i.test(msg)) {
      const text =
        "Không mở được web qua proxy. Proxy chết, sai loại (thử socks5://) hoặc bị chặn — đổi proxy hoặc chọn Direct.";
      log?.("error", text);
      throw new Error(text);
    }
    throw err;
  }
}

export async function openAccountBrowser(accountId, log) {
  const { account, page, context, viaProxy, proxyLabel } = await getAccountSession(accountId, log, { purpose: "login" });
  await startVideoWatch(log);
  log("info", `${account.email}: mở trình duyệt cài đặt trên ${proxyLabel || (viaProxy ? "proxy đã chọn" : "IP máy")}.`);
  await gotoDola(page, log, { viaProxy, reload: false });
  const state = await inspectSession(page, log, context);
  await waitForStudioRelay(page, log, 5000);
  if (state.needLogin) {
    await markAccount(accountId, { status: "need_login", sessionOk: false, lastCheck: new Date().toISOString() });
    log("warn", `${account.email}: chưa login — ${state.reason} Giữ Chrome để đăng nhập.`);
  } else {
    await markAccount(accountId, { status: "active", sessionOk: true, lastCheck: new Date().toISOString() });
    log("info", `${account.email}: phiên còn — ${state.reason}`);
  }
  return { accountId, needLogin: state.needLogin };
}

export async function checkAccountSession(accountId, log) {
  const keep = sessionPurpose(accountId) === "run" || sessionPurpose(accountId) === "watch";
  const { account, page, context, viaProxy } = await getAccountSession(accountId, log, { purpose: "login" });
  await gotoDola(page, log, { viaProxy });
  const state = await inspectSession(page, log, context);
  const patch = {
    status: state.needLogin ? "need_login" : "active",
    sessionOk: !state.needLogin,
    lastCheck: new Date().toISOString(),
  };
  await markAccount(accountId, patch);
  const line = `${account.email}: ${state.needLogin ? "hết phiên" : "phiên còn"} — ${state.reason}`;
  if (!keep) {
    await closeAccountSession(accountId);
    log(state.needLogin ? "warn" : "info", `${line} Đã tắt Chrome.`);
  } else {
    log(state.needLogin ? "warn" : "info", line);
  }
  return patch;
}

async function isCreateVideoMode(page) {
  return page
    .evaluate(() => {
      const btn = document.querySelector('[data-input-engine-actionbar-control-key="video-model"]');
      if (!btn) return false;
      const rect = btn.getBoundingClientRect();
      const style = getComputedStyle(btn);
      return (
        rect.width > 16 &&
        rect.height > 12 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        Number(style.opacity || "1") > 0.1 &&
        rect.bottom > 0 &&
        rect.top < innerHeight
      );
    })
    .catch(() => false);
}

async function waitUntilCreateVideo(page, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await isCreateVideoMode(page)) return true;
    await maybeSolveCaptcha(page, null);
    await sleepMs(160);
  }
  return isCreateVideoMode(page);
}

async function lockRewriteOff(page) {
  await armFetchGate(page);
  await page
    .evaluate(() => {
      window.__DOLA_REWRITE_READY = false;
    })
    .catch(() => {});
}

async function createVideoStable(page, holdMs = 700) {
  if (!(await isCreateVideoMode(page))) return false;
  await sleepMs(holdMs);
  return isCreateVideoMode(page);
}

// The Create Videos chip is a toggle: clicking it while the mode is on turns it off.
async function selectCreateVideo(page, log) {
  await maybeSolveCaptcha(page, log);
  if (await createVideoStable(page)) {
    log("info", "Đang ở Create Videos (nút Model hiện ổn định) — không bấm chip, qua bước sau.");
    return;
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (await createVideoStable(page, 300)) {
      log("info", "Đã vào Create Videos — nút Model hiện ổn định. Mới qua bước chọn mode.");
      return;
    }
    log("info", `Chưa ở Create Videos — bấm chip Create Videos (lần ${attempt}).`);
    const clicked = await clickCreateVideoChip(page).catch(() => "");
    if (!clicked) throw new Error("Không thấy chip Create Videos trên Dola.");
    if (!(await waitUntilCreateVideo(page, 8000))) continue;
    await waitForComposer(page, null, 4000);
    if (await createVideoStable(page)) {
      log("info", "Đã vào Create Videos — nút Model hiện ổn định. Mới qua bước chọn mode.");
      return;
    }
    log("warn", `Lần ${attempt}: nút Model hiện rồi mất — kiểm tra lại.`);
  }
  throw new Error("Bấm Create Videos nhưng nút Model không đứng yên. Không gửi.");
}

async function selectFastMode(page, log) {
  const pro = page.getByText(/^\s*(✨\s*)?pro\s*>?\s*$/i).first();
  if (await pro.isVisible({ timeout: 600 }).catch(() => false)) {
    const fast = await clickByTexts(page, ["Fast", "⚡ Fast"], 1500);
    if (fast) log("info", "Đã chuyển Fast để DragonBMT ép 30/60s.");
  }
}

function modelChoice(settings) {
  const raw = String(settings?.model || "Dreamina Seedance 2.5");
  if (/2\.5/.test(raw)) {
    return {
      key: "2.5",
      label: "Seedance 2.5",
      match: /2\.5/,
    };
  }
  if (/1\.0/.test(raw)) {
    return {
      key: "1.0",
      label: "Seedance 1.0",
      match: /1\.0/,
    };
  }
  return {
    key: "2.0",
    label: "Seedance 2.0 Fast",
    match: /2\.0/,
  };
}

function toolbarHasModel(text, key) {
  const t = String(text || "");
  if (key === "2.5") return /2\.5/.test(t) && !/2\.0/.test(t);
  if (key === "1.0") return /1\.0/.test(t) && !/2\./.test(t);
  return /2\.0/.test(t);
}

function videoModelButton(page) {
  return page.locator('[data-input-engine-actionbar-control-key="video-model"]').first();
}

async function readVideoModelLabel(page) {
  return page
    .evaluate(() => {
      const btn = document.querySelector('[data-input-engine-actionbar-control-key="video-model"]');
      if (!btn) return "";
      const rect = btn.getBoundingClientRect();
      if (rect.width < 12 || rect.height < 10) return "";
      return (btn.innerText || btn.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    })
    .catch(() => "");
}

async function menuIsOpen(page) {
  return page
    .evaluate(() => {
      const btn = document.querySelector('[data-input-engine-actionbar-control-key="video-model"]');
      if (btn?.getAttribute("aria-expanded") === "true" || btn?.getAttribute("data-state") === "open") return true;
      return Boolean(
        document.querySelector('[role="menu"], [data-slot="dropdown-menu-content"], [data-radix-menu-content]'),
      );
    })
    .catch(() => false);
}

async function clickVideoModelButton(page) {
  const box = await page
    .evaluate(() => {
      const btn = document.querySelector('[data-input-engine-actionbar-control-key="video-model"]');
      if (!btn) return null;
      const target = btn.querySelector("div.absolute.opacity-0") || btn;
      const rect = target.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return null;
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })
    .catch(() => null);
  if (box) {
    await page.mouse.click(box.x, box.y);
    return true;
  }
  const trigger = videoModelButton(page);
  if (await trigger.count()) {
    await trigger.click({ force: true, timeout: 800 }).catch(() => {});
    return true;
  }
  return false;
}

async function clickModeInMenu(page, key) {
  const re = key === "2.5" ? /2\.5/ : key === "1.0" ? /1\.0/ : /2\.0/;
  const box = await page
    .evaluate((want) => {
      const match = want === "2.5" ? /2\.5/ : want === "1.0" ? /1\.0/ : /2\.0/;
      const nodes = [
        ...document.querySelectorAll('[role="menuitem"], [role="option"], [data-slot="dropdown-menu-item"], [data-radix-collection-item]'),
        ...document.querySelectorAll("button, [role='button'], div, span"),
      ];
      const hit = nodes.find((el) => {
        const text = (el.innerText || "").replace(/\s+/g, " ").trim();
        if (!match.test(text) || text.length > 64) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          rect.width > 20 &&
          rect.height > 12 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || "1") > 0.2
        );
      });
      if (!hit) return null;
      const target = hit.querySelector("div.absolute.opacity-0") || hit;
      const rect = target.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, label: (hit.innerText || want).replace(/\s+/g, " ").trim().slice(0, 48) };
    }, key)
    .catch(() => null);
  if (box) {
    await page.mouse.click(box.x, box.y);
    return box.label;
  }
  const loc = page.getByText(re).locator("visible=true").last();
  if (await loc.isVisible({ timeout: 200 }).catch(() => false)) {
    await loc.click({ force: true, timeout: 600 }).catch(() => {});
    return key;
  }
  return "";
}

async function waitForModelOnToolbar(page, choice, ms = 2500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const label = await readVideoModelLabel(page);
    if (toolbarHasModel(label, choice.key)) return label;
    await sleepMs(80);
  }
  return "";
}

async function selectConfiguredModel(page, settings, log) {
  await maybeSolveCaptcha(page, log);
  if (!(await isCreateVideoMode(page))) {
    throw new Error("Chưa vào Create Videos — không chọn model khi còn trang chủ.");
  }
  const choice = modelChoice(settings);
  let label = await readVideoModelLabel(page);
  if (toolbarHasModel(label, choice.key)) {
    log("info", `Nút Model đang ${choice.label} — bước này xong.`);
    return;
  }
  if (!label) {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && !label) {
      await sleepMs(80);
      label = await readVideoModelLabel(page);
    }
    if (!label) throw new Error("Không thấy nút Model trên thanh chat.");
    if (toolbarHasModel(label, choice.key)) {
      log("info", `Nút Model đang ${choice.label} — bước này xong.`);
      return;
    }
  }

  log("info", `Bấm nút Model rồi chọn ${choice.label} — đợi nút đổi chữ thì mới qua.`);
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (!(await isCreateVideoMode(page))) {
      throw new Error("Mất Create Videos khi chọn model. Không chọn model khi còn trang chủ.");
    }
    const opened = await menuIsOpen(page);
    if (!opened) {
      const clicked = await clickVideoModelButton(page);
      if (!clicked) throw new Error("Không bấm được nút Model trên thanh chat.");
      const waitUntil = Date.now() + 900;
      while (Date.now() < waitUntil && !(await menuIsOpen(page))) await sleepMs(50);
    }
    if (!(await menuIsOpen(page))) {
      log("info", `Lần ${attempt}: menu chưa mở, bấm lại.`);
      continue;
    }
    await clickModeInMenu(page, choice.key);
    const confirmed = await waitForModelOnToolbar(page, choice, 2200);
    if (confirmed) {
      log("info", `Đã chọn ${choice.label} — nút Model đang hiện đúng. Mới qua bước nhập prompt.`);
      return;
    }
    log("info", `Lần ${attempt}: đã bấm nhưng nút Model chưa đổi thành ${choice.label} — làm lại.`);
  }
  throw new Error(`Chưa thấy ${choice.label} trên nút Model. Không qua bước gửi.`);
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

async function readAttachmentState(page, baseKeys = []) {
  return page
    .evaluate((baseKeys) => {
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          rect.width > 4 &&
          rect.height > 4 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || "1") > 0.05
        );
      };
      const empty = { keys: [], newKeys: [], thumbs: 0, loaded: 0, busy: 0, errors: 0, tip: "", failedText: false, found: false };
      const box = [...document.querySelectorAll('[contenteditable="true"], textarea')].find(visible);
      if (!box) return empty;
      const boxRect = box.getBoundingClientRect();
      const inZone = (rect) =>
        rect.right > boxRect.left - 160 &&
        rect.left < boxRect.right + 160 &&
        rect.bottom > boxRect.top - 320 &&
        rect.top < boxRect.bottom + 160;
      const bgUrl = (el) => {
        const match = /url\(["']?([^"')]+)["']?\)/i.exec(getComputedStyle(el).backgroundImage || "");
        return match ? match[1] : "";
      };
      const candidates = [];
      for (const el of document.querySelectorAll("img, div, span, button, figure, li")) {
        if (!visible(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 24 || rect.height < 24 || rect.width > 420 || rect.height > 420) continue;
        if (!inZone(rect)) continue;
        const src = el.tagName === "IMG" ? el.currentSrc || el.src || "" : bgUrl(el);
        if (!/^(blob:|data:image|https?:)/i.test(src)) continue;
        if (/\.svg(\?|$)|avatar|logo|icon|emoji/i.test(src)) continue;
        const loaded = el.tagName === "IMG" ? el.complete && el.naturalWidth > 0 : true;
        candidates.push({ el, key: src.slice(0, 300), loaded });
      }
      const skip = new Set(Array.isArray(baseKeys) ? baseKeys : []);
      const fresh = candidates.filter((item) => !skip.has(item.key));
      const holderOf = (el) => {
        const own = el.getBoundingClientRect();
        let holder = el;
        for (let i = 0; i < 4 && holder.parentElement; i += 1) {
          const parent = holder.parentElement;
          const rect = parent.getBoundingClientRect();
          if (rect.width > own.width * 2.5 + 40 || rect.height > own.height * 2.5 + 40) break;
          holder = parent;
        }
        return holder;
      };
      let busy = 0;
      let errors = 0;
      let tip = "";
      for (const item of fresh) {
        const holder = holderOf(item.el);
        busy += [...holder.querySelectorAll(
          '[role="progressbar"], progress, [aria-busy="true"], [class*="loading" i], [class*="spinner" i], [class*="uploading" i], [class*="animate-spin"]',
        )].filter(visible).length;
        const bad = [...holder.querySelectorAll(
          '[class*="error" i], [class*="fail" i], [data-status="error"], [data-status="failed"]',
        )].filter(visible).length;
        const bangs = [...holder.querySelectorAll("span, div, i")].filter(
          (el) => visible(el) && el.children.length === 0 && (el.textContent || "").trim() === "!",
        ).length;
        errors += bad + bangs;
        if (!tip) {
          tip = [...holder.querySelectorAll("[title], [aria-label]")]
            .map((el) => `${el.getAttribute("title") || ""} ${el.getAttribute("aria-label") || ""}`.trim())
            .find((value) => /fail|error|retry|violat|large|support|lỗi/i.test(value)) || "";
        }
      }
      let zoneText = "";
      let node = box;
      for (let i = 0; i < 6 && node.parentElement; i += 1) node = node.parentElement;
      zoneText = String(node.innerText || "").toLowerCase();
      return {
        keys: candidates.map((item) => item.key),
        newKeys: fresh.map((item) => item.key),
        thumbs: fresh.length,
        loaded: fresh.filter((item) => item.loaded).length,
        busy,
        loadingText: /uploading|đang tải lên|processing image/.test(zoneText),
        errors,
        failedText: /upload failed|failed to upload|tải lên thất bại|image too large/.test(zoneText),
        tip: tip.slice(0, 160),
        found: true,
      };
    }, baseKeys)
    .catch(() => ({ keys: [], newKeys: [], thumbs: 0, loaded: 0, busy: 0, errors: 0, tip: "", failedText: false, found: false }));
}

async function waitImagesUploaded(page, want, base, log, ms = 60000) {
  const startedAt = Date.now();
  const deadline = startedAt + ms;
  const baseKeys = base.keys || [];
  let stableSince = 0;
  let last = null;
  let netOk = 0;
  while (Date.now() < deadline) {
    await maybeSolveCaptcha(page, log);
    const state = await readAttachmentState(page, baseKeys);
    state.loading = state.busy > 0 || (state.loadingText && !base.loadingText);
    last = state;
    const uploads = (page._dolaUploads || []).filter((item) => item.at >= startedAt);
    const commits = uploads.filter((item) => item.commit).length;
    netOk = commits || uploads.length;
    if ((state.failedText && !base.failedText) || state.errors > 0) {
      explainNet(page, log, 90000);
      throw Object.assign(
        new Error(
          `Ảnh hiện dấu ! — Dola không nhận ảnh${state.tip ? ` (${state.tip})` : ""}. Không gửi prompt khi ảnh chưa lên.`,
        ),
        { imageRejected: true },
      );
    }
    const domReady = state.thumbs >= want && state.loaded >= want && !state.loading;
    const netReady = netOk >= want && !state.loading;
    if (domReady || netReady) {
      if (!stableSince) stableSince = Date.now();
      const hold = domReady ? 1200 : commits >= want ? 1500 : 4000;
      if (Date.now() - stableSince >= hold) {
        const how = domReady
          ? `thấy ${state.thumbs} ảnh xem trước, hết vòng tải`
          : `máy chủ ảnh đã nhận ${netOk} lượt upload, không còn vòng tải`;
        log("info", `Đã tải lên xong ${want}/${want} ảnh (${how}). Mới dán prompt.`);
        return true;
      }
    } else {
      stableSince = 0;
    }
    await sleepMs(300);
  }
  explainNet(page, log, ms + 5000);
  throw new Error(
    `Ảnh chưa tải lên xong (thấy ${last?.thumbs || 0}/${want} ảnh xem trước, ${netOk} upload thành công${last?.loading ? ", vẫn đang tải" : ""}) sau ${Math.round(ms / 1000)}s. Không gửi prompt.`,
  );
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
  const base = await readAttachmentState(page);
  await input.setInputFiles(files);
  log("info", `Đang tải ${files.length} ảnh tham chiếu lên Dola — đợi xong mới dán prompt.`);
  await waitImagesUploaded(page, files.length, base, log);
}

async function readComposerState(page, snippet) {
  return page
    .evaluate((needle) => {
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          rect.width > 16 &&
          rect.height > 12 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || "1") > 0.1
        );
      };
      const box = [...document.querySelectorAll('[contenteditable="true"], textarea')].find(visible);
      const inBox = String(box?.innerText || box?.value || "").replace(/\s+/g, " ").trim();
      const bubbles = [...document.querySelectorAll('[data-message-author], [data-role="user"], article, [class*="message"]')]
        .map((el) => String(el.innerText || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const body = String(document.body?.innerText || "").replace(/\s+/g, " ");
      const exact = needle.length <= 4;
      const match = (text) => (exact ? new RegExp(`^${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i").test(text) : text.includes(needle));
      const hits = bubbles.filter(match).length;
      return {
        inBox: Boolean(needle) && inBox.includes(needle),
        inThread: Boolean(needle) && bubbles.some(match),
        onPage: Boolean(needle) && (exact ? new RegExp(`(?:^|\\s)${needle}(?:\\s|$)`, "i").test(body) : body.includes(needle)),
        boxLen: inBox.length,
        hits,
      };
    }, snippet)
    .catch(() => ({ inBox: false, inThread: false, onPage: false, boxLen: 0, hits: 0 }));
}

async function requireComposerReady(page, settings, log) {
  const choice = modelChoice(settings);
  if (!(await isCreateVideoMode(page))) {
    log("warn", "Mất Create Videos trước khi nhập — làm lại từ bước 1.");
    await prepareComposer(page, settings, log);
    return;
  }
  const label = await readVideoModelLabel(page);
  if (!toolbarHasModel(label, choice.key)) {
    log("warn", `Nút Model chưa phải ${choice.label} — chọn lại rồi mới nhập.`);
    await selectConfiguredModel(page, settings, log);
  }
  if (!(await isCreateVideoMode(page))) {
    throw new Error("Mất Create Videos sau khi chọn model. Không nhập prompt.");
  }
}

async function fillPrompt(page, prompt, log) {
  await maybeSolveCaptcha(page, log);
  const snippet = String(prompt || "").replace(/\s+/g, " ").trim().slice(0, 24);
  const wrote = await page.evaluate((text) => {
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return (
        rect.width > 24 &&
        rect.height > 16 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        Number(style.opacity || "1") > 0.1 &&
        rect.bottom > 0 &&
        rect.top < innerHeight
      );
    };
    const el = [...document.querySelectorAll('[contenteditable="true"], textarea')].find(visible);
    if (!el) return { ok: false, value: "" };
    el.focus();
    if (el.isContentEditable) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("insertText", false, text);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    } else {
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return { ok: true, value: String(el.innerText || el.value || "").replace(/\s+/g, " ").trim() };
  }, prompt);
  if (!wrote?.ok) throw new Error("Không thấy ô chat đang hiện trên Dola — chưa dán được prompt.");
  if (!wrote.value.includes(snippet)) {
    throw new Error("Ô chat vẫn trống / không nhận prompt. Đang ở trang chủ thì không gửi.");
  }
  const check = await readComposerState(page, snippet);
  if (!check.inBox) {
    throw new Error("Dán xong nhưng ô chat không còn prompt. Không bấm gửi.");
  }
  log("info", `Đã dán prompt vào ô chat đang hiện (${wrote.value.slice(0, 40)}…). Mới gửi.`);
}

async function sendMessage(page, prompt, log) {
  await maybeSolveCaptcha(page, log);
  const snippet = String(prompt || "").replace(/\s+/g, " ").trim().slice(0, 24);
  const before = await readComposerState(page, snippet);
  const beforeHits = Number(before.hits || 0);
  await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return (
        rect.width > 24 &&
        rect.height > 16 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        Number(style.opacity || "1") > 0.1 &&
        rect.bottom > 0 &&
        rect.top < innerHeight
      );
    };
    const el = [...document.querySelectorAll('[contenteditable="true"], textarea')].find(visible);
    el?.focus();
  });
  await page.keyboard.press("Enter");
  let pressed = 1;
  const started = Date.now();
  const deadline = started + 8000;
  while (Date.now() < deadline) {
    const state = await readComposerState(page, snippet);
    const grew = Number(state.hits || 0) > beforeHits;
    const firstClear = beforeHits === 0 && !state.inBox && (state.inThread || state.onPage);
    if (grew || firstClear) {
      log("info", "Đã gửi bằng Enter — thấy tin mới trên khung chat. Mới qua bước tiếp.");
      return;
    }
    if (state.inBox && Number(state.hits || 0) <= beforeHits && Date.now() - started > 4000 && pressed < 2) {
      await page.keyboard.press("Enter");
      pressed += 1;
    }
    await sleepMs(200);
  }
  throw new Error("Bấm Enter rồi nhưng Dola không nhận tin. Trang vẫn như cũ, không tính là đã gửi.");
}

export async function waitForStudioRelay(page, log, timeout = 12000) {
  const ready = await page
    .waitForFunction(
      () =>
        Boolean(
          window.__studioRelaySessionShieldActive ||
            window.__isStudioRelayBypassRequest ||
            window.__isStudioRelayProModeActive,
        ),
      null,
      { timeout },
    )
    .catch(() => null);
  if (!ready) return false;
  log?.("info", "DragonBMT đang chạy cùng tab Dola.");
  return true;
}

async function reloadDolaForExtension(page, log) {
  if (page._dolaExtReloaded) {
    return waitForStudioRelay(page, log, 4000);
  }
  log?.("info", "Tải lại Dola một lần để tab nhận DragonBMT.");
  await page.reload({ waitUntil: "load", timeout: 25000 });
  page._dolaExtReloaded = true;
  const ready = await waitForComposer(page, log, 12000);
  if (!ready) {
    log?.("warn", "Reload Dola xong chưa thấy ô chat.");
  }
  await maybeSolveCaptcha(page, log);
  const ok = await waitForStudioRelay(page, log, 8000);
  if (!ok) log?.("warn", "Reload xong vẫn chưa thấy DragonBMT trên tab.");
  return ok;
}

async function pickActionBarOption(page, keyHint, match) {
  const opened = await page.evaluate((hint) => {
    const re = new RegExp(hint, "i");
    const btn = [...document.querySelectorAll("[data-input-engine-actionbar-control-key]")].find((el) =>
      re.test(el.getAttribute("data-input-engine-actionbar-control-key") || ""),
    );
    if (!btn) return "";
    const key = btn.getAttribute("data-input-engine-actionbar-control-key") || "";
    const label = (btn.innerText || "").replace(/\s+/g, " ");
    return JSON.stringify({ key, label });
  }, keyHint);
  if (!opened) return false;
  const { key, label } = JSON.parse(opened);
  if (match.test(label)) return true;
  await page.evaluate((k) => {
    const btn = document.querySelector(`[data-input-engine-actionbar-control-key="${k}"]`);
    if (!btn) return;
    (btn.querySelector("div.absolute.opacity-0") || btn).click();
    if (typeof btn.click === "function") btn.click();
  }, key);
  await sleepMs(120);
  return page.evaluate((source) => {
    const re = new RegExp(source);
    const items = [...document.querySelectorAll('[role="menuitem"], [role="option"], [data-slot="dropdown-menu-item"]')];
    const hit = items.find((el) => re.test((el.innerText || "").replace(/\s+/g, " ")));
    if (!hit) return false;
    (hit.querySelector("div.absolute.opacity-0") || hit).click();
    if (typeof hit.click === "function") hit.click();
    return true;
  }, match.source);
}

async function requireStudioRelay(page, settings, log) {
  if (!/dola\.com/i.test(page.url())) {
    await gotoDola(page, log, { reload: false });
  }
  let attached = await waitForStudioRelay(page, log, 2500);
  if (!attached) {
    page._dolaExtReloaded = false;
    attached = await reloadDolaForExtension(page, log);
  }
  await armFetchGate(page);
  if (!attached) log("warn", "Chưa thấy DragonBMT trên tab — vẫn gửi prompt, ép 30/60 sau khi Dola hỏi 15s.");
}

export async function applyStudioRelaySettings(page, settings, log) {
  const duration = Number(durationSeconds(forcedDurationLabel(settings.duration))) || 30;
  const ratio = normalizeRatio(settings.ratio);
  await page.evaluate(
    ({ duration: nextDuration, ratio: nextRatio }) => {
      window.__DOLA_FORCE_DURATION = nextDuration;
      window.__DOLA_HOLD_SESSION = true;
      window.__DOLA_REWRITE_READY = true;
      window.__dolaActiveModel = "fast";
      window.__FORCE_RATIO_OVERRIDE = nextRatio;
      window.CHANNA_TARGET_RATIO = nextRatio;
      const payload = { ratio: nextRatio, duration: nextDuration };
      for (const type of ["SET_RATIO_OVERRIDE", "PURZA_UPDATE_SETTINGS", "ZDOLA_APPLY_SETTINGS"]) {
        window.postMessage({ type, ...payload }, "*");
      }
    },
    { duration, ratio },
  );
  log("info", `DragonBMT bắt đầu đổi request: 15s → ${duration}s.`);
}

async function logDurationRewrites(page, log, want) {
  const hits = await page.evaluate(() => Number(window.__DOLA_DURATION_HITS || 0)).catch(() => 0);
  if (hits) log("info", `Đã đổi ${hits} request 15s → ${want}.`);
  else log("info", `Chưa thấy request 15s — hook vẫn sẵn, request tới sẽ đổi thành ${want}.`);
}

async function readDolaReplyState(page, { promptSnippet = "" } = {}) {
  return page
    .evaluate((needle) => {
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          rect.width > 16 &&
          rect.height > 12 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || "1") > 0.1
        );
      };
      const nodes = [...document.querySelectorAll('[data-message-author], [data-role], article, [class*="message"], [class*="Message"]')];
      const hint = String(needle || "").replace(/\s+/g, " ").trim().slice(0, 24);
      const texts = [];
      for (const el of nodes) {
        if (!visible(el) && el !== document.body) continue;
        const t = String(el.innerText || "").replace(/\s+/g, " ").trim();
        if (t) texts.push(t);
      }
      let lastUser = -1;
      const exact = hint.length <= 4;
      if (hint) {
        for (let i = 0; i < texts.length; i += 1) {
          if (exact ? texts[i].toLowerCase() === hint.toLowerCase() : texts[i].includes(hint)) lastUser = i;
        }
      }
      let after = lastUser >= 0 ? texts.slice(lastUser + 1).join("\n") : "";
      let afterUser = lastUser >= 0;
      if (!exact && (!afterUser || !after.trim())) {
        const body = String(document.body?.innerText || "");
        const idx = hint ? body.toLowerCase().lastIndexOf(hint.toLowerCase()) : -1;
        if (idx >= 0) {
          after = body.slice(idx + hint.length);
          afterUser = true;
        }
      }
      const source = after.toLowerCase();
      if (!afterUser || !source.trim()) {
        return { refused: false, generating: false, busy: false, systemError: false, networkError: false, scoped: false };
      }
      const refused =
        /would you like me to proceed with 15|nearest supported duration of 15|supports durations from 4 to 15|proceed with 15 seconds|tôi có thể tạo.*15|chỉ tối đa 15/.test(source) ||
        (/15\s*-?\s*second|15\s*s\b|15\s*giây|tối đa\s*15|up to 15|maximum (?:of |duration (?:is |of )?)?15|limit(?:ed)? to 15/.test(source) &&
          /proceed|nearest|unsupport|không hỗ trợ|không thể|chỉ (?:có thể|hỗ trợ|tạo)|tối đa|not support|can't|cannot|can only|unable|only support|maximum|limit|up to|would you like|do you want|shall i/.test(source)) ||
        (/\b(?:30|60)\s*(?:s\b|-?\s*second|giây)/.test(source) &&
          /not (?:currently )?support|unsupport|không hỗ trợ|không thể tạo|can't (?:generate|create|make)|cannot (?:generate|create|make)|unable to (?:generate|create|make)|exceeds?|too long|quá dài/.test(source));
      const generating =
        /đang tạo video|đang xử lý video|generating video now|creating video now|video is (queued|rendering)|rendering video/.test(source);
      const busy =
        /experiencing high demand|high demand right now|please try again later|too many requests|rate limit|server (is )?busy|quá tải|thử lại sau/.test(
          source,
        );
      const systemError =
        /system error|lỗi hệ thống|internal (server )?error|something went wrong|an error occurred|unexpected error/.test(source);
      const networkError =
        /network error|network connection|lỗi mạng|mất kết nối|connection (error|lost|failed)|failed to fetch|check your (network|connection)|offline/.test(
          source,
        );
      return { refused, generating, busy, systemError, networkError, scoped: true };
    }, promptSnippet)
    .catch(() => ({ refused: false, generating: false, busy: false, systemError: false, networkError: false, scoped: false }));
}

async function waitFor15sLimit(page, log, { promptSnippet = "", ms = 45000 } = {}) {
  log("info", "Đang đợi Dola báo chỉ hỗ trợ 15s. Chưa thấy câu đó thì không gửi OK.");
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await maybeSolveCaptcha(page, log);
    if (await sessionKickedOut(page)) {
      throw new Error("Dola đá phiên lúc gửi. Không gửi thêm — login lại trên cửa sổ Chromium của tool.");
    }
    const state = await readDolaReplyState(page, { promptSnippet });
    if (state.networkError) {
      log("warn", "Dola báo Network error sau tin vừa gửi.");
      return "network";
    }
    if (state.systemError) {
      log("warn", "Dola báo System error sau đúng tin vừa gửi.");
      return "error";
    }
    if (state.busy) {
      log("warn", "Dola báo quá tải (high demand) — chưa phải logout.");
      return "busy";
    }
    if (state.refused) {
      log("info", "Dola đã hỏi: chỉ 15s, proceed with 15 seconds? — bước tiếp gửi OK, DragonBMT đổi request thành 30/60.");
      return "refused";
    }
    if (state.generating) {
      log("info", "Dola đã bắt đầu tạo video sau đúng prompt này — không gửi OK.");
      return "generating";
    }
    await sleepMs(400);
  }
  log("warn", "Hết thời gian chưa thấy câu 15s và Dola chưa tạo video. Không gửi OK, không đánh hoàn thành.");
  return "timeout";
}

async function clickOkOn15sMessage(page) {
  return page.evaluate(() => {
    const offer =
      /proceed with 15|nearest supported duration of 15|supports durations from 4 to 15|proceed with 15 seconds|chỉ tối đa 15|tôi có thể tạo.*15/i;
    const blocks = [...document.querySelectorAll('[data-message-author], [data-role], article, [class*="message"], [class*="Message"]')];
    const hit = [...blocks].reverse().find((el) => offer.test(el.innerText || ""));
    if (!hit) return "";
    const btn = [...hit.querySelectorAll("button, [role='button'], a")].find((el) =>
      /^(yes|ok|okay|proceed|đồng ý)$/i.test((el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim()),
    );
    if (!btn) return "";
    btn.click();
    return (btn.innerText || "OK").replace(/\s+/g, " ").trim();
  }).catch(() => "");
}

async function sendOkAfterCreateVideos(page, settings, log, { label = "OK" } = {}) {
  const duration = forcedDuration(settings);
  const followUp = continueAfterDurationRefusal(settings);
  await maybeSolveCaptcha(page, log);
  await selectCreateVideo(page, log);
  if (!(await isCreateVideoMode(page))) {
    throw new Error("Chưa vào lại Create Videos — không nhập OK.");
  }
  const choice = modelChoice(settings);
  const labelNow = await readVideoModelLabel(page);
  if (!toolbarHasModel(labelNow, choice.key)) {
    log("info", `Sau Create Videos, model chưa phải ${choice.label} — chọn lại rồi mới nhập ${label}.`);
    await selectConfiguredModel(page, settings, log);
  }
  if (!(await isCreateVideoMode(page))) {
    throw new Error("Mất Create Videos sau khi chọn model. Không nhập OK.");
  }
  await applyStudioRelaySettings(page, settings, log);
  await fillPrompt(page, followUp, log);
  const snap = await snapshotSession(page, page.context());
  await sendMessage(page, followUp, log);
  await sleepMs(400);
  if (!(await holdSession(page, snap, log))) {
    throw new Error("Mất phiên lúc gửi OK. Không đánh hoàn thành — login lại rồi chạy lại task.");
  }
  log("info", `Đã gửi ${label} sau Create Videos. DragonBMT đổi 15 → ${duration} trên request.`);
  return true;
}

async function continueSameTaskAfterRefusal(page, settings, log) {
  if (await sessionKickedOut(page)) {
    log("warn", "Mất phiên thật (trang Google login) — không gửi thêm.");
    return false;
  }
  const duration = forcedDuration(settings);
  log("info", `Bước 5/5: chọn lại Create Videos (xong mới nhập OK). DragonBMT đổi request thành ${duration}.`);
  return sendOkAfterCreateVideos(page, settings, log, { label: "OK" });
}

export async function resendOkAfterFail(page, settings, log) {
  log("info", "Dola lỗi tạo video — bấm Create Videos, đợi xong rồi nhập lại OK. Không đánh lỗi.");
  return sendOkAfterCreateVideos(page, settings, log, { label: "OK" });
}

async function prepareComposer(page, settings, log) {
  const choice = modelChoice(settings);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    log("info", "Bước 1/5: Create Videos — chỉ bỏ qua khi đã thấy nút Model.");
    await selectCreateVideo(page, log);
    if (!(await isCreateVideoMode(page))) {
      log("warn", `Lần ${attempt}: chưa vào Create Videos — làm lại.`);
      continue;
    }
    log("info", "Bước 2/5: mở nút Model rồi chọn mode theo cài đặt — đợi nút đổi chữ.");
    await selectConfiguredModel(page, settings, log);
    const modeOk = await isCreateVideoMode(page);
    const modelOk = toolbarHasModel(await readVideoModelLabel(page), choice.key);
    if (modeOk && modelOk) {
      log("info", `Đã xong Create Videos + ${choice.label} — mới qua bước nhập prompt.`);
      return;
    }
    log("warn", `Lần ${attempt}: Create Videos / model chưa đứng yên — làm lại từ bước 1.`);
  }
  throw new Error("Chưa vào được Create Videos + model. Không gửi.");
}

async function openFreshChat(page, settings, log, reason) {
  log("warn", `${reason} — mở chat Dola mới (không gửi chồng vào hội thoại lỗi), tắt đổi request.`);
  await gotoDola(page, log, { reload: true });
  if (await sessionKickedOut(page)) {
    throw new Error("Phiên hết đăng nhập khi mở chat mới. Login lại rồi chạy.");
  }
  await requireStudioRelay(page, settings, log);
  await lockRewriteOff(page);
  await prepareComposer(page, settings, log);
}

const RETRY_WAIT_SEC = { busy: [0, 25, 45, 70], error: [0, 8, 15, 25], network: [0, 6, 12, 20] };
const RETRY_LABEL = { busy: "Dola quá tải", error: "System error", network: "Network error" };

async function ensureDolaReady(page, settings, log) {
  await gotoDola(page, log, { reload: false });
  if (await sessionKickedOut(page)) {
    throw new Error("Phiên hết đăng nhập (trang Google / nút Sign in with Google). Mở trình duyệt và login lại.");
  }
  await requireStudioRelay(page, settings, log);
  await prepareComposer(page, settings, log);
}

async function runOneTask(page, task, settings, log, { setupPage = true } = {}) {
  if (!task.prompt?.trim()) throw new Error(`${task.title}: prompt trống.`);
  const forced = forcedDuration(settings);
  const ratio = normalizeRatio(settings.ratio);
  const packedSettings = { ...settings, duration: forced, ratio };
  const prompt = buildPromptWithSpecs(task.prompt, packedSettings);
  if (!prompt.includes(ratio)) {
    throw new Error(`${task.title}: prompt thiếu tỷ lệ khung ${ratio}.`);
  }
  if (setupPage) await ensureDolaReady(page, packedSettings, log);
  else {
    await requireStudioRelay(page, packedSettings, log);
    await prepareComposer(page, packedSettings, log);
  }

  const packed = await writeImages(task.images);
  try {
    let reply = null;
    let proxyHits = 0;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      if (attempt > 1) {
        const waitSec = RETRY_WAIT_SEC[reply]?.[attempt - 1] ?? 15;
        log("warn", `Chờ ${waitSec}s rồi gửi lại prompt gốc (${attempt}/4). Không đổi request.`);
        await sleepMs(waitSec * 1000);
        await openFreshChat(page, packedSettings, log, RETRY_LABEL[reply] || "Dola lỗi");
      } else {
        await lockRewriteOff(page);
        await requireComposerReady(page, packedSettings, log);
      }
      await uploadImages(page, packed.files, log);
      log("info", `Bước 3/5: dán prompt, thêm ${ratio} vào cuối, rồi gửi. Request gốc, chưa đổi.`);
      page._dolaNet = [];
      await fillPrompt(page, prompt, log);
      await sendMessage(page, prompt, log);
      log("info", `Đã gửi prompt gốc, cuối prompt có ${ratio}. Chưa đổi request.`);
      await sleepMs(800);
      if (await sessionKickedOut(page)) {
        throw new Error("Dola logout lúc gửi prompt đầu. Không gửi thêm — login lại trên cửa sổ Chromium của tool.");
      }
      log("info", "Bước 4/5: đợi Dola báo chỉ hỗ trợ 15s.");
      reply = await waitFor15sLimit(page, log, { promptSnippet: stripSpecBlock(task.prompt), ms: 45000 });
      if (reply !== "busy" && reply !== "error" && reply !== "network") break;
      const why = explainNet(page, log);
      if (reply === "network" || why.proxy) proxyHits += 1;
      if (proxyHits >= 2) {
        throw new Error("Network error lặp lại — proxy của tài khoản này không ổn với Dola. Vào tab Proxy bấm Check rồi đổi proxy.");
      }
    }
    if (reply === "busy") {
      throw new Error(
        "Dola vẫn báo quá tải sau 4 lần (request gốc, chưa đổi). Dola đang giới hạn tài khoản/IP này — đổi proxy hoặc tài khoản, chạy lại sau.",
      );
    }
    if (reply === "error") {
      throw new Error("Dola báo System error sau 4 lần gửi prompt gốc. Không đổi request, không đánh hoàn thành.");
    }
    if (reply === "network") {
      throw new Error("Dola báo Network error sau 4 lần. Kiểm tra proxy ở tab Proxy rồi đổi.");
    }
    if (reply === "timeout") {
      throw new Error("Dola chưa hỏi 15s và chưa tạo video. Không gửi OK, không đánh hoàn thành.");
    }
    if (reply === "generating") {
      log("info", "Dola đang tạo — DragonBMT đổi 15 thành " + forced + " trên request.");
      return;
    }
    page._dolaNet = [];
    const confirmed = await continueSameTaskAfterRefusal(page, packedSettings, log);
    if (!confirmed) {
      throw new Error("Mất phiên lúc gửi OK. Không đánh hoàn thành — login lại rồi chạy lại task.");
    }
    const afterOk = await waitFor15sLimit(page, log, { promptSnippet: "OK", ms: 12000 });
    if (afterOk === "error" || afterOk === "busy" || afterOk === "network") {
      const why = explainNet(page, log);
      if (why.rewrite) {
        log("warn", "Lỗi xảy ra đúng lúc DragonBMT đổi request 15 → " + forced + ".");
      }
      log("warn", "Sau OK Dola báo lỗi — chờ 8s, Create Videos rồi gửi lại OK. Không đánh lỗi.");
      await sleepMs(8000);
      page._dolaNet = [];
      await resendOkAfterFail(page, packedSettings, log);
      const again = await waitFor15sLimit(page, log, { promptSnippet: "OK", ms: 12000 });
      if (again === "error" || again === "busy" || again === "network") explainNet(page, log);
    }
    await logDurationRewrites(page, log, forced);
    await sleepMs(600);
    if (await sessionKickedOut(page)) {
      throw new Error("Mất phiên sau OK. Không đánh hoàn thành — login lại rồi chạy lại task.");
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
    const extension = (await resolveStudioRelayPath()) || getCachedStudioRelay();
    if (!extension?.path) {
      throw new Error("Không chạy task: thiếu DragonBMT. Giữ thư mục studiorelay/ rồi mở lại app.");
    }
    log("info", "Chạy task cùng DragonBMT. Extension phải nạp xong mới gửi.");

    const forced = forcedDuration(settings);
    const runSettings = { ...settings, duration: forced, extension: true };
    setRunContext({
      duration: forced,
      ratio: normalizeRatio(settings.ratio),
      resolution: settings.resolution || "2160p",
      lanczos: settings.resolution !== "off",
    });
    await startVideoWatch(log);
    log("info", `Ép ${forced} · ${normalizeRatio(settings.ratio)}. Chỉ gửi OK khi Dola hỏi 15s.`);

    const defaultLimit = clampDailyLimit(settings.dailyLimit, 3);
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
      setRunContext({
        accountEmail: account.email,
        accountId: account.id,
        duration: forced,
        ratio: normalizeRatio(settings.ratio),
      });
      const firstOnAccount = !setupOnce.has(account.id);
      log(
        "info",
        `${task.title} → ${account.email} · 1 phiên riêng · còn ${account.remaining}/${account.dailyLimit} hôm nay · ${forced}`,
      );
      let job = null;
      try {
        const { page } = await getAccountSession(account.id, log, { purpose: "run" });
        await page.bringToFront().catch(() => {});
        await runOneTask(page, task, runSettings, log, { setupPage: firstOnAccount });
        setupOnce.add(account.id);
        sent += 1;
        await consumeDailyQuota(account.id, defaultLimit, log);
        job = createLiveJob({
          accountEmail: account.email,
          accountId: account.id,
          duration: forced,
          ratio: normalizeRatio(settings.ratio),
          prompt: stripSpecBlock(task.prompt || ""),
          resolution: settings.resolution || "2160p",
          lanczos: settings.resolution !== "off",
          title: account.email,
          status: "sending",
        });
        const snapshot = await readDolaTaskState(page, { promptHint: stripSpecBlock(task.prompt || "") });
        if (snapshot.failed) {
          await resendOkAfterFail(page, runSettings, log);
        }
        updateJob(job.id, {
          status: "generating",
          progress: mapDolaPercent(snapshot, 8),
          progressSource: snapshot.percent != null || snapshot.downloadReady ? "dola" : "tool",
          dolaStage: snapshot.failed ? "queued" : snapshot.stage,
          error: "",
          okRetries: snapshot.failed ? 1 : 0,
          lastOkRetryAt: snapshot.failed ? Date.now() : 0,
        });
        if (hideChrome) {
          await parkAccountSession(account.id);
          log("info", `${account.email}: đã gửi. Ẩn Chrome, giữ phiên nền để đọc % và tải file.`);
        } else {
          log("info", `${account.email}: đã gửi. Giữ Chrome theo cài đặt.`);
        }
        scheduleCollect({ accountId: account.id, jobId: job.id, log });
      } catch (err) {
        if (job) updateJob(job.id, { status: "failed", error: err.message });
        log("error", `${task.title} / ${account.email}: ${err.message}`);
        if (/đăng nhập|sign in|hết phiên|google login/i.test(err.message)) {
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
            log("warn", `Bỏ ${skipped.title}: hết hạn hôm nay (tối đa 3 video / tài khoản).`);
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
  await gotoDola(page, log).catch(() => {});
  const state = await inspectSession(page, log, context);
  await markAccount(accountId, {
    status: state.needLogin ? "need_login" : "active",
    sessionOk: !state.needLogin,
    lastCheck: new Date().toISOString(),
  });
  if (!state.needLogin) {
    await closeAccountSession(accountId);
    log("info", `${account.email}: đã nạp ${normalized.length} cookie — ${state.reason} Tắt Chrome.`);
  } else {
    log("warn", `${account.email}: đã nạp ${normalized.length} cookie nhưng ${state.reason} Giữ Chrome.`);
  }
  return { count: normalized.length, needLogin: state.needLogin };
}

export async function replaceAccounts(next) {
  return saveAccounts(next);
}
