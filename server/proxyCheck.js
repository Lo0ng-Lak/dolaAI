import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import { parseProxy, maskProxyLabel } from "./sessions.js";

const IP_URLS = ["https://api.ipify.org", "https://ipv4.icanhazip.com"];
const DOLA_URL = "https://www.dola.com/chat/";

function timeoutError(ms) {
  const err = new Error(`Hết ${Math.round(ms / 1000)}s — proxy chậm hoặc chết.`);
  err.code = "ETIMEDOUT";
  return err;
}

function readUntilHeaders(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(timeoutError(timeoutMs));
    }, timeoutMs);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const text = buf.toString("latin1");
      const end = text.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > 32 * 1024) {
          cleanup();
          reject(new Error("Proxy trả lời quá dài."));
        }
        return;
      }
      cleanup();
      resolve({ head: text.slice(0, end), rest: buf.slice(end + 4) });
    };
    const onErr = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onErr);
    };
    socket.on("data", onData);
    socket.on("error", onErr);
  });
}

function readHttpBody(socket, leftover, timeoutMs, max = 16000) {
  return new Promise((resolve, reject) => {
    let buf = leftover || Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      resolve(buf);
    }, timeoutMs);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= max) {
        cleanup();
        resolve(buf.subarray(0, max));
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(buf);
    };
    const onErr = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onErr);
    };
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("error", onErr);
  });
}

function parseStatus(head) {
  return Number((String(head || "").match(/HTTP\/\d(?:\.\d)?\s+(\d+)/) || [])[1] || 0);
}

function extractIp(text) {
  return (String(text || "").match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/) || [])[0] || "";
}

function classifyProxyError(err) {
  const msg = String(err?.message || err);
  if (/407|authentication|user\/pass|unauthorized/i.test(msg)) return "Sai user/pass proxy.";
  if (/ECONNREFUSED/i.test(msg)) return "Proxy từ chối kết nối — sai port hoặc đã tắt.";
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return "Không tìm thấy host proxy.";
  if (/ETIMEDOUT|timeout|Hết /i.test(msg)) return "Proxy chậm hoặc chết (timeout).";
  if (/ECONNRESET|socket hang up/i.test(msg)) return "Proxy cắt kết nối — hay gặp lỗi Network error trên Dola.";
  if (/ERR_PROXY|tunnel|CONNECT/i.test(msg)) return "Không tạo được tunnel qua proxy.";
  return msg.slice(0, 160);
}

async function connectProxySocket(proxy, timeoutMs = 8000) {
  const url = new URL(proxy.server);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: url.hostname, port, timeout: timeoutMs }, () => {
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.on("error", reject);
    socket.on("timeout", () => {
      socket.destroy();
      reject(timeoutError(timeoutMs));
    });
  });
}

