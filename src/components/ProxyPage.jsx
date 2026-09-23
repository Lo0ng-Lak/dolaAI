import { useState } from "react";
import { useApp } from "../store.jsx";

function proxyNote(p) {
  if (p.status === "checking") return "Đang kiểm tra...";
  if (p.status === "ok") {
    return `Sống${p.lastIp ? ` · IP ${p.lastIp}` : ""} · Dola OK${p.lastMs ? ` · ${p.lastMs}ms` : ""}`;
  }
  if (p.status === "warn") {
    return p.lastError || "Sống nhưng Dola lỗi mạng — dễ Network error.";
  }
  if (p.status === "dead") {
    return p.lastError || "Proxy chết.";
  }
  return p.status === "idle" ? "Chưa kiểm tra" : p.status || "Chưa kiểm tra";
}

function rowClass(status) {
  if (status === "ok") return "border-teal-400/30 bg-teal-400/5";
  if (status === "warn") return "border-amber-400/30 bg-amber-400/5";
  if (status === "dead") return "border-rose-400/30 bg-rose-400/5";
  if (status === "checking") return "border-sky-400/30 bg-sky-400/5";
  return "border-zinc-800 bg-zinc-800";
}

export default function ProxyPage({ embedded = false }) {
  const { proxies, addProxy, removeProxy, checkProxy, checkAllProxies, setPage } = useApp();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkingId, setCheckingId] = useState("");

  const lineCount = value
    .split(/[\r\n,;]+/)
    .map((line) => line.trim())
    .filter(Boolean).length;
  const checking = busy || Boolean(checkingId) || proxies.some((p) => p.status === "checking");

  const add = async () => {
    const host = value.trim();
    if (!host || busy) return;
    setBusy(true);
    try {
      await addProxy(host);
      setValue("");
    } finally {
      setBusy(false);
    }
  };

  const checkOne = async (id) => {
    setCheckingId(id);
    try {
      await checkProxy(id);
    } finally {
      setCheckingId("");
    }
  };

  const checkAll = async () => {
    if (!proxies.length || checking) return;
    setBusy(true);
    try {
      await checkAllProxies();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={embedded ? "p-5" : "mx-auto h-full max-w-4xl overflow-auto"}>
      <div className={embedded ? "" : "panel p-5"}>
        {!embedded && (
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Quản lý Proxy</h2>
              <p className="text-sm text-zinc-400">
                Dán nhiều dòng một lượt: host:port:user:pass. Tool tự tách user/pass, bỏ dòng trùng.
              </p>
            </div>
            <button type="button" className="soft-btn" onClick={() => setPage("dashboard")}>
              Về dashboard
            </button>
          </div>
        )}

        <div className="mb-4">
          <textarea
            className="field min-h-[140px] resize-y font-mono text-xs"
            placeholder={"host:port:user:pass\nhost:port:user:pass\nuser:pass@host:port"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) add();
            }}
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-zinc-400">
              {lineCount ? `${lineCount} dòng sẽ thêm` : "Mỗi dòng một proxy · Ctrl+Enter để thêm"}
            </p>
            <button type="button" className="mint-btn shrink-0" disabled={!lineCount || busy} onClick={add}>
              {busy && !checkingId ? "Đang thêm..." : lineCount > 1 ? `Thêm ${lineCount} proxy` : "Thêm proxy"}
            </button>
          </div>
        </div>

        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-zinc-400">
            {proxies.length} proxy · check sống/chết + có vào được Dola (tránh Network error)
          </p>
          <button type="button" className="soft-btn" disabled={!proxies.length || checking} onClick={checkAll}>
            {checking && !checkingId ? "Đang kiểm tra..." : "Kiểm tra tất cả"}
          </button>
        </div>

        <div className="space-y-2">
          {proxies.length === 0 && <p className="text-sm text-zinc-400">Chưa có proxy.</p>}
          {proxies.map((p) => (
            <div key={p.id} className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${rowClass(p.status)}`}>
              <span className="min-w-0">
                <span className="block truncate font-mono text-sm">{p.host}</span>
                <span className="block text-[11px] text-zinc-400">{proxyNote(p)}</span>
              </span>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  className="soft-btn"
                  disabled={checking}
                  onClick={() => checkOne(p.id)}
                >
                  {p.status === "checking" || checkingId === p.id ? "..." : "Check"}
                </button>
                <button type="button" className="soft-btn" onClick={() => removeProxy(p.id)}>
                  Xóa
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
