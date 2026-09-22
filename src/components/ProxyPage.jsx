import { useState } from "react";
import { useApp } from "../store.jsx";

export default function ProxyPage({ embedded = false }) {
  const { proxies, addProxy, removeProxy, setPage } = useApp();
  const [value, setValue] = useState("");

  const add = async () => {
    const host = value.trim();
    if (!host) return;
    await addProxy(host);
    setValue("");
  };

  return (
    <div className={embedded ? "p-5" : "mx-auto h-full max-w-4xl overflow-auto"}>
      <div className={embedded ? "" : "panel p-5"}>
        {!embedded && (
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Quản lý Proxy</h2>
              <p className="text-sm text-slate-400">
                Lưu danh sách proxy. Trong trang tài khoản, gắn từng phiên: trực tiếp, cố định, hoặc xoay.
              </p>
            </div>
            <button type="button" className="soft-btn" onClick={() => setPage("dashboard")}>
              Về dashboard
            </button>
          </div>
        )}

        <div className="mb-4 flex gap-2">
          <input
            className="field"
            placeholder="host:port hoặc user:pass@host:port"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <button type="button" className="mint-btn shrink-0" onClick={add}>
            Thêm proxy
          </button>
        </div>

        <p className="mb-3 text-xs text-slate-500">{proxies.length} proxy · gắn vào từng tài khoản ở Quản lý tài khoản</p>

        <div className="space-y-2">
          {proxies.length === 0 && <p className="text-sm text-slate-500">Chưa có proxy.</p>}
          {proxies.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between rounded-lg border border-white/5 bg-ink-900 px-3 py-2"
            >
              <span className="min-w-0">
                <span className="block font-mono text-sm">{p.host}</span>
                <span className="text-[11px] text-slate-500">{p.status === "idle" ? "Sẵn sàng" : p.status || "Sẵn sàng"}</span>
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
