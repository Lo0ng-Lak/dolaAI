import { chromium } from "playwright";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { loadAccounts, loadProxies, saveAccounts } from "./store.js";
import { normalizeAccountQuota } from "../shared/quota.js";
import { PROFILE_ROOT, VIDEO_RAW } from "./paths.js";
import { installExtensionIntoProfile, resolveStudioRelayPath, studioRelayLaunchArgs } from "./extension.js";
import { attachSessionDownloads, writeChromeDownloadPrefs } from "./videos.js";
import { ensurePlaywrightChromium } from "./browsers.js";
import { attachAuthLock } from "./authLock.js";
const openSessions = new Map();
let rotateCursor = 0;

export function sessionPurpose(accountId) {
  return openSessions.get(accountId)?.purpose || null;
}

function decodePart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function splitUserinfo(userinfo) {
  const idx = userinfo.indexOf(":");
  if (idx === -1) return { username: decodePart(userinfo) };
  return {
    username: decodePart(userinfo.slice(0, idx)),
    password: decodePart(userinfo.slice(idx + 1)),
  };
}

export function maskProxyLabel(raw, parsed) {
  if (parsed?.server) {
    return parsed.username ? `${parsed.server} · ${parsed.username}` : parsed.server;
  }
  const text = String(raw || "").trim();
  if (!text) return "không có proxy";
  const parts = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(":");
  if (parts.length >= 4) return `${parts[0]}:${parts[1]} · ${parts[2]}`;
  return text.replace(/:[^:@]+$/, ":***");
}

export function parseProxy(raw) {
  if (raw == null) return undefined;
  let value = String(raw).trim();
  if (!value || /^direct$/i.test(value)) return undefined;

  let protocol = "http";
  const proto = value.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (proto) {
    protocol = proto[1].toLowerCase();
    value = value.slice(proto[0].length);
  }
  if (protocol === "https") protocol = "https";
  else if (protocol.startsWith("socks5")) protocol = "socks5";
  else if (protocol.startsWith("socks4")) protocol = "socks5";
  else protocol = "http";

  value = value.replace(/^\/+/, "");

  let username;
  let password;
  const at = value.lastIndexOf("@");
  if (at > 0) {
    const auth = splitUserinfo(value.slice(0, at));
    username = auth.username;
    password = auth.password;
    value = value.slice(at + 1);
  }

  const parts = value.split(":");
  let host;
  let port;
  const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
  if (parts.length >= 4 && /^\d+$/.test(parts[1]) && !username) {
    host = parts[0];
    port = parts[1];
    username = decodePart(parts[2]);
    password = decodePart(parts.slice(3).join(":"));
  } else if (parts.length >= 4 && /^\d+$/.test(parts[parts.length - 1]) && !username) {
    const maybeHost = parts[parts.length - 2];
    if (ipv4.test(maybeHost) || /[a-zA-Z.]/.test(maybeHost)) {
      username = decodePart(parts[0]);
      password = decodePart(parts.slice(1, -2).join(":"));
      host = maybeHost;
      port = parts[parts.length - 1];
    }
  }
  if (!host && parts.length === 3 && /^\d+$/.test(parts[1]) && !username) {
    host = parts[0];
    port = parts[1];
    username = decodePart(parts[2]);
  } else if (!host && parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) {
    port = parts[parts.length - 1];
    host = parts.slice(0, -1).join(":");
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  } else if (!host) {
    throw new Error("Proxy sai định dạng. Dùng host:port:user:pass, user:pass@host:port hoặc host:port.");
  }

  if (!host || !/^\d+$/.test(port || "")) {
    throw new Error("Proxy thiếu host hoặc port.");
  }
  const portNum = Number(port);
  if (portNum < 1 || portNum > 65535) throw new Error("Proxy port không hợp lệ.");

  return {
    server: `${protocol}://${host}:${port}`,
    username: username || undefined,
    password: password || undefined,
  };
}

function headerEnd(buf) {
  let i = buf.indexOf("\r\n\r\n");
  if (i !== -1) return { i, n: 4 };
  i = buf.indexOf("\n\n");
  if (i !== -1) return { i, n: 2 };
  return null;
}

