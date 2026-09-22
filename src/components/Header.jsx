import { FolderOpen, Settings, Shield, Sparkles, Users, Clapperboard } from "lucide-react";
import { useRef } from "react";
import { useApp } from "../store.jsx";

function runtimeBadge() {
  const inApp = /electron/i.test(navigator.userAgent);
  return inApp
    ? { label: "Ứng dụng", detail: "Cửa sổ Electron" }
    : { label: "Bản web tạm", detail: "Chỉ dùng khi debug UI" };
}

export default function Header() {
  const { page, setPage, overlay, setOverlay, accounts, upscaleLocalVideos } = useApp();
  const fileRef = useRef(null);
  const runtime = runtimeBadge();

  const itemCls = (active) => `soft-btn ${active ? "border-mint/40 bg-mint/10 text-mint" : ""}`;

  return (
    <header className="flex items-center justify-between border-b border-white/5 bg-ink-900/80 px-4 py-2.5 backdrop-blur-md">
      <button type="button" onClick={() => setPage("dashboard")} className="flex items-center gap-3 text-left">
        <span className="grid h-9 w-9 place-items-center rounded-2xl bg-gradient-to-br from-mint to-[#7dfff0] text-sm font-bold text-ink-950 shadow-mint">
          P
        </span>
        <span>
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold tracking-[0.04em]">PLENKEX UNLIMITED</span>
            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400">
              Seedance 2.5 Pro
            </span>
          </span>
          <span className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500">
            DragonBMT · 30/60s · Lanczos không watermark
            <span className="rounded-full bg-mint/10 px-2 py-0.5 text-[10px] text-mint" title={runtime.detail}>
              {runtime.label}
            </span>
          </span>
        </span>
      </button>

      <div className="flex flex-wrap items-center gap-1.5">
        <input
          ref={fileRef}
          type="file"
          accept="video/*"
          multiple
          hidden
          onChange={(e) => {
            upscaleLocalVideos([...e.target.files]);
            e.target.value = "";
          }}
        />
        <button type="button" className="soft-btn" onClick={() => fileRef.current?.click()}>
          <Sparkles size={14} />
          Nâng cấp Video
        </button>
        <button type="button" className={itemCls(overlay === "accounts")} onClick={() => setOverlay("accounts")}>
          <Users size={14} />
          Tài khoản
          <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px]">{accounts.length}</span>
        </button>
        <button type="button" className={itemCls(overlay === "proxy")} onClick={() => setOverlay("proxy")}>
          <Shield size={14} />
          Proxy
        </button>
        <button
          type="button"
          className={itemCls(page === "dashboard" && !overlay)}
          onClick={() => {
            setOverlay(null);
            setPage("dashboard");
          }}
        >
          <Clapperboard size={14} />
          Studio
        </button>
        <button
          type="button"
          className={itemCls(page === "library")}
          onClick={() => {
            setOverlay(null);
            setPage("library");
          }}
        >
          <FolderOpen size={14} />
          Thư viện
        </button>
        <button type="button" className={itemCls(overlay === "settings")} onClick={() => setOverlay("settings")}>
          <Settings size={14} />
          Cài đặt
        </button>
      </div>
    </header>
  );
}
