import { Clapperboard, MonitorPlay, Ratio, Sparkles } from "lucide-react";
import { useApp } from "../store.jsx";
import { DURATIONS, LANCZOS_PRESETS, MODELS, RATIOS } from "../settingsOptions.js";

function Field({ icon: Icon, label, children }) {
  return (
    <div>
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-400">
        <Icon size={12} className="text-teal-300/70" />
        {label}
      </p>
      {children}
    </div>
  );
}

function Chips({ value, options, onChange }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((item) => (
        <button
          key={item.value}
          type="button"
          className={value === item.value ? "chip chip-on" : "chip"}
          onClick={() => onChange(item.value)}
        >
          {item.short || item.label}
        </button>
      ))}
    </div>
  );
}

export default function SettingsPanel() {
  const { settings, setSettings, extension } = useApp();
  const set = (key, value) => setSettings((prev) => ({ ...prev, [key]: value }));
  const lanczosOn = settings.resolution !== "off";

  return (
    <div className="panel p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="section-title">Thông số hệ thống</h2>
        <span className={`rounded-full px-2.5 py-1 text-[10px] font-medium ${extension?.ready ? "bg-teal-400/10 text-teal-300" : "bg-amber-400/10 text-amber-300"}`}>
          {extension?.ready ? "DragonBMT có sẵn mọi Chrome" : "Thiếu DragonBMT"}
          {" · "}
          {lanczosOn ? settings.resolution : "giữ gốc"}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field icon={Clapperboard} label="Model Seedance">
          <Chips
            value={settings.model}
            options={MODELS.map((item) => ({ ...item, short: item.label }))}
            onChange={(value) => set("model", value)}
          />
        </Field>
        <Field icon={MonitorPlay} label="Thời lượng">
          <Chips
            value={settings.duration}
            options={DURATIONS.map((item) => ({ ...item, short: item.value }))}
            onChange={(value) => set("duration", value)}
          />
        </Field>
        <Field icon={Ratio} label="Tỷ lệ khung">
          <Chips
            value={settings.ratio}
            options={RATIOS.map((item) => ({ ...item, short: item.value }))}
            onChange={(value) => set("ratio", value)}
          />
        </Field>
        <Field icon={Sparkles} label="Lanczos Pro">
          <Chips
            value={settings.resolution}
            options={LANCZOS_PRESETS.map((item) => ({
              ...item,
              short: item.value === "off" ? "Tắt" : item.value,
            }))}
            onChange={(resolution) =>
              setSettings((prev) => ({
                ...prev,
                resolution,
                lanczos: resolution !== "off",
              }))
            }
          />
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 pt-3 text-xs text-zinc-400">
        <p>
          Ép {settings.duration === "60s" ? "60s" : "30s"} qua DragonBMT. Prompt luôn kèm {settings.ratio || "16:9"}. Tối đa {settings.dailyLimit || 3} video/ngày.
        </p>
        <div className="flex flex-wrap items-center gap-2 text-zinc-300">
          {[
            ["Hạn/ngày", "dailyLimit", settings.dailyLimit || 3, (v) => set("dailyLimit", [1, 2, 3].includes(Number(v)) ? Number(v) : 3), "select"],
            ["Số video", "videoCount", settings.videoCount, (v) => set("videoCount", Number(v) || 1)],
            ["Chạy tối đa", "concurrency", settings.concurrency ?? 2, (v) => set("concurrency", Math.min(8, Math.max(1, Number(v) || 1)))],
          ].map(([label, key, value, onChange, kind]) => (
            <label key={key} className="flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-800 px-3 py-1">
              {label}
              {kind === "select" ? (
                <select className="bg-transparent text-teal-300 outline-none" value={value} onChange={(e) => onChange(e.target.value)}>
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                </select>
              ) : (
                <input
                  type="number"
                  min={1}
                  max={key === "concurrency" ? 8 : 20}
                  className="w-10 bg-transparent text-right text-teal-300 outline-none"
                  value={value}
                  onChange={(e) => onChange(e.target.value)}
                />
              )}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
