import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { loadAccounts, loadProxies, saveAccounts } from "./store.js";
import { normalizeAccountQuota } from "../shared/quota.js";
import { PROFILE_ROOT, VIDEO_RAW } from "./paths.js";
import { resolveStudioRelayPath, studioRelayLaunchArgs } from "./extension.js";
import { attachSessionDownloads, writeChromeDownloadPrefs } from "./videos.js";
const openSessions = new Map();
let rotateCursor = 0;

export function sessionPurpose(accountId) {
  return openSessions.get(accountId)?.purpose || null;
}

export function parseProxy(raw) {
  if (!raw) return undefined;
  let value = String(raw).trim();
  if (!value || value === "direct") return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`;
  const url = new URL(value);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return {
    server: `${url.protocol}//${url.hostname}:${port}`,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  };
}

export function profileDir(accountId) {
  return path.join(PROFILE_ROOT, accountId);
}

function pickRotatedProxy(proxies) {
  if (!proxies.length) return null;
  const item = proxies[rotateCursor % proxies.length];
  rotateCursor += 1;
  return item;
}

export async function resolveProxy(account) {
  const proxies = await loadProxies();
  if (account.proxyMode === "rotate") {
    const picked = pickRotatedProxy(proxies);
    return { proxy: parseProxy(picked?.host), label: picked?.host || "không có proxy để xoay" };
  }
  if (account.proxyMode === "fixed") {
    const picked = proxies.find((p) => p.id === account.proxyId);
    return { proxy: parseProxy(picked?.host), label: picked?.host || "chưa chọn proxy" };
  }
  return { proxy: undefined, label: "trực tiếp (không proxy)" };
}

async function closeSession(accountId) {
  const session = openSessions.get(accountId);
  if (!session) return;
  openSessions.delete(accountId);
  await session.context.close().catch(() => {});
}

export async function closeAccountSession(accountId) {
  await closeSession(accountId);
}

async function setWindowState(session, state, bounds = {}) {
  if (!session?.page || session.page.isClosed()) return;
  try {
    const cdp = await session.context.newCDPSession(session.page);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: state, ...bounds },
    });
  } catch {
    // Chrome version may ignore window bounds.
  }
}

export async function parkAccountSession(accountId) {
  const session = openSessions.get(accountId);
  if (!session) return;
  if (session.purpose !== "login") session.purpose = "watch";
  await setWindowState(session, "minimized");
}

export async function showAccountSession(accountId) {
  const session = openSessions.get(accountId);
  if (!session) return;
  await setWindowState(session, "normal", { left: 60, top: 40, width: 1440, height: 920 });
}

async function keepSingleTab(context) {
  const pages = context.pages().filter((page) => !page.isClosed());
  const keep = pages.find((page) => /dola\.com/i.test(page.url())) || pages[0];
  for (const extra of pages) {
    if (extra === keep) continue;
    const url = extra.url();
    if (url.startsWith("chrome-extension://") || url.startsWith("devtools://")) continue;
    await extra.close().catch(() => {});
  }
  return keep || (await context.newPage());
}

export async function getAccountSession(accountId, log, { forceNew = false, offscreen = false, purpose = "run" } = {}) {
  const accounts = await loadAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new Error("Không tìm thấy tài khoản.");

  const { proxy, label } = await resolveProxy(account);

  if (forceNew) await closeSession(accountId);

  const existing = openSessions.get(accountId);
  if (existing?.page && !existing.page.isClosed()) {
    if (existing.accountId && existing.accountId !== accountId) {
      await closeSession(accountId);
    } else if (existing.proxyLabel !== label) {
      log?.("info", `${account.email}: proxy đã đổi (${existing.proxyLabel} → ${label}), mở lại đúng 1 phiên.`);
      await closeSession(accountId);
    } else {
      const page = await keepSingleTab(existing.context);
      existing.page = page;
      if (purpose === "login" || purpose === "run" || !existing.purpose) existing.purpose = purpose;
      if (purpose === "login" || (purpose === "run" && !offscreen)) {
        await showAccountSession(accountId);
      } else if (offscreen || purpose === "watch" || purpose === "collect") {
        await parkAccountSession(accountId);
      }
      return { account, ...existing, page };
    }
  }

  for (const [openId, session] of openSessions) {
    if (openId !== accountId && session.accountId === accountId) {
      await closeSession(openId);
    }
  }
  const dir = profileDir(accountId);
  await fs.mkdir(dir, { recursive: true });
  await writeChromeDownloadPrefs(dir, VIDEO_RAW).catch(() => {});
  const extension = await resolveStudioRelayPath();
  log?.("info", `${account.email}: 1 phiên riêng / 1 tab · proxy ${label} · profile ${dir}`);
  if (extension?.path) {
    log?.("info", `${account.email}: nạp DragonBMT (${extension.source})`);
  } else {
    log?.("warn", `${account.email}: không tìm thấy DragonBMT trong repo hoặc Chrome. Task sẽ chạy thiếu ép duration/download.`);
  }

  const launchOptions = {
    headless: false,
    viewport: { width: 1440, height: 920 },
    acceptDownloads: true,
    downloadsPath: VIDEO_RAW,
    proxy,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      "--disable-blink-features=AutomationControlled",
      ...(offscreen ? ["--window-position=-32000,-32000", "--window-size=1280,800"] : []),
      ...studioRelayLaunchArgs(extension?.path),
    ],
  };
  let context;
  try {
    context = await chromium.launchPersistentContext(dir, { ...launchOptions, channel: "chrome" });
  } catch {
    context = await chromium.launchPersistentContext(dir, launchOptions);
  }
  if (extension?.path) {
    await context.waitForEvent("serviceworker", { timeout: 4000 }).catch(() => {});
  }
  const page = await keepSingleTab(context);
  context.on("close", () => openSessions.delete(accountId));
  const session = { context, page, proxyLabel: label, accountId, purpose };
  openSessions.set(accountId, session);
  await attachSessionDownloads(context, { account, log });
  return { account, ...session };
}

export async function removeAccountProfile(accountId) {
  await closeSession(accountId);
  await fs.rm(profileDir(accountId), { recursive: true, force: true }).catch(() => {});
}

export async function markAccount(accountId, patch) {
  const accounts = await loadAccounts();
  const next = accounts.map((a) => (a.id === accountId ? normalizeAccountQuota({ ...a, ...patch }) : a));
  await saveAccounts(next);
  return next.find((a) => a.id === accountId);
}

export function listOpenSessions() {
  return [...openSessions.keys()];
}

export function getOpenPage(accountId) {
  const session = openSessions.get(accountId);
  if (!session?.page || session.page.isClosed()) return null;
  return session.page;
}
