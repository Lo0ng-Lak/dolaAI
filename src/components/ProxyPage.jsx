import { useState } from "react";
import { useApp } from "../store.jsx";

export default function ProxyPage({ embedded = false }) {
  const { proxies, addProxy, removeProxy, setPage } = useApp();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const lineCount = value
    .split(/[\r\n,;]+/)
    .map((line) => line.trim())
    .filter(Boolean).length;

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
              {busy ? "Đang thêm..." : lineCount > 1 ? `Thêm ${lineCount} proxy` : "Thêm proxy"}
            </button>
          </div>
        </div>

        <p className="mb-3 text-xs text-zinc-400">{proxies.length} proxy · gắn vào từng tài khoản ở Quản lý tài khoản</p>

        <div className="space-y-2">
          {proxies.length === 0 && <p className="text-sm text-zinc-400">Chưa có proxy.</p>}
          {proxies.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-800 px-3 py-2"
            >
              <span className="min-w-0">
                <span className="block font-mono text-sm">{p.host}</span>
                <span className="text-[11px] text-zinc-400">{p.status === "idle" ? "Sẵn sàng" : p.status || "Sẵn sàng"}</span>
              </span>
              <button type="button" className="soft-btn" onClick={() => removeProxy(p.id)}>
                Xóa
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
