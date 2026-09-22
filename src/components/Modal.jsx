export default function Modal({ title, subtitle, onClose, wide = false, children }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div
        className={`panel flex max-h-[92vh] w-full flex-col overflow-hidden ${wide ? "max-w-5xl" : "max-w-3xl"}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-zinc-800 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold tracking-wide text-zinc-50">{title}</h2>
            {subtitle && <p className="mt-1 text-xs text-zinc-400">{subtitle}</p>}
          </div>
          <button type="button" className="soft-btn" onClick={onClose}>
            Đóng
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  );
}
