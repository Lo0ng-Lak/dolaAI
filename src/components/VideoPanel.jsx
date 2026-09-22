import { useEffect, useRef, useState } from "react";
import { Eye, FolderOpen, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { useApp } from "../store.jsx";

const UPSCALE = [
  { preset: "1080p", label: "1080p" },
  { preset: "1440p", label: "2K" },
  { preset: "2160p", label: "4K" },
];

function formatElapsed(createdAt) {
  const total = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function statusTone(video) {
  if (video.libraryReady || video.status === "upscaled") return "text-mint";
  if (video.status === "failed" || video.status === "lanczos_failed") return "text-rose-300";
  return "text-amber-300";
}

export default function VideoPanel() {
  const {
    videos,
    addLog,
    upscaleLocalVideos,
    refreshVideos,
    openVideoFolder,
    clearVideos,
    removeVideo,
    upscaleStoredVideo,
  } = useApp();
  const fileRef = useRef(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const live = videos.some((video) => !video.libraryReady && video.status !== "failed");
    if (!live) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [videos]);

  return (
    <div className="panel flex min-h-0 flex-1 flex-col p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="section-title">Tác vụ video live</h2>
          <span className="rounded-full border border-white/10 bg-ink-800 px-2 py-0.5 text-[10px] text-slate-400">
            {videos.length} tác vụ
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
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
          <button type="button" className="mint-btn" onClick={() => fileRef.current?.click()}>
            <Sparkles size={13} />
            Lanczos Pro
          </button>
          <button type="button" className="soft-btn" onClick={openVideoFolder}>
            <FolderOpen size={13} />
            Mở thư mục
          </button>
          <button
            type="button"
            className="soft-btn"
            onClick={() => refreshVideos().then(() => addLog("info", "Đã làm mới danh sách video."))}
          >
            <RefreshCw size={13} />
            Làm mới
          </button>
          <button type="button" className="soft-btn" onClick={clearVideos}>
            <Trash2 size={13} />
            Xóa tất cả
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-auto">
        {videos.length === 0 && (
          <p className="text-sm text-slate-500">
            Chưa có tác vụ. Sau khi gửi, % và video hoàn thiện hiện ở đây — không cần mở Chrome.
          </p>
        )}
        {videos.map((video) => {
          const ready = Boolean(video.libraryReady && video.url);
          const progress = ready ? 100 : video.progress || 0;
          return (
            <article key={video.id} className="rounded-2xl border border-white/5 bg-ink-900/90 p-3">
              <div className="flex gap-3">
                <div className="relative h-[76px] w-[132px] shrink-0 overflow-hidden rounded-xl bg-ink-800">
                  {ready ? (
                    <video className="h-full w-full object-cover" src={video.url} muted preload="metadata" />
                  ) : (
                    <div className="grid h-full w-full place-items-center text-slate-500">
                      <Eye size={18} />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-medium">{video.account || video.title}</h3>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                        <span>{video.duration || "30s"}</span>
                        <span>{video.ratio || "16:9"}</span>
                        <span className={statusTone(video)}>
                          ● {video.statusLabel || video.qualityLabel}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="text-slate-500 hover:text-rose-300"
                      onClick={() => removeVideo(video.id)}
                      title="Xóa tác vụ"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {video.prompt && (
                    <p className="mb-1 truncate text-[11px] text-slate-500">{video.prompt}</p>
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[11px] text-slate-400">
                      {ready ? "✓ " : ""}
                      {video.statusLabel || "Đang tạo"} {progress}%
                      {video.progressSource === "dola" ? " · Dola" : ""}
                      {" · "}
                      {formatElapsed(video.createdAt)}
                    </p>
                    <div className="flex items-center gap-1 text-[10px] text-slate-500">
                      <span>Upscale:</span>
                      {UPSCALE.map((item) => (
                        <button
                          key={item.preset}
                          type="button"
                          disabled={!video.rawUrl && !ready}
                          className="rounded-full border border-white/10 px-2 py-0.5 text-slate-300 hover:border-mint/40 hover:text-mint disabled:opacity-40"
                          onClick={() => upscaleStoredVideo(video.id, item.preset)}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {!ready && (
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-800">
                      <div className="h-full rounded-full bg-gradient-to-r from-mint to-[#7dfff0] transition-all" style={{ width: `${progress}%` }} />
                    </div>
                  )}
                  {video.error && <p className="mt-1 text-[11px] text-rose-300">{video.error}</p>}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