function startProxyRelay(proxy) {
  const upstream = new URL(proxy.server);
  const upstreamHost = upstream.hostname;
  const upstreamPort = Number(upstream.port || (upstream.protocol === "https:" ? 443 : 80));
  const auth = proxy.username
    ? `Basic ${Buffer.from(`${proxy.username}:${proxy.password || ""}`).toString("base64")}`
    : null;

  const server = http.createServer((req, res) => {
    const headers = { ...req.headers };
    if (auth) headers["proxy-authorization"] = auth;
    delete headers.connection;
    delete headers["proxy-connection"];
    const hop = http.request(
      {
        host: upstreamHost,
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers,
        timeout: 25000,
      },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      },
    );
    hop.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(hop);
  });

  server.on("connect", (req, clientSocket, head) => {
    const socket = net.connect({ host: upstreamHost, port: upstreamPort }, () => {
      let payload = `CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n`;
      if (auth) payload += `Proxy-Authorization: ${auth}\r\n`;
      payload += "Proxy-Connection: Keep-Alive\r\n\r\n";
      socket.write(payload);
      if (head?.length) socket.write(head);

      let buffer = Buffer.alloc(0);
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = headerEnd(buffer);
        if (!end) return;
        socket.off("data", onData);
        const statusLine = buffer.subarray(0, buffer.indexOf("\n")).toString("utf8");
        const rest = buffer.subarray(end.i + end.n);
        if (!/ 200 /.test(statusLine)) {
          clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          socket.destroy();
          return;
        }
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) clientSocket.write(rest);
        socket.pipe(clientSocket);
        clientSocket.pipe(socket);
      };
      socket.on("data", onData);
    });
    socket.setTimeout(20000, () => {
      socket.destroy();
      clientSocket.destroy();
    });
    socket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => socket.destroy());
    clientSocket.on("close", () => socket.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        server: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            setTimeout(done, 400);
          }),
      });
    });
  });
}

async function probeProxyHost(proxy) {
  const url = new URL(proxy.server);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: url.hostname, port, timeout: 8000 }, () => {
      socket.end();
      resolve();
    });
    socket.on("error", reject);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("timeout"));
    });
  }).catch(() => {
    throw new Error(`Không nối được tới proxy ${url.hostname}:${port}. Proxy chết hoặc sai port.`);
  });
}

async function bindLaunchProxy(proxy) {
  if (!proxy?.server) return { launchProxy: undefined, relay: null };
  const socks = /^socks/i.test(proxy.server);
  if (socks && proxy.username) {
    throw new Error("Chrome không hỗ trợ SOCKS5 có user/pass. Dùng HTTP host:port:user:pass.");
  }
  if (socks || !proxy.username) {
    return {
      launchProxy: {
        server: proxy.server,
        username: proxy.username,
        password: proxy.password,
        bypass: "localhost,127.0.0.1,::1",
      },
      relay: null,
    };
  }
  const relay = await startProxyRelay(proxy);
  return {
    launchProxy: { server: relay.server, bypass: "localhost,127.0.0.1,::1" },
    relay,
  };
}

async function patchPrefsFile(file, mutator) {
  let prefs = {};
  try {
    prefs = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    prefs = {};
  }
  mutator(prefs);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(prefs));
}

