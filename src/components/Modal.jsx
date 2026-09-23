import { useLayoutEffect, useRef, useState } from "react";

function clampPos(x, y, width, height) {
  const maxX = Math.max(16, window.innerWidth - width - 16);
  const maxY = Math.max(16, window.innerHeight - height - 16);
  return {
    x: Math.min(maxX, Math.max(16, x)),
    y: Math.min(maxY, Math.max(16, y)),
  };
}

export default function Modal({ title, subtitle, onClose, wide = false, children }) {
  const panelRef = useRef(null);
  const dragRef = useRef(null);
  const [pos, setPos] = useState({ x: 0, y: 0, placed: false });

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    setPos({
      ...clampPos(
        Math.round((window.innerWidth - width) / 2),
        Math.round((window.innerHeight - height) / 2),
        width,
        height,
      ),
      placed: true,
    });
  }, []);

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    if (event.target.closest("button, input, select, textarea, a")) return;
    const el = panelRef.current;
    if (!el) return;
    event.preventDefault();
    const rect = el.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const el = panelRef.current;
    const next = clampPos(event.clientX - drag.dx, event.clientY - drag.dy, el?.offsetWidth || 0, el?.offsetHeight || 0);
    setPos((prev) => ({ ...prev, ...next, placed: true }));
  };

  const endDrag = (event) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-[2px]" onClick={onClose}>
      <div
        ref={panelRef}
        className={`panel fixed flex max-h-[92vh] w-full flex-col overflow-hidden ${wide ? "max-w-5xl" : "max-w-3xl"}`}
        style={{
          left: pos.x,
          top: pos.y,
          visibility: pos.placed ? "visible" : "hidden",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className="flex cursor-grab select-none items-start justify-between border-b border-zinc-800 px-5 py-4 active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div>
            <h2 className="text-sm font-semibold tracking-wide text-zinc-50">{title}</h2>
            {subtitle && <p className="mt-1 text-xs text-zinc-400">{subtitle}</p>}
          </div>
          <button type="button" className="soft-btn cursor-pointer" onClick={onClose}>
            Đóng
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  );
}
