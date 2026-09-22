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

async function gotoDola(page, log, { viaProxy = Boolean(page?._viaProxy), reload = false, timeout = 25000 } = {}) {
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
      await sleepMs(600);
      return;
    }
  }
  log?.("info", viaProxy ? "Đang mở Dola qua proxy..." : "Đang mở Dola...");
  try {
    await page.goto(DOLA_URL, { waitUntil: "load", timeout });
    const ready = await waitForComposer(page, log, 12000);
    if (!ready) throw new Error("Dola mở xong nhưng chưa hiện ô chat. Không gửi khi còn trang trắng / trang chủ chưa load.");
    await maybeSolveCaptcha(page, log);
    await sleepMs(800);
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
  await waitForStudioRelay(page, log, 800);
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

async function selectCreateVideo(page, log) {
  await maybeSolveCaptcha(page, log);
  if (await isCreateVideoMode(page)) {
    log("info", "Đã ở Create Videos — nút Model đang hiện trên thanh chat.");
    return;
  }
  log("info", "Đang ở trang chủ — bấm chip Create Videos.");
  const clicked = await clickCreateVideoChip(page).catch(() => "");
  if (!clicked) throw new Error("Không thấy chip Create Videos trên trang chủ Dola.");
  log("info", `Đã bấm ${clicked} — đợi nút Model hiện ra.`);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await isCreateVideoMode(page)) {
      log("info", "Đã vào Create Videos — nút Model đang hiện.");
      return;
    }
    await maybeSolveCaptcha(page, log);
    await sleepMs(200);
  }
  throw new Error("Bấm Create Videos rồi nhưng trang vẫn trang chủ — không thấy nút Model. Không gửi.");
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

async function selectConfiguredModel(page, settings, log) {
  await maybeSolveCaptcha(page, log);
  const choice = modelChoice(settings);
  let label = await readVideoModelLabel(page);
  if (toolbarHasModel(label, choice.key)) {
    log("info", `Nút Model đang ${choice.label} — bỏ qua.`);
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
      log("info", `Nút Model đang ${choice.label} — bỏ qua.`);
      return;
    }
  }

  log("info", `Bấm nút Model rồi chọn ${choice.label}...`);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const opened = await menuIsOpen(page);
    if (!opened) {
      const clicked = await clickVideoModelButton(page);
      if (!clicked) throw new Error("Không bấm được nút Model trên thanh chat.");
      const waitUntil = Date.now() + 700;
      while (Date.now() < waitUntil && !(await menuIsOpen(page))) await sleepMs(50);
    }
    if (!(await menuIsOpen(page))) {
      log("info", `Lần ${attempt}: menu chưa mở, bấm lại.`);
      continue;
    }
    const hit = await clickModeInMenu(page, choice.key);
    await sleepMs(120);
    const next = await readVideoModelLabel(page);
    if (hit || toolbarHasModel(next, choice.key)) {
      log("info", `Đã chọn ${choice.label}.`);
      return;
    }
  }
  throw new Error(`Không chọn được ${choice.label} trong menu Model.`);
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
  await page.waitForTimeout(200);
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
  log("info", `Đã dán prompt vào ô chat đang hiện (${wrote.value.slice(0, 40)}…).`);
}

async function sendMessage(page, prompt, log) {
  await maybeSolveCaptcha(page, log);
  const snippet = String(prompt || "").replace(/\s+/g, " ").trim().slice(0, 24);
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
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const state = await page
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
        const inThread = bubbles.some((text) => text.includes(needle));
        return { inBox: inBox.includes(needle), inThread, boxLen: inBox.length };
      }, snippet)
      .catch(() => ({ inBox: true, inThread: false }));
    if (state.inThread || !state.inBox) {
      log("info", "Đã gửi bằng Enter — thấy tin trên khung chat.");
      return;
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
  log("info", "DragonBMT đang chạy cùng tab Dola.");
  return true;
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
  const attached = await waitForStudioRelay(page, log, 5000);
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
      let afterUser = !hint;
      let after = "";
      for (const el of nodes) {
        if (!visible(el) && el !== document.body) continue;
        const t = String(el.innerText || "").replace(/\s+/g, " ").trim();
        if (!t) continue;
        if (!afterUser && hint && t.includes(hint)) {
          afterUser = true;
          continue;
        }
        if (afterUser) after += `\n${t}`;
      }
      if (!afterUser || !after.trim()) {
        const body = String(document.body?.innerText || "");
        const idx = hint ? body.toLowerCase().indexOf(hint.toLowerCase()) : -1;
        if (idx >= 0) {
          after = body.slice(idx + hint.length);
          afterUser = true;
        }
      }
      const source = after.toLowerCase();
      if (!afterUser || !source.trim()) {
        return { refused: false, generating: false, scoped: false };
      }
      const refused =
        /would you like me to proceed with 15|nearest supported duration of 15|supports durations from 4 to 15|proceed with 15 seconds|tôi có thể tạo.*15|chỉ tối đa 15/.test(source) ||
        (/15\s*second|15\s*s|tối đa\s*15/.test(source) &&
          /proceed|nearest|unsupport|không hỗ trợ|không thể|not support|can't|cannot|unable|only support/.test(source));
      const generating =
        /đang tạo video|đang xử lý video|generating video now|creating video now|video is (queued|rendering)|rendering video/.test(source);
      const busy =
        /experiencing high demand|high demand right now|please try again later|too many requests|rate limit|server (is )?busy|quá tải|thử lại sau/.test(
          source,
        );
      return { refused, generating, busy, scoped: true };
    }, promptSnippet)
    .catch(() => ({ refused: false, generating: false, scoped: false }));
}

