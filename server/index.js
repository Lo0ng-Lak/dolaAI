import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { EventEmitter } from "node:events";
import { upscaleVideo, upscaleLabel } from "./upscale.js";
import { loadAccounts, saveAccounts, loadProxies, saveProxies, makeAccount } from "./store.js";
import { closeAccountSession, markAccount, maskProxyLabel, parseProxy, profileDir, removeAccountProfile } from "./sessions.js";
import {
  openAccountBrowser,
  checkAccountSession,
  runTasks,
  getStatus,
  importCookies,
  cancelRun,
} from "./dola.js";
import { installDragonBmtEverywhere, installExtensionIntoProfile, resolveStudioRelayPath } from "./extension.js";
import { cancelAllCollects, cancelCollect } from "./collect.js";
import {
  bindVideoEvents,
  clearVideoRecords,
  getVideoRecord,
  loadVideos,
  openVideoFolder,
  relanczosVideo,
  removeVideo,
  startVideoWatch,
} from "./videos.js";
import { VIDEO_DIR, VIDEO_OUT, VIDEO_RAW } from "./paths.js";
import { isClosedNoise, sanitizeLog } from "./logText.js";

const app = express();
const bus = new EventEmitter();
bus.setMaxListeners(50);

app.use(express.json({ limit: "80mb" }));

async function provisionAccountExtension(accountId) {
  const extension = await resolveStudioRelayPath();
  if (!extension?.path) return null;
  const dir = profileDir(accountId);
  await fs.mkdir(dir, { recursive: true });
  return installExtensionIntoProfile(dir, extension);
}

function log(level, message) {
  const clean = sanitizeLog(level, message);
  if (!clean) return;
  const entry = { time: new Date().toTimeString().slice(0, 8), ...clean };
  bus.emit("log", entry);
  console.log(`[${entry.time}] [${entry.level}] ${entry.message}`);
}

bindVideoEvents({
  log,
  video: (video) => bus.emit("video", video),
});

app.get("/api/status", (_req, res) => {
  res.json(getStatus());
});