async function writeChromeProxyPrefs(profileDir, launchProxy) {
  const apply = (prefs) => {
    if (launchProxy?.server) {
      prefs.proxy = {
        mode: "fixed_servers",
        server: String(launchProxy.server).replace(/^https?:\/\//i, ""),
        bypass_list: "<-loopback>,localhost,127.0.0.1",
      };
    } else {
      prefs.proxy = { mode: "direct" };
    }
  };
  await patchPrefsFile(path.join(profileDir, "Preferences"), apply);
  await patchPrefsFile(path.join(profileDir, "Default", "Preferences"), apply);
}

async function confirmProxyEgress(context, label, log) {
  const urls = ["https://api.ipify.org", "https://ipv4.icanhazip.com", "http://ip-api.com/line/?fields=query"];
  for (const url of urls) {
    try {
      const res = await context.request.get(url, { timeout: 12000 });
      if (!res.ok()) continue;
      const text = (await res.text()).trim();
      const ip = (text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/) || [])[0];
      if (ip) {
        log?.("info", `Trình duyệt đang ra mạng qua proxy ${label} — IP: ${ip}`);
        return ip;
      }
    } catch {
      // checker may be blocked by the proxy
    }
  }
  log?.("warn", `Chưa check được IP qua ${label} (site check bị chặn) — vẫn mở Dola qua proxy.`);
  return null;
}

function proxyLaunchError(err, label) {
  const msg = String(err?.message || err);
  if (/invalid url/i.test(msg)) {
    return `Proxy sai định dạng (${label}). Dùng host:port:user:pass hoặc user:pass@host:port.`;
  }
  if (/ERR_PROXY|ERR_TUNNEL|ERR_SOCKS|proxy/i.test(msg)) {
    return `Không kết nối được qua proxy ${label}. Kiểm tra proxy còn sống, đúng HTTP hoặc thêm socks5://.`;
  }
  return msg;
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
    if (!picked?.host) throw new Error("Chưa có proxy trong danh sách để xoay.");
    const proxy = parseProxy(picked.host);
    return { proxy, label: maskProxyLabel(picked.host, proxy) };
  }
  if (account.proxyMode === "fixed") {
    const picked = proxies.find((p) => p.id === account.proxyId);
    if (!picked?.host) throw new Error("Chưa chọn proxy cố định. Chọn một proxy rồi mở lại.");
    const proxy = parseProxy(picked.host);
    return { proxy, label: maskProxyLabel(picked.host, proxy) };
  }
  return { proxy: undefined, label: "trực tiếp (không proxy)" };
}