async function waitFor15sLimit(page, log, { promptSnippet = "", ms = 45000 } = {}) {
  log("info", "Đang đợi Dola báo chỉ hỗ trợ 15s. Chưa thấy câu đó thì không gửi OK.");
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await maybeSolveCaptcha(page, log);
    if (await isHighDemand(page)) {
      log("warn", "Dola báo quá tải (high demand) — chưa phải logout.");
      return "busy";
    }
    if (await sessionKickedOut(page)) {
      throw new Error("Dola đá phiên lúc gửi. Không gửi thêm — login lại trên cửa sổ Chromium của tool.");
    }
    const state = await readDolaReplyState(page, { promptSnippet });
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

async function continueSameTaskAfterRefusal(page, settings, log) {
  const duration = forcedDuration(settings);
  if (await sessionKickedOut(page)) {
    log("warn", "Mất phiên thật (trang Google login) — không gửi thêm.");
    return false;
  }
  log("info", `Bước 5/5: chọn lại Create Videos rồi mới nhập OK. DragonBMT đổi request thành ${duration}.`);
  await maybeSolveCaptcha(page, log);
  await selectCreateVideo(page, log);
  await applyStudioRelaySettings(page, settings, log);
  const followUp = continueAfterDurationRefusal(settings);
  const snap = await snapshotSession(page, page.context());
  await fillPrompt(page, followUp, log);
  await sendMessage(page, followUp, log);
  await sleepMs(400);
  if (!(await holdSession(page, snap, log))) {
    throw new Error("Mất phiên lúc gửi OK. Không đánh hoàn thành — login lại rồi chạy lại task.");
  }
  log("info", `Đã gửi OK sau Create Videos. DragonBMT đổi 15 → ${duration} trên request.`);
  return true;
}

export async function resendOkAfterFail(page, settings, log) {
  log("info", "Dola lỗi tạo video — bấm Create Videos rồi nhập lại OK. Không đánh lỗi.");
  await selectCreateVideo(page, log);
  await applyStudioRelaySettings(page, settings, log);
  const followUp = continueAfterDurationRefusal(settings);
  await fillPrompt(page, followUp, log);
  await sendMessage(page, followUp, log);
  return true;
}

async function prepareComposer(page, settings, log) {
  log("info", "Bước 1/5: Create Videos — chỉ bỏ qua khi đã thấy nút Model.");
  await selectCreateVideo(page, log);
  log("info", "Bước 2/5: mở nút Model rồi chọn mode theo cài đặt.");
  await selectConfiguredModel(page, settings, log);
}

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
    if (setupPage) await uploadImages(page, packed.files, log);
    let reply = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      if (attempt > 1) {
        const waitSec = 8 * attempt;
        log("warn", `Dola quá tải — chờ ${waitSec}s rồi gửi lại prompt (${attempt}/4). Không đổi request.`);
        await sleepMs(waitSec * 1000);
        await dismissHighDemand(page);
        await sleepMs(400);
      }
      log("info", `Bước 3/5: dán prompt, thêm ${ratio} vào cuối, rồi gửi. Chưa ép request.`);
      await fillPrompt(page, prompt, log);
      await sendMessage(page, prompt, log);
      log("info", `Đã gửi prompt gốc, cuối prompt có ${ratio}. Chưa đổi request.`);
      await sleepMs(800);
      if (await isHighDemand(page)) {
        reply = "busy";
        continue;
      }
      if (await sessionKickedOut(page)) {
        throw new Error("Dola logout lúc gửi prompt đầu. Không gửi thêm — login lại trên cửa sổ Chromium của tool.");
      }
      log("info", "Bước 4/5: đợi Dola báo chỉ hỗ trợ 15s.");
      reply = await waitFor15sLimit(page, log, { promptSnippet: stripSpecBlock(task.prompt), ms: 45000 });
      if (reply !== "busy") break;
    }
    if (reply === "busy") {
      throw new Error("Dola đang quá tải (high demand). Đã thử lại 4 lần — chạy lại task sau.");
    }
    if (reply === "timeout") {
      throw new Error("Dola chưa hỏi 15s và chưa tạo video. Không gửi OK, không đánh hoàn thành.");
    }
    if (reply === "generating") {
      log("info", "Dola đang tạo — DragonBMT đổi 15 thành " + forced + " trên request.");
      return;
    }
    const confirmed = await continueSameTaskAfterRefusal(page, packedSettings, log);
    if (!confirmed) {
      throw new Error("Mất phiên lúc gửi OK. Không đánh hoàn thành — login lại rồi chạy lại task.");
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
