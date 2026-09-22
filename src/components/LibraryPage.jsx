import { useMemo, useState } from "react";
import { useApp } from "../store.jsx";

export default function LibraryPage() {
  const { videos, setPage, openVideoFolder, refreshVideos } = useApp();
  const [query, setQuery] = useState("");
  const ready = videos.filter((video) => video.libraryReady && video.url);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ready;
    return ready.filter((video) =>
      `${video.account} ${video.title} ${video.prompt || ""} ${video.qualityLabel || ""}`.toLowerCase().includes(q),
    );
  }, [ready, query]);

  return (
    <div className="h-full overflow-auto">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Thư viện Video Studio</h2>
          <p className="text-xs text-zinc-400">
            Chỉ bản đã Lanczos, không watermark, đúng chất lượng đã cài đặt.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="soft-btn" onClick={refreshVideos}>
            Làm mới
          </button>
          <button type="button" className="soft-btn" onClick={openVideoFolder}>
            Mở thư mục
          </button>
          <button type="button" className="soft-btn" onClick={() => setPage("dashboard")}>
            Về studio
          </button>
        </div>
      </div>
      <input
        className="field mb-4 max-w-md"
        placeholder="Tìm kiếm video theo prompt, tài khoản..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {filtered.length === 0 && (
          <p className="text-sm text-zinc-400">
            {ready.length ? "Không khớp từ khóa." : "Chưa có video thư viện. Clip đang xử lý vào đây sau khi Lanczos xong."}
          </p>
        )}
        {filtered.map((video) => (
          <article key={video.id} className="panel p-3">
            <video className="mb-2 aspect-video w-full rounded-xl bg-black object-cover" src={video.url} controls preload="metadata" />
            <h3 className="truncate text-sm font-medium">{video.prompt || video.title}</h3>
            <p className="text-xs font-medium text-teal-300">{video.qualityLabel}</p>
            <p className="text-xs text-zinc-400">
              {video.account} · {video.duration}
              {video.height ? ` · ${video.height}p` : ""}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}
