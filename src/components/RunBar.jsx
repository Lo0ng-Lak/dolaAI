import { Play, Square, Zap } from "lucide-react";
import { useApp } from "../store.jsx";

export default function RunBar() {
  const { runTasks, cancelRun, running, tasks, activeTaskId, selectedAccountIds, videos } = useApp();
  const ready = tasks.filter((t) => t.prompt.trim()).length;
  const active = tasks.find((t) => t.id === activeTaskId);
  const canRun = !running && ready > 0 && selectedAccountIds.length > 0;
  const live = videos.filter((video) => !video.libraryReady && video.status !== "failed" && video.status !== "lanczos_failed");
  const avg = live.length
    ? Math.round(live.reduce((sum, video) => sum + (Number(video.progress) || 0), 0) / live.length)
    : running
      ? 2
      : 0;

  return (
    <div className="shrink-0 space-y-2 rounded-2xl border border-line bg-white p-3 shadow-panel">
      <button
        type="button"
        onClick={() => runTasks(false)}
        disabled={!canRun}
        className="flex w-full items-center justify-center gap-2 rounded-full bg-mint px-4 py-3.5 text-sm font-semibold uppercase tracking-wide text-white shadow-mint transition hover:bg-mintDim disabled:cursor-not-allowed disabled:opacity-45"
      >
        <Zap size={16} />
        {running ? "Đang chạy..." : `Chạy tất cả tác vụ (Batch Run) · ${ready} task`}
      </button>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => runTasks(true)}
          disabled={!canRun || !active?.prompt?.trim()}
          className="soft-btn justify-center py-2.5"
        >
          <Play size={14} />
          {active ? `Chạy ${active.title}` : "Chạy task đang chọn"}
        </button>
        <button
          type="button"
          onClick={cancelRun}
          disabled={!running}
          className="soft-btn justify-center py-2.5 text-rose-600 disabled:text-ink-600"
        >
          <Square size={14} />
          Hủy tiến trình (tất cả)
        </button>
      </div>

      <div className="flex items-center gap-3 px-1 text-[11px] text-ink-700">
        <span className="shrink-0">
          {running ? "Đang gửi / tạo video" : live.length ? `${live.length} tác vụ đang xử lý` : "Tiến độ hàng đợi: sẵn sàng"}
        </span>
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-200">
          <div
            className="h-full rounded-full bg-mint transition-all"
            style={{ width: `${running && avg < 2 ? 8 : avg}%` }}
          />
        </div>
        <span className="w-8 text-right">{avg}%</span>
      </div>
    </div>
  );
}
