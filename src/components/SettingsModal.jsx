import { FolderOpen } from "lucide-react";
import { useApp } from "../store.jsx";
import Modal from "./Modal.jsx";

export default function SettingsModal() {
  const { settings, setSettings, overlay, setOverlay, openVideoFolder, extension } = useApp();
  if (overlay !== "settings") return null;

  const set = (key, value) => setSettings((prev) => ({ ...prev, [key]: value }));

  return (
    <Modal
      title="Cài đặt hệ thống"
      subtitle="Thông số tự động hóa — khớp dashboard, tài khoản, proxy và DragonBMT."
      onClose={() => setOverlay(null)}
    >
      <div className="space-y-4 p-5">
        <div className="rounded-xl border border-zinc-800 bg-zinc-800 px-4 py-3">
          <p className="text-xs text-zinc-400">
            {extension?.ready
              ? "DragonBMT có sẵn trong mọi cấu hình Chrome"
              : "Thiếu gói DragonBMT trong app"}{" "}
            · ép {settings.duration} · {settings.ratio} ·{" "}
            {settings.resolution}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs text-zinc-400">
            Chờ trước task đầu (giây)
            <input
              type="number"
              min={0}
              max={120}
              className="field mt-1"
              value={settings.startDelay ?? 0}
              onChange={(e) => set("startDelay", Math.max(0, Number(e.target.value) || 0))}
            />
          </label>
          <label className="text-xs text-zinc-400">
            Chờ giữa các task (giây)
            <input
              type="number"
              min={0}
              max={120}
              className="field mt-1"
              value={settings.nextDelay ?? 3}
              onChange={(e) => set("nextDelay", Math.max(0, Number(e.target.value) || 0))}
            />
          </label>
          <label className="text-xs text-zinc-400">
            Chạy tối đa (song song)
            <input
              type="number"
              min={1}
              max={8}
              className="field mt-1"
              value={settings.concurrency ?? 2}
              onChange={(e) => set("concurrency", Math.min(8, Math.max(1, Number(e.target.value) || 1)))}
            />
            <span className="mt-1 block text-[11px] text-zinc-400">
              Số trình duyệt / tài khoản chạy cùng lúc. Mỗi email vẫn 1 Chrome.
            </span>
          </label>
          <label className="text-xs text-zinc-400">
            Video / tài khoản / ngày
            <select
              className="field mt-1"
              value={settings.dailyLimit || 3}
              onChange={(e) => set("dailyLimit", [1, 2, 3].includes(Number(e.target.value)) ? Number(e.target.value) : 3)}
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </label>
          <label className="text-xs text-zinc-400">
            Số video mỗi lần chạy
            <input
              type="number"
              min={1}
              max={20}
              className="field mt-1"
              value={settings.videoCount}
              onChange={(e) => set("videoCount", Number(e.target.value) || 1)}
            />
          </label>
        </div>

        <label className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-800 px-4 py-3 text-sm">
          <span>
            Ẩn Chrome sau khi gửi
            <span className="mt-1 block text-xs text-zinc-400">
              Bật: thu nhỏ Chrome, giữ phiên nền để đọc % và tải file. Tắt: để cửa sổ hiện.
            </span>
          </span>
          <input
            type="checkbox"
            checked={settings.hideChrome !== false}
            onChange={(e) => set("hideChrome", e.target.checked)}
          />
        </label>

        <label className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-800 px-4 py-3 text-sm">
          <span>
            Xoay tài khoản khi chạy
            <span className="mt-1 block text-xs text-zinc-400">Phân task lần lượt theo email còn hạn mức.</span>
          </span>
          <input
            type="checkbox"
            checked={Boolean(settings.rotateAccounts)}
            onChange={(e) => set("rotateAccounts", e.target.checked)}
          />
        </label>

        <div className="rounded-xl border border-zinc-800 bg-zinc-800 px-4 py-3">
          <p className="text-xs uppercase tracking-[0.14em] text-zinc-400">Thư mục video Lanczos</p>
          <p className="mt-1 text-sm text-zinc-300">Video hoàn thiện lưu trong thư viện tool, không watermark.</p>
          <button type="button" className="mint-btn mt-3" onClick={openVideoFolder}>
            <FolderOpen size={14} />
            Mở thư mục
          </button>
        </div>
      </div>
    </Modal>
  );
}
