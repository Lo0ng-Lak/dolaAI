import { Play, Square, Zap } from "lucide-react";
import { useApp } from "../store.jsx";

export default function RunBar() {
  const { runTasks, cancelRun, running, tasks, activeTaskId, selectedAccountIds, accounts, videos } = useApp();
  const ready = tasks.filter((t) => t.prompt.trim()).length;
  const active = tasks.find((t) => t.id === activeTaskId);
  const loggedInSelected = accounts.filter(
    (account) => selectedAccountIds.includes(account.id) && account.status === "active" && account.sessionOk,
  );
  const canRun = !running && ready > 0 && loggedInSelected.length > 0;
  const live = videos.filter((video) => !video.libraryReady && video.status !== "failed" && video.status !== "lanczos_failed");
  const avg = live.length
    ? Math.round(live.reduce((sum, video) => sum + (Number(video.progress) || 0), 0) / live.length)
    : running
      ? 2
      : 0;

  return (
    <div className="shrink-0 space-y-2 rounded-2xl border border-zinc-800 bg-zinc-900 p-3 shadow-black/40">
      <button
        type="button"
        onClick={() => runTasks(false)}
        disabled={!canRun}
        className="flex w-full items-center justify-center gap-2 rounded-full bg-teal-400 px-4 py-3.5 text-sm font-semibold uppercase tracking-wide text-[#08110f] shadow-teal-400/20 transition hover:bg-[#6ff7df] disabled:cursor-not-allowed disabled:opacity-45"
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
          className="soft-btn justify-center py-2.5 text-rose-300 disabled:text-zinc-500"
        >
          <Square size={14} />
          Hủy tiến trình (tất cả)
        </button>
      </div>

      <div className="flex items-center gap-3 px-1 text-[11px] text-zinc-400">
        <span className="shrink-0">
          {running ? "Đang gửi / tạo video" : live.length ? `${live.length} tác vụ đang xử lý` : "Tiến độ hàng đợi: sẵn sàng"}
        </span>
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[#0d1118]">
          <div
            className="h-full rounded-full bg-teal-400 transition-all"
            style={{ width: `${running && avg < 2 ? 8 : avg}%` }}
          />
        </div>
        <span className="w-8 text-right">{avg}%</span>
      </div>
      {loggedInSelected.length === 0 && (
        <p className="px-1 text-[11px] text-rose-300">Chưa có tài khoản đã login — không chạy được.</p>
      )}
    </div>
  );
}
