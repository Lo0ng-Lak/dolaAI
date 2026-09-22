import { Copy, Trash2 } from "lucide-react";
import { useApp } from "../store.jsx";

const tone = {
  info: "text-slate-300",
  warn: "text-amber-300",
  error: "text-red-400",
};

export default function LogPanel() {
  const { logs, setLogs } = useApp();

  const copyLogs = async () => {
    const text = logs.map((l) => `[${l.time}] [${l.level}] ${l.message}`).join("\n");
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
      <div className="min-h-0 flex-1 overflow-auto rounded-xl bg-black/25 px-3 py-2 font-mono text-[11px] leading-5">
        {logs.map((log) => (
          <p key={log.id} className={tone[log.level] || tone.info}>
            [{log.time}] {log.message}
          </p>
        ))}
      </div>
    </div>
  );
}
