import { useEffect, useRef } from "react";
import { Copy, Trash2 } from "lucide-react";
import { useApp } from "../store.jsx";

const tone = {
  info: "text-zinc-100",
  warn: "text-amber-200",
  error: "text-rose-300",
};

const badge = {
  info: "bg-teal-400/10 text-teal-300",
  warn: "bg-amber-400/10 text-amber-300",
  error: "bg-rose-400/10 text-rose-300",
};

const badgeLabel = {
  info: "OK",
  warn: "CẢNH BÁO",
  error: "LỖI",
};

export default function LogPanel() {
  const { logs, setLogs } = useApp();
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [logs]);

  const copyLogs = async () => {
    const text = logs.map((item) => `[${item.time}] [${item.level}] ${item.message}`).join("\n");
    await navigator.clipboard.writeText(text);
  };

  return (
    <div className="panel flex min-h-[280px] flex-1 flex-col p-4">
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
      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2">
        {logs.length === 0 && <p className="text-xs text-zinc-400">Chưa có nhật ký.</p>}
        {logs.map((item) => (
          <p key={item.id} className={`flex gap-2 text-[12px] leading-5 ${tone[item.level] || tone.info}`}>
            <span className="shrink-0 font-mono text-zinc-500">{item.time}</span>
            <span className={`mt-0.5 h-4 shrink-0 rounded px-1.5 text-[9px] font-semibold leading-4 ${badge[item.level] || badge.info}`}>
              {badgeLabel[item.level] || "OK"}
            </span>
            <span className="min-w-0 break-words">{item.message}</span>
          </p>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
