import { useApp } from "../store.jsx";

export default function StudioPage() {
  const { settings, openDola, setPage } = useApp();

  return (
    <div className="mx-auto h-full max-w-3xl overflow-auto">
      <div className="panel p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Studio Video</h2>
          <button type="button" className="soft-btn" onClick={() => setPage("dashboard")}>
            Về dashboard
          </button>
        </div>
        <p className="mb-4 text-sm leading-6 text-ink-800">
          Studio dùng Chrome + DragonBMT chỉ để gửi lệnh. Gửi xong Chrome tắt. Tiến trình và
          video hoàn thiện ở danh sách tác vụ trong tool. Duration ép 30/60s.
        </p>
        <button type="button" className="mint-btn" onClick={openDola}>
          Mở Dola
        </button>
      </div>
    </div>
  );
}
