import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { forcedDuration } from "../shared/promptSpec.js";
import { normalizeAccountQuota } from "../shared/quota.js";

export const DOLA_URL = "https://www.dola.com/chat/";

const SAMPLE_PROMPT = `A family is sitting together at a dinner table, eating dinner and having a conversation. The family is sitting together at a dining table, eating dinner and having a natural, lively family conversation for the entire shot.

A four-year-old looks at mom and responds naturally. He listens, nods, and reacts with small facial expressions. Mom smiles softly, looks at him naturally, and joins the conversation.

All four characters move naturally, make little head turns, shift their posture slightly, and show gentle body movement. The interaction feels lively, friendly, and natural.

Smooth 20s cartoon animation, stable camera, clean motion, natural expressions, no sudden movement, no character distortion, no duplicated characters, no extra limbs, no extra fingers, no extra objects.`;

function nowLog(level, message) {
  const t = new Date();
  const stamp = t.toTimeString().slice(0, 8);
  return { id: crypto.randomUUID(), time: stamp, level, message };
}

async function readJson(res) {
  return res.json().catch(() => ({}));
}

async function refToImage(ref) {
  const source = ref.file || (ref.url ? await fetch(ref.url).then((r) => r.blob()) : null);
  if (!source) return null;
  const buffer = await source.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return {
    name: ref.name || ref.file?.name || "ref.png",
    type: source.type || "image/png",
    data: btoa(binary),
  };
}

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [page, setPage] = useState("dashboard");
  const [overlay, setOverlay] = useState(null);
  const [settings, setSettings] = useState(() => {
    const defaults = {
      model: "Dreamina Seedance 2.5",
      videoCount: 1,
      extension: true,
      ratio: "16:9",
      duration: "30s",
      resolution: "2160p",
      lanczos: true,
      rotateAccounts: true,
      dailyLimit: 2,
      hideChrome: true,
      startDelay: 0,
      nextDelay: 3,
      concurrency: 2,
    };
    try {
      const saved = JSON.parse(localStorage.getItem("sedan-settings") || "null");
      return saved && typeof saved === "object" ? { ...defaults, ...saved } : defaults;
    } catch {
      return defaults;
    }
  });
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState([]);
  const [inspectId, setInspectId] = useState(null);
  const [tasks, setTasks] = useState([
    { id: "t1", title: "Task #1", prompt: SAMPLE_PROMPT, refs: [] },
  ]);
  const [activeTaskId, setActiveTaskId] = useState("t1");
  const [videos, setVideos] = useState([]);
  const [logs, setLogs] = useState([
    nowLog("info", "Ứng dụng sẵn sàng."),
    nowLog("info", "Theo dõi tiến trình ngay trong tool. Chrome chỉ chạy ẩn nền, không cần tự mở."),
  ]);
  const [proxies, setProxies] = useState([]);
  const [running, setRunning] = useState(false);
  const [extension, setExtension] = useState({ ready: false });
  const [openAccountIds, setOpenAccountIds] = useState([]);

  const addLog = (level, message) => {
    setLogs((prev) => [nowLog(level, message), ...prev].slice(0, 200));
  };

  useEffect(() => {
    setSettings((prev) => {
      const duration = forcedDuration(prev);
      return prev.duration === duration ? prev : { ...prev, duration };
    });
  }, []);

  useEffect(() => {
    localStorage.setItem("sedan-settings", JSON.stringify(settings));
  }, [settings]);

  const applyAccounts = (next) => {
    if (!Array.isArray(next)) return;
    const normalized = next.map((account) => normalizeAccountQuota(account, settings.dailyLimit));
    setAccounts(normalized);
    setSelectedAccountIds((prev) => {
      const keep = prev.filter((id) => next.some((a) => a.id === id));
      return keep.length ? keep : next.filter((a) => a.status === "active").map((a) => a.id);
    });
    setInspectId((prev) => (next.some((a) => a.id === prev) ? prev : next[0]?.id || null));
  };

  const refreshData = async () => {
    const [accRes, proxyRes, extRes, videoRes, statusRes] = await Promise.all([
      fetch("/api/accounts"),
      fetch("/api/proxies"),
      fetch("/api/extension"),
      fetch("/api/videos"),
      fetch("/api/status"),
    ]);
    applyAccounts(await accRes.json());
    setProxies(await proxyRes.json());
    if (extRes.ok) setExtension(await extRes.json());
    if (videoRes.ok) setVideos(await videoRes.json());
    if (statusRes.ok) {
      const status = await statusRes.json();
      setOpenAccountIds(Array.isArray(status.openAccounts) ? status.openAccounts : []);
    }
  };

  useEffect(() => {
    refreshData().catch(() => addLog("warn", "Chưa kết nối được server quản lý phiên."));
    const source = new EventSource("/api/events");
    source.onmessage = (event) => {
      try {
        const entry = JSON.parse(event.data);
        if (entry.type === "video" && entry.video) {
          setVideos((prev) => {
            const next = prev.filter((item) => item.id !== entry.video.id);
            return [entry.video, ...next];
          });
          return;
        }
        if (entry.message) addLog(entry.level || "info", entry.message);
      } catch {
        // ignore
      }
    };
    source.onerror = () => {};
    return () => source.close();
  }, []);

  const toggleAccount = (id) => {
    setSelectedAccountIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const selectAllAccounts = (on) => {
    setSelectedAccountIds(on ? accounts.map((a) => a.id) : []);
  };

  const addTask = () => {
    const n = tasks.length + 1;
    const task = { id: crypto.randomUUID(), title: `Task #${n}`, prompt: "", refs: [] };
    setTasks((prev) => [...prev, task]);
    setActiveTaskId(task.id);
    addLog("info", `Đã thêm ${task.title}.`);
  };

  const duplicateTask = () => {
    const current = tasks.find((t) => t.id === activeTaskId);
    if (!current) return;
    const copy = {
      ...current,
      id: crypto.randomUUID(),
      title: `${current.title} (bản sao)`,
      refs: current.refs.map((r) => ({ ...r, id: crypto.randomUUID() })),
    };
    setTasks((prev) => [...prev, copy]);
    setActiveTaskId(copy.id);
    addLog("info", `Đã nhân bản ${current.title}.`);
  };

  const removeTask = () => {
    if (tasks.length === 0) return;
    const next = tasks.filter((t) => t.id !== activeTaskId);
    setTasks(next);
    setActiveTaskId(next[0]?.id ?? null);
    addLog("warn", "Đã xóa task đang chọn.");
  };

  const updateActivePrompt = (prompt) => {
    setTasks((prev) => prev.map((t) => (t.id === activeTaskId ? { ...t, prompt } : t)));
  };

  const addRefsToActive = (files) => {
    const extras = files.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      url: URL.createObjectURL(file),
      file,
    }));
    setTasks((prev) =>
      prev.map((t) => (t.id === activeTaskId ? { ...t, refs: [...t.refs, ...extras] } : t)),
    );
    addLog("info", `Đã thêm ${extras.length} ảnh tham chiếu.`);
  };

  const clearActiveRefs = () => {
    setTasks((prev) => prev.map((t) => (t.id === activeTaskId ? { ...t, refs: [] } : t)));
  };

  const importBatch = (text) => {
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return;
    const imported = lines.map((prompt, i) => ({
      id: crypto.randomUUID(),
      title: `Task #${tasks.length + i + 1}`,
      prompt,
      refs: [],
    }));
    setTasks((prev) => [...prev, ...imported]);
    setActiveTaskId(imported[0].id);
    addLog("info", `Batch import ${imported.length} task.`);
  };

  const addAccount = async (email) => {
    const res = await fetch("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await readJson(res);
    if (!res.ok) {
      addLog("error", data.error || "Không thêm được tài khoản.");
      return;
    }
    await refreshData();
  };

  const importAccounts = async (text) => {
    const res = await fetch("/api/accounts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await readJson(res);
    if (data.accounts) applyAccounts(data.accounts);
  };

  const updateAccount = async (id, patch) => {
    const res = await fetch(`/api/accounts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) await refreshData();
  };

  const removeAccount = async (id) => {
    const res = await fetch(`/api/accounts/${id}`, { method: "DELETE" });
    const next = await readJson(res);
    if (Array.isArray(next)) applyAccounts(next);
  };

  const openAccount = async (id) => {
    const res = await fetch(`/api/accounts/${id}/open`, { method: "POST" });
    const data = await readJson(res);
    if (data.accounts) applyAccounts(data.accounts);
    if (!res.ok) addLog("error", data.error || "Không mở được phiên.");
  };

  const checkAccount = async (id) => {
    const res = await fetch(`/api/accounts/${id}/check`, { method: "POST" });
    const data = await readJson(res);
    if (data.accounts) applyAccounts(data.accounts);
    if (!res.ok) addLog("error", data.error || "Không kiểm tra được phiên.");
  };

  const importAccountCookies = async (id, cookies) => {
    const res = await fetch(`/api/accounts/${id}/cookies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookies }),
    });
    const data = await readJson(res);
    if (data.accounts) applyAccounts(data.accounts);
    if (!res.ok) addLog("error", data.error || "Không nạp được cookie.");
  };

  const addProxy = async (host) => {
    const res = await fetch("/api/proxies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host }),
    });
    if (res.ok) await refreshData();
  };

  const removeProxy = async (id) => {
    const res = await fetch(`/api/proxies/${id}`, { method: "DELETE" });
    setProxies(await readJson(res));
  };

  const upscaleLocalVideos = async (files) => {
    if (settings.resolution === "off") {
      addLog("info", "Lanczos Pro đang tắt — giữ 720p gốc.");
      return;
    }
    for (const file of files) {
      addLog("info", `Lanczos Pro: ${file.name} → ${settings.resolution}`);
      const res = await fetch(
        `/api/upscale?preset=${encodeURIComponent(settings.resolution)}&name=${encodeURIComponent(file.name)}`,
        {
          method: "POST",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        },
      );
      if (!res.ok) {
        const data = await readJson(res);
        addLog("error", data.error || `Không nâng cấp được ${file.name}`);
        continue;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const outName = file.name.replace(/(\.[^.]+)?$/, `_lanczos_${settings.resolution}$1`);
      setVideos((prev) => [
        {
          id: crypto.randomUUID(),
          title: outName,
          account: "Lanczos Pro",
          duration: settings.resolution,
          status: "upscaled",
          url,
        },
        ...prev,
      ]);
      const link = document.createElement("a");
      link.href = url;
      link.download = outName;
      link.click();
      addLog("info", `Đã xuất ${outName}`);
    }
  };

  const refreshVideos = async () => {
    const res = await fetch("/api/videos");
    if (res.ok) setVideos(await res.json());
  };

  const openVideoFolder = async () => {
    const res = await fetch("/api/videos/open-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "lanczos" }),
    });
    const data = await readJson(res);
    if (!res.ok) addLog("error", data.error || "Không mở được thư mục video.");
    else addLog("info", `Thư mục video: ${data.folder}`);
  };

  const clearVideos = async () => {
    await fetch("/api/videos", { method: "DELETE" }).catch(() => {});
    setVideos([]);
  };

  const removeVideo = async (id) => {
    const res = await fetch(`/api/videos/${id}`, { method: "DELETE" });
    const data = await readJson(res);
    if (res.ok && Array.isArray(data.videos)) setVideos(data.videos);
    else setVideos((prev) => prev.filter((item) => item.id !== id));
  };

  const upscaleStoredVideo = async (id, preset) => {
    addLog("info", `Lanczos tác vụ → ${preset}`);
    const res = await fetch(`/api/videos/${id}/upscale`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset }),
    });
    const data = await readJson(res);
    if (!res.ok) {
      addLog("error", data.error || "Không Lanczos được tác vụ này.");
      return;
    }
    if (data.video) {
      setVideos((prev) => {
        const next = prev.filter((item) => item.id !== data.video.id);
        return [data.video, ...next];
      });
    }
  };

  const openDola = async () => {
    const id = selectedAccountIds[0] || accounts[0]?.id;
    if (!id) {
      addLog("warn", "Thêm tài khoản Google trước.");
      setOverlay("accounts");
      return;
    }
    await openAccount(id);
  };

  const cancelRun = async () => {
    await fetch("/api/cancel", { method: "POST" }).catch(() => {});
    addLog("warn", "Đã gửi lệnh hủy. Task đang gửi sẽ dừng sau lượt hiện tại.");
  };

  const runTasks = async (onlyActive = false) => {
    if (running) return;
    const ready = (onlyActive
      ? tasks.filter((t) => t.id === activeTaskId && t.prompt.trim())
      : tasks.filter((t) => t.prompt.trim()));
    if (!ready.length) {
      addLog("warn", "Không có task nào có prompt.");
      return;
    }
    if (!selectedAccountIds.length) {
      addLog("warn", "Chọn ít nhất một tài khoản để chạy task.");
      return;
    }
    const selected = accounts.filter((account) => selectedAccountIds.includes(account.id));
    const loggedIn = selected.filter((account) => account.status === "active" && account.sessionOk);
    if (!loggedIn.length) {
      addLog("warn", "Chưa có tài khoản đã đăng nhập. Mở trình duyệt, login Google một lần, rồi chạy.");
      setOverlay("accounts");
      return;
    }
    if (loggedIn.length < selected.length) {
      addLog("warn", `Bỏ ${selected.length - loggedIn.length} tài khoản chưa login / hết phiên.`);
    }
    setRunning(true);
    addLog(
      "info",
      `Gửi ${ready.length} task qua DragonBMT · ép ${forcedDuration(settings)} · ${settings.ratio} · ${settings.model}`,
    );
    try {
      const payload = {
        settings: { ...settings, duration: forcedDuration(settings), extension: true },
        accountIds: loggedIn.map((account) => account.id),
        tasks: await Promise.all(
          ready.map(async (task) => ({
            id: task.id,
            title: task.title,
            prompt: task.prompt,
            images: (await Promise.all(task.refs.map(refToImage))).filter(Boolean),
          })),
        ),
      };
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await readJson(res);
      if (data.accounts) applyAccounts(data.accounts);
      if (Array.isArray(data.openAccounts)) setOpenAccountIds(data.openAccounts);
      if (data.result?.openAccounts) setOpenAccountIds(data.result.openAccounts);
      if (!res.ok) addLog("error", data.error || "Chạy task thất bại.");
      else await refreshData();
    } catch (err) {
      addLog("error", err.message || "Không gọi được runner Dola.");
    } finally {
      setRunning(false);
    }
  };

  const value = useMemo(
    () => ({
      page,
      setPage,
      overlay,
      setOverlay,
      settings,
      setSettings,
      accounts,
      selectedAccountIds,
      inspectId,
      setInspectId,
      toggleAccount,
      selectAllAccounts,
      addAccount,
      importAccounts,
      updateAccount,
      removeAccount,
      openAccount,
      checkAccount,
      importAccountCookies,
      refreshData,
      tasks,
      activeTaskId,
      setActiveTaskId,
      addTask,
      duplicateTask,
      removeTask,
      updateActivePrompt,
      addRefsToActive,
      clearActiveRefs,
      importBatch,
      videos,
      setVideos,
      logs,
      addLog,
      setLogs,
      proxies,
      addProxy,
      removeProxy,
      openDola,
      runTasks,
      cancelRun,
      upscaleLocalVideos,
      refreshVideos,
      openVideoFolder,
      clearVideos,
      removeVideo,
      upscaleStoredVideo,
      running,
      extension,
      openAccountIds,
    }),
    [
      page,
      overlay,
      settings,
      accounts,
      selectedAccountIds,
      inspectId,
      tasks,
      activeTaskId,
      videos,
      logs,
      proxies,
      running,
      extension,
      openAccountIds,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}
