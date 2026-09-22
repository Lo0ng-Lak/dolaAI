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

  const itemCls = (active) => `soft-btn ${active ? "border-teal-400/50 bg-teal-400/10 text-teal-300" : ""}`;

  return (
    <header className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-5 py-3">
      <button type="button" onClick={() => setPage("dashboard")} className="flex items-center gap-3 text-left">
        <span className="grid h-10 w-10 place-items-center rounded-2xl bg-teal-400 text-sm font-bold text-[#08110f] shadow-teal-400/20">
          P
        </span>
        <span>
          <span className="flex items-center gap-2">
            <span className="text-[15px] font-semibold tracking-tight text-zinc-50">PLENKEX UNLIMITED</span>
            <span className="rounded-full bg-teal-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-teal-300">
              Seedance 2.5 Pro
            </span>
          </span>
          <span className="mt-0.5 flex items-center gap-2 text-[11px] text-zinc-400">
            DragonBMT · 30/60s · Lanczos không watermark
            <span className="rounded-full bg-teal-400/10 px-2 py-0.5 text-[10px] font-medium text-teal-300" title={runtime.detail}>
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
          <span className="rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-200">{accounts.length}</span>
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