app.get("/api/extension", async (_req, res) => {
  const extension = await resolveStudioRelayPath();
  res.json(
    extension
      ? { ready: true, source: extension.source, path: extension.path, name: extension.name }
      : { ready: false },
  );
});

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const send = (entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`);
  const onLog = (entry) => send({ type: "log", ...entry });
  const onVideo = (video) => send({ type: "video", video });
  bus.on("log", onLog);
  bus.on("video", onVideo);
  send({ type: "log", level: "info", time: new Date().toTimeString().slice(0, 8), message: "Nhật ký realtime đã kết nối." });
  const keep = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clearInterval(keep);
    bus.off("log", onLog);
    bus.off("video", onVideo);
  });
});

app.get("/api/videos", async (_req, res) => {
  res.json(await loadVideos());
});

app.delete("/api/videos", async (_req, res) => {
  cancelAllCollects();
  await clearVideoRecords();
  res.json([]);
});

app.delete("/api/videos/:id", async (req, res) => {
  cancelCollect(req.params.id);
  const ok = await removeVideo(req.params.id);
  if (!ok) return res.status(404).json({ error: "Không tìm thấy tác vụ video." });
  res.json({ ok: true, videos: await loadVideos() });
});

app.post("/api/videos/:id/upscale", async (req, res) => {
  try {
    const preset = String(req.body?.preset || req.query.preset || "2160p");
    const video = await relanczosVideo(req.params.id, preset, log);
    res.json({ ok: true, video });
  } catch (err) {
    log("error", err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/videos/open-folder", async (req, res) => {
  try {
    const folder = await openVideoFolder(req.body?.kind || req.query.kind || "lanczos");
    res.json({ ok: true, folder });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/videos/:id/file", async (req, res) => {
  const record = getVideoRecord(req.params.id);
  if (!record) return res.status(404).json({ error: "Không tìm thấy video." });
  const kind = String(req.query.kind || "out");
  const filePath = kind === "raw" ? record.rawPath : record.outputPath;
  if (kind !== "raw" && !filePath) {
    return res.status(409).json({ error: "Video chưa qua Lanczos, chưa vào thư viện." });
  }
  const allowed = [VIDEO_DIR, VIDEO_RAW, VIDEO_OUT];
  const ok = allowed.some((root) => filePath && path.resolve(filePath).startsWith(path.resolve(root)));
  if (!ok) return res.status(403).json({ error: "Đường dẫn video không hợp lệ." });
  try {
    await fs.access(filePath);
    res.setHeader("Content-Type", "video/mp4");
    res.sendFile(path.resolve(filePath));
  } catch {
    res.status(404).json({ error: "File video chưa có trên đĩa." });
  }
});

app.get("/api/accounts", async (_req, res) => {
  res.json(await loadAccounts());
});

app.post("/api/accounts", async (req, res) => {
  const email = String(req.body?.email || "").trim();
  if (!email) return res.status(400).json({ error: "Thiếu email." });
  const accounts = await loadAccounts();
  if (accounts.some((a) => a.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: "Email đã tồn tại." });
  }
  const account = makeAccount(email, req.body, accounts.length);
  accounts.push(account);
  await saveAccounts(accounts);
  await provisionAccountExtension(account.id);
  log("info", `Đã thêm tài khoản ${email} · DragonBMT đã gắn vào profile Chrome.`);
  res.json(account);
});

app.post("/api/accounts/import", async (req, res) => {
  const lines = String(req.body?.text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const accounts = await loadAccounts();
  const added = [];
  for (const line of lines) {
    const email = line.split(/[\s|,;]+/)[0];
    if (!email || accounts.some((a) => a.email.toLowerCase() === email.toLowerCase())) continue;
    const account = makeAccount(email, {}, accounts.length + added.length);
    accounts.push(account);
    added.push(account);
  }
  await saveAccounts(accounts);
  for (const account of added) await provisionAccountExtension(account.id);
  log("info", `Import ${added.length} tài khoản · DragonBMT đã gắn sẵn.`);
  res.json({ added, accounts });
});

app.patch("/api/accounts/:id", async (req, res) => {
  const patch = req.body || {};
  if (patch.proxyMode !== undefined || patch.proxyId !== undefined) {
    await closeAccountSession(req.params.id);
    log("info", "Đổi proxy — đã đóng phiên cũ. Lần mở tiếp theo dùng proxy mới, đúng 1 tab.");
  }
  const account = await markAccount(req.params.id, patch);
  if (!account) return res.status(404).json({ error: "Không tìm thấy tài khoản." });
  res.json(account);
});

app.delete("/api/accounts/:id", async (req, res) => {
  const accounts = await loadAccounts();
  const next = accounts.filter((a) => a.id !== req.params.id);
  if (next.length === accounts.length) return res.status(404).json({ error: "Không tìm thấy tài khoản." });
  await saveAccounts(next);
  await removeAccountProfile(req.params.id);
  log("warn", "Đã xóa tài khoản và phiên trình duyệt riêng.");
  res.json(next);
});

app.post("/api/accounts/:id/open", async (req, res) => {
  try {
    const result = await openAccountBrowser(req.params.id, log);
    res.json({ ok: true, ...result, accounts: await loadAccounts() });
  } catch (err) {
    if (isClosedNoise(err.message)) {
      log("info", "Đã tắt Chrome.");
      return res.json({ ok: true, accounts: await loadAccounts() });
    }
    log("error", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/accounts/:id/check", async (req, res) => {
  try {
    const result = await checkAccountSession(req.params.id, log);
    res.json({ ok: true, ...result, accounts: await loadAccounts() });
  } catch (err) {
    if (isClosedNoise(err.message)) {
      log("info", "Đã tắt Chrome.");
      return res.json({ ok: true, accounts: await loadAccounts() });
    }
    log("error", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/accounts/:id/cookies", async (req, res) => {
  try {
    const result = await importCookies(req.params.id, req.body?.cookies, log);
    res.json({ ok: true, ...result, accounts: await loadAccounts() });
  } catch (err) {
    log("error", err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get("/api/proxies", async (_req, res) => {
  res.json(await loadProxies());
});

function splitProxyLines(raw) {
  return String(raw || "")
    .split(/[\r\n,;]+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function proxyKey(host, parsed) {
  if (parsed?.server) return `${parsed.server}|${parsed.username || ""}`.toLowerCase();
  return String(host || "").trim().toLowerCase();
}

app.post("/api/proxies", async (req, res) => {
  const lines = [
    ...splitProxyLines(req.body?.host),
    ...splitProxyLines((req.body?.hosts || []).join("\n")),
  ];
  const unique = [...new Set(lines)];
  if (!unique.length) return res.status(400).json({ error: "Thiếu proxy. Dán nhiều dòng host:port:user:pass." });

  const proxies = await loadProxies();
  const seen = new Set(proxies.map((item) => {
    try {
      return proxyKey(item.host, parseProxy(item.host));
    } catch {
      return String(item.host || "").toLowerCase();
    }
  }));

  const added = [];
  const skipped = [];
  const invalid = [];
  for (const host of unique) {
    let parsed;
    try {
      parsed = parseProxy(host);
    } catch (err) {
      invalid.push({ host, error: err.message });
      continue;
    }
    if (!parsed) {
      invalid.push({ host, error: "Thiếu proxy." });
      continue;
    }
    const key = proxyKey(host, parsed);
    if (seen.has(key)) {
      skipped.push(host);
      continue;
    }
    seen.add(key);
    const item = { id: crypto.randomUUID(), host, status: "idle" };
    proxies.push(item);
    added.push(item);
  }

  if (added.length) await saveProxies(proxies);
  if (added.length) {
    log("info", `Đã thêm ${added.length} proxy một lượt${skipped.length ? ` · trùng ${skipped.length}` : ""}${invalid.length ? ` · sai ${invalid.length}` : ""}.`);
  } else if (invalid.length && !skipped.length) {
    return res.status(400).json({ error: invalid[0].error, added, skipped, invalid, proxies });
  } else {
    log("info", `Không thêm proxy mới${skipped.length ? ` · ${skipped.length} dòng trùng` : ""}${invalid.length ? ` · ${invalid.length} dòng sai` : ""}.`);
  }
  res.json({ added, skipped, invalid, proxies });
});

app.delete("/api/proxies/:id", async (req, res) => {
  const proxies = (await loadProxies()).filter((p) => p.id !== req.params.id);
  await saveProxies(proxies);
  res.json(proxies);
});

app.post("/api/open", async (req, res) => {
  try {
    const accounts = await loadAccounts();
    const id = req.body?.accountId || accounts[0]?.id;
    if (!id) throw new Error("Chưa có tài khoản. Thêm tài khoản Google trước.");
    const result = await openAccountBrowser(id, log);
    res.json({ ok: true, ...result, accounts: await loadAccounts() });
  } catch (err) {
    log("error", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/cancel", (_req, res) => {
  const result = cancelRun();
  if (result.ok) log("warn", "Người dùng hủy tiến trình chạy.");
  res.json(result);
});

app.post("/api/run", async (req, res) => {
  try {
    const result = await runTasks(req.body, log);
    res.json({ ok: true, result, accounts: await loadAccounts() });
  } catch (err) {
    log("error", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/upscale", express.raw({ type: "*/*", limit: "800mb" }), async (req, res) => {
  try {
    const preset = String(req.query.preset || "2160p");
    const name = String(req.query.name || "video.mp4").replace(/[<>:"/\\|?*]/g, "_");
    if (preset === "off") {
      return res.json({ ok: true, skipped: true, label: upscaleLabel(preset) });
    }

    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
    if (!buffer.length) throw new Error("Chưa nhận được file video.");

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lanczos-"));
    const inputPath = path.join(dir, name);
    await fs.writeFile(inputPath, buffer);
    log("info", `Lanczos Pro: đang nâng cấp ${name} → ${upscaleLabel(preset)}`);
    const result = await upscaleVideo(inputPath, preset);
    const output = await fs.readFile(result.outputPath);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${path.basename(result.outputPath)}"`,
    );
    res.send(output);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  } catch (err) {
    log("error", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export function startServer({ port = Number(process.env.DOLA_PORT || 5176), staticDir } = {}) {
  if (staticDir) {
    app.use(express.static(staticDir));
    app.get(/.*/, (req, res, next) => {
      if (req.path.startsWith("/api")) return next();
      res.sendFile(path.join(staticDir, "index.html"));
    });
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", async () => {
      const url = `http://127.0.0.1:${port}`;
      const extension = await resolveStudioRelayPath();
      if (extension?.path) {
        const accounts = await loadAccounts();
        for (const account of accounts) await provisionAccountExtension(account.id);
        const installed = await installDragonBmtEverywhere();
        log("info", `DragonBMT đã gắn sẵn vào mọi cấu hình Chrome (${installed.profiles} profile).`);
      } else {
        log("warn", "Thiếu gói DragonBMT trong app. Giữ thư mục studiorelay/ rồi mở lại.");
      }
      await loadVideos();
      await startVideoWatch(log);
      console.log(`Dola runner listening on ${url}`);
      resolve({ server, port, url });
    });
    server.on("error", reject);
  });
}