async function closeSession(accountId) {
  const session = openSessions.get(accountId);
  if (!session) return;
  openSessions.delete(accountId);
  await session.context.close().catch(() => {});
  await session.relay?.close?.().catch(() => {});
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

async function attachExtensionScripts(_context, _extensionPath) {
  // Không addInitScript inject.js — extension đã tự gắn. Gắn lần 2 làm fetch bị 401, mất phiên lúc gửi.
}

function proxyLaunchArgs() {
  return [
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--no-first-run",
    "--no-default-browser-check",
  ];
}

async function waitForExtensionWorker(context, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (context.serviceWorkers().some((worker) => worker.url().startsWith("chrome-extension://"))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await context.waitForEvent("serviceworker", { timeout: 800 }).catch(() => {});
  return context.serviceWorkers().some((worker) => worker.url().startsWith("chrome-extension://"));
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
  let contextAlive = false;
  try {
    if (existing?.context) {
      existing.context.pages();
      contextAlive = true;
    }
  } catch {
    contextAlive = false;
  }
  const wantsProxy = account.proxyMode === "fixed" || account.proxyMode === "rotate";
  if (existing && contextAlive) {
    const wrongIp =
      existing.proxyLabel !== label ||
      (wantsProxy && !existing.viaProxy) ||
      (!wantsProxy && existing.viaProxy);
    if (wrongIp) {
      log?.("info", `${account.email}: đổi sang IP đã chọn (${label}), đóng phiên cũ.`);
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
      if (existing.viaProxy || proxy) page._viaProxy = true;
      await attachAuthLock(existing.context).catch(() => {});
      if (existing.viaProxy) {
        await confirmProxyEgress(existing.context, label, log).catch(() => {});
      }
      log?.("info", `${account.email}: quản lý/chạy trên ${label}.`);
      return { account, ...existing, page, extensionLoaded: true, viaProxy: Boolean(existing.viaProxy ?? proxy) };
    }
  } else if (existing) {
    openSessions.delete(accountId);
    await existing.relay?.close?.().catch(() => {});
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
  // Chỉ --load-extension. Copy thêm vào profile sẽ nạp inject.js 2 lần → 401 lúc gửi.
  log?.("info", `${account.email}: mở phiên · ${label}`);
  if (extension?.path) {
    log?.("info", `${account.email}: DragonBMT đã gắn sẵn vào Chrome`);
  } else {
    log?.("warn", `${account.email}: thiếu gói DragonBMT trong app. Giữ thư mục studiorelay/ rồi mở lại.`);
  }

  const viaProxy = Boolean(proxy);
  let relay = null;
  let launchProxy;
  try {
    if (viaProxy) {
      await probeProxyHost(proxy);
      const bound = await bindLaunchProxy(proxy);
      launchProxy = bound.launchProxy;
      relay = bound.relay;
      if (proxy.username) {
        log?.("info", `${account.email}: gắn user/pass vào proxy — Chrome không hiện hộp nhập.`);
      } else {
        log?.("warn", `${account.email}: proxy không có user/pass. Dùng host:port:user:pass.`);
      }
      if (relay) {
        log?.("info", `${account.email}: Chrome đi ${label} qua cổng nội bộ 127.0.0.1:${relay.port}.`);
      }
    }
    await writeChromeProxyPrefs(dir, launchProxy);
  } catch (err) {
    await relay?.close?.().catch(() => {});
    throw err;
  }

  const launchOptions = {
    headless: false,
    viewport: { width: 1440, height: 920 },
    acceptDownloads: true,
    downloadsPath: VIDEO_RAW,
    proxy: launchProxy,
    ignoreDefaultArgs: ["--disable-extensions", "--disable-component-extensions-with-background-pages"],
    args: [
      "--disable-blink-features=AutomationControlled",
      ...(offscreen ? ["--window-position=-32000,-32000", "--window-size=1280,800"] : []),
      ...(viaProxy ? proxyLaunchArgs() : []),
      ...studioRelayLaunchArgs(
        extension?.path,
        [],
        viaProxy ? ["Translate", "OptimizationHints", "MediaRouter", "UseDnsHttpsSvcb"] : [],
      ),
    ],
  };
  await ensurePlaywrightChromium(log);
  let context;
  try {
    context = await chromium.launchPersistentContext(dir, launchOptions);
  } catch (first) {
    await relay?.close?.().catch(() => {});
    throw new Error(
      `${proxyLaunchError(first, label)} Dùng Chromium của tool để gắn DragonBMT — không mở Chrome máy (Chrome chặn extension).`,
    );
  }
  await attachAuthLock(context).catch(() => {});
  log?.("info", `${account.email}: đang dùng Chromium của tool, không phải Chrome máy.`);
  let extensionLoaded = false;
  if (extension?.path) {
    extensionLoaded = await waitForExtensionWorker(context, 5000);
    if (extensionLoaded) log?.("info", `${account.email}: DragonBMT đã vào Chromium (thấy service worker).`);
    else log?.("warn", `${account.email}: chưa thấy service worker DragonBMT — vẫn giữ extension trên lệnh mở.`);
  } else if (purpose === "run") {
    await context.close().catch(() => {});
    await relay?.close?.().catch(() => {});
    throw new Error("Không chạy được: thiếu gói DragonBMT trong app.");
  }
  const page = await keepSingleTab(context);
  await page.bringToFront().catch(() => {});
  if (viaProxy) {
    page._viaProxy = true;
    context.on("page", (opened) => {
      opened._viaProxy = true;
    });
    const ip = await confirmProxyEgress(context, label, log);
    log?.("info", `${account.email}: quản lý/cài đặt đi ${label}${ip ? ` · IP ${ip}` : ""}.`);
  } else {
    log?.("info", `${account.email}: không có proxy — đang đi IP máy.`);
  }
  context.on("close", () => {
    openSessions.delete(accountId);
    relay?.close?.().catch(() => {});
  });
  const session = { context, page, proxyLabel: label, accountId, purpose, viaProxy, relay };
  openSessions.set(accountId, session);
  await attachSessionDownloads(context, { account, log });
  return { account, ...session, extensionLoaded };
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