async function httpsViaProxy(proxy, targetUrl, timeoutMs = 15000) {
  const dest = new URL(targetUrl);
  const port = Number(dest.port || 443);
  const auth = proxy.username
    ? `Basic ${Buffer.from(`${proxy.username}:${proxy.password || ""}`).toString("base64")}`
    : "";
  const socket = await connectProxySocket(proxy, Math.min(8000, timeoutMs));
  const lines = [
    `CONNECT ${dest.hostname}:${port} HTTP/1.1`,
    `Host: ${dest.hostname}:${port}`,
    "Proxy-Connection: keep-alive",
  ];
  if (auth) lines.push(`Proxy-Authorization: ${auth}`);
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);

  const { head } = await readUntilHeaders(socket, timeoutMs);
  const connectStatus = parseStatus(head);
  if (connectStatus !== 200) {
    socket.destroy();
    if (connectStatus === 407) throw new Error("Sai user/pass proxy.");
    throw new Error(`Proxy CONNECT thất bại (${connectStatus || "không có mã"}).`);
  }

  const tlsSock = await new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: dest.hostname, timeout: timeoutMs }, () => resolve(secure));
    secure.on("error", reject);
    secure.on("timeout", () => {
      secure.destroy();
      reject(timeoutError(timeoutMs));
    });
  });

  const path = `${dest.pathname || "/"}${dest.search || ""}`;
  tlsSock.write(
    `GET ${path} HTTP/1.1\r\nHost: ${dest.hostname}\r\nUser-Agent: SeedanceManager/1.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
  );
  const raw = await readHttpBody(tlsSock, Buffer.alloc(0), timeoutMs);
  tlsSock.destroy();
  const text = raw.toString("utf8");
  const sep = text.indexOf("\r\n\r\n");
  const head2 = sep >= 0 ? text.slice(0, sep) : "";
  const body = sep >= 0 ? text.slice(sep + 4) : text;
  return { status: parseStatus(head2), body };
}

async function httpViaProxy(proxy, targetUrl, timeoutMs = 15000) {
  const dest = new URL(targetUrl);
  const upstream = new URL(proxy.server);
  const auth = proxy.username
    ? Buffer.from(`${proxy.username}:${proxy.password || ""}`).toString("base64")
    : "";
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: upstream.hostname,
        port: Number(upstream.port || 80),
        method: "GET",
        path: dest.href,
        headers: {
          Host: dest.host,
          "User-Agent": "SeedanceManager/1.0",
          ...(auth ? { "Proxy-Authorization": `Basic ${auth}` } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > 8000) res.destroy();
        });
        res.on("end", () => resolve({ status: res.statusCode || 0, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(timeoutError(timeoutMs));
    });
    req.end();
  });
}

async function fetchViaProxy(proxy, url, timeoutMs = 15000) {
  if (/^socks/i.test(proxy.server)) {
    throw new Error("Chưa check SOCKS ở tab này. Đổi sang HTTP host:port:user:pass.");
  }
  return /^https:/i.test(url) ? httpsViaProxy(proxy, url, timeoutMs) : httpViaProxy(proxy, url, timeoutMs);
}

async function readEgressIp(proxy) {
  for (const url of IP_URLS) {
    try {
      const res = await fetchViaProxy(proxy, url, 12000);
      const ip = extractIp(res.body);
      if (ip) return ip;
    } catch {
      // try next checker
    }
  }
  return "";
}

async function probeDola(proxy) {
  const res = await fetchViaProxy(proxy, DOLA_URL, 15000);
  const ok = res.status >= 200 && res.status < 500;
  return { ok, status: res.status };
}

export async function checkOneProxy(rawHost) {
  const started = Date.now();
  let parsed;
  try {
    parsed = parseProxy(rawHost);
  } catch (err) {
    return {
      ok: false,
      state: "dead",
      ip: "",
      dola: false,
      ms: Date.now() - started,
      error: err.message,
      label: String(rawHost || ""),
    };
  }
  if (!parsed) {
    return {
      ok: false,
      state: "dead",
      ip: "",
      dola: false,
      ms: Date.now() - started,
      error: "Thiếu proxy.",
      label: String(rawHost || ""),
    };
  }

  const label = maskProxyLabel(rawHost, parsed);
  try {
    const socket = await connectProxySocket(parsed, 8000);
    socket.destroy();
  } catch (err) {
    return {
      ok: false,
      state: "dead",
      ip: "",
      dola: false,
      ms: Date.now() - started,
      error: classifyProxyError(err),
      label,
    };
  }

  let ip = "";
  try {
    ip = await readEgressIp(parsed);
  } catch (err) {
    return {
      ok: false,
      state: "dead",
      ip: "",
      dola: false,
      ms: Date.now() - started,
      error: classifyProxyError(err),
      label,
    };
  }

  try {
    const dola = await probeDola(parsed);
    if (!dola.ok) {
      return {
        ok: false,
        state: "warn",
        ip,
        dola: false,
        ms: Date.now() - started,
        error: `Proxy sống (IP ${ip || "?"}) nhưng Dola trả ${dola.status || "lỗi"} — dễ Network error.`,
        label,
      };
    }
    return {
      ok: true,
      state: "ok",
      ip,
      dola: true,
      ms: Date.now() - started,
      error: "",
      label,
    };
  } catch (err) {
    return {
      ok: false,
      state: ip ? "warn" : "dead",
      ip,
      dola: false,
      ms: Date.now() - started,
      error: ip
        ? `Proxy sống (IP ${ip}) nhưng không vào được Dola — ${classifyProxyError(err)}`
        : classifyProxyError(err),
      label,
    };
  }
}

export function applyCheckToProxy(item, result) {
  return {
    ...item,
    status: result.state === "ok" ? "ok" : result.state === "warn" ? "warn" : "dead",
    lastIp: result.ip || "",
    lastError: result.error || "",
    dolaOk: Boolean(result.dola),
    lastCheck: new Date().toISOString(),
    lastMs: result.ms,
  };
}
