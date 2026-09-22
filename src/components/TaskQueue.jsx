import { useRef, useState } from "react";
import { Copy, ImagePlus, Plus, Trash2, Upload } from "lucide-react";
import { useApp } from "../store.jsx";

export default function TaskQueue() {
  const {
    tasks,
    activeTaskId,
    setActiveTaskId,
    addTask,
    duplicateTask,
    removeTask,
    updateActivePrompt,
    addRefsToActive,
    clearActiveRefs,
    importBatch,
  } = useApp();
  const fileRef = useRef(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchText, setBatchText] = useState("");
  const active = tasks.find((t) => t.id === activeTaskId);

  return (
    <div className="panel flex min-h-[280px] flex-col p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="section-title">
          Hàng đợi task · {tasks.length}
        </h2>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="mint-btn" onClick={addTask}>
            <Plus size={13} />
            Thêm Task
          </button>
          <button type="button" className="soft-btn" onClick={() => setBatchOpen((v) => !v)}>
            <Upload size={13} />
            Batch Import
          </button>
          <button type="button" className="soft-btn" onClick={duplicateTask}>
            <Copy size={13} />
            Nhân bản Task
          </button>
          <button type="button" className="soft-btn" onClick={removeTask}>
            <Trash2 size={13} />
            Xóa
          </button>
        </div>
      </div>

      {batchOpen && (
        <div className="mb-3 rounded-xl border border-zinc-800 bg-zinc-800 p-3">
          <p className="mb-2 text-xs text-zinc-400">Mỗi dòng là một prompt / một task.</p>
          <textarea
            className="field min-h-24 font-mono text-xs"
            value={batchText}
            onChange={(e) => setBatchText(e.target.value)}
            placeholder="Prompt task 1&#10;Prompt task 2"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className="soft-btn" onClick={() => setBatchOpen(false)}>
              Đóng
            </button>
            <button
              type="button"
              className="mint-btn"
              onClick={() => {
                importBatch(batchText);
                setBatchText("");
                setBatchOpen(false);
              }}
            >
              Import
            </button>
          </div>
        </div>
      )}

      <div className="mb-3 flex flex-wrap gap-2">
        {tasks.map((task) => (
          <button
            key={task.id}
            type="button"
            onClick={() => setActiveTaskId(task.id)}
            className={task.id === activeTaskId ? "chip chip-on" : "chip"}
          >
            {task.title}
          </button>
        ))}
      </div>

      {active ? (
        <>
          <label className="mb-2 text-xs text-zinc-400">
            Câu mô tả (Prompt của {active.title})
            <textarea
              className="field mt-1 min-h-[180px] font-mono text-[13px] leading-6"
              value={active.prompt}
              onChange={(e) => updateActivePrompt(e.target.value)}
            />
          </label>

          <div className="mt-2">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-400">
                Mục tham chiếu của task
              </h3>
              <div className="flex gap-2">
                <button type="button" className="soft-btn" onClick={() => fileRef.current?.click()}>
                  <ImagePlus size={13} />
                  Ảnh tham chiếu
                </button>
                <button type="button" className="soft-btn" onClick={clearActiveRefs}>
                  Xóa hết
                </button>
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                addRefsToActive([...e.target.files]);
                e.target.value = "";
              }}
            />
            <div className="flex flex-wrap gap-2">
              {active.refs.length === 0 && (
                <p className="text-xs text-zinc-400">Chưa có ảnh tham chiếu.</p>
              )}
              {active.refs.map((ref) => (
                <div
                  key={ref.id}
                  className="grid h-16 w-16 place-items-center overflow-hidden rounded-lg border border-zinc-800 bg-zinc-800 text-[10px] text-zinc-400"
                >
                  {ref.url ? (
                    <img src={ref.url} alt={ref.name} className="h-full w-full object-cover" />
                  ) : (
                    ref.name
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <p className="text-sm text-zinc-400">Chưa có task. Bấm Thêm Task để bắt đầu.</p>
      )}
    </div>
  );
}
