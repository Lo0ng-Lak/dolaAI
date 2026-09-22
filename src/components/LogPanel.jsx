import { Copy, Trash2 } from "lucide-react";
import { useApp } from "../store.jsx";

const tone = {
  info: "text-ink-900",
  warn: "text-amber-800",
  error: "text-rose-700",
};

const badge = {
  info: "bg-mintSoft text-mintDim",
  warn: "bg-amber-50 text-amber-700",
  error: "bg-rose-50 text-rose-700",
};

const badgeLabel = {
  info: "OK",
  warn: "CẢNH BÁO",
  error: "LỖI",
};

export default function LogPanel() {
  const { logs, setLogs } = useApp();

  const copyLogs = async () => {
    const text = logs.map((item) => `[${item.time}] [${item.level}] ${item.message}`).join("\n");
    await navigator.clipboard.writeText(text);
  };

  return (
    <div className="panel flex h-[240px] flex-col p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="section-title">Nhật ký realtime</h2>
        <div className="flex gap-2">
          <button type="button" className="soft-btn" onClick={copyLogs}>
            <Copy size={13} />
            Sao chép
          </button>
          <button type="button" className="soft-btn" onClick={() => setLogs([])}>
            <Trash2 size={13} />
            Xóa nhật ký
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto rounded-xl border border-line bg-slate-50 px-3 py-2">
        {logs.length === 0 && <p className="text-xs text-ink-700">Chưa có nhật ký.</p>}
        {logs.map((item) => (
          <p key={item.id} className={`flex gap-2 text-[12px] leading-5 ${tone[item.level] || tone.info}`}>
            <span className="shrink-0 font-mono text-ink-600">{item.time}</span>
            <span className={`mt-0.5 h-4 shrink-0 rounded px-1.5 text-[9px] font-semibold leading-4 ${badge[item.level] || badge.info}`}>
              {badgeLabel[item.level] || "OK"}
            </span>
            <span className="min-w-0 break-words">{item.message}</span>
          </p>
        ))}
      </div>
    </div>
  );
}
