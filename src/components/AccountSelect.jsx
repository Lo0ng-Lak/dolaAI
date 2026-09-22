import { RefreshCw, Search } from "lucide-react";
import { useApp } from "../store.jsx";

function label(account) {
  if (account.status === "active" && account.sessionOk) return { text: "Active", cls: "bg-emerald-500/15 text-emerald-300" };
  if (account.status === "need_login") return { text: "Chưa login", cls: "bg-rose-500/15 text-rose-300" };
  return { text: account.status || "Chưa kiểm tra", cls: "bg-white/10 text-slate-300" };
}

export default function AccountSelect() {
  const {
    accounts,
    selectedAccountIds,
    toggleAccount,
    selectAllAccounts,
    settings,
    setSettings,
    refreshData,
    setOverlay,
  } = useApp();

  return (
    <div className="panel p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="section-title">
          Tài khoản đã login ({selectedAccountIds.length}/{accounts.length})
        </h2>
        <div className="flex items-center gap-2">
          <button type="button" className="soft-btn" onClick={refreshData}>
            <RefreshCw size={13} />
            Làm mới
          </button>
          <button type="button" className="soft-btn" onClick={() => setOverlay("accounts")}>
            <Search size={13} />
            Quản lý phiên
          </button>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-slate-300">
        <button
          type="button"
          className="flex items-center gap-2"
          onClick={() => selectAllAccounts(!(selectedAccountIds.length === accounts.length && accounts.length > 0))}
        >
          <span
            className="switch"
            data-on={String(selectedAccountIds.length === accounts.length && accounts.length > 0)}
          />
          Chọn tất cả
        </button>
        <button
          type="button"
          className="flex items-center gap-2"
          onClick={() => setSettings((prev) => ({ ...prev, rotateAccounts: !prev.rotateAccounts }))}
        >
          <span className="switch" data-on={String(Boolean(settings.rotateAccounts))} />
          Xoay vòng tài khoản
        </button>
      </div>

      <div className="space-y-2">
        {accounts.length === 0 && (
          <p className="text-sm text-slate-500">Chưa có tài khoản. Vào Quản lý phiên để thêm Google account.</p>
        )}
        {accounts.map((acc) => {
          const checked = selectedAccountIds.includes(acc.id);
          const badge = label(acc);
          return (
            <label
              key={acc.id}
              className={`flex cursor-pointer items-center justify-between rounded-2xl border px-3 py-2.5 transition ${
                checked ? "border-mint/25 bg-mint/[0.06]" : "border-white/5 bg-ink-900/80 hover:border-white/10"
              }`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <input className="accent-mint" type="checkbox" checked={checked} onChange={() => toggleAccount(acc.id)} />
                <span
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold text-ink-950"
                  style={{ background: acc.accent || "#2ee6c8" }}
                >
                  {(acc.email || "?").slice(0, 1).toUpperCase()}
                </span>
                <span className="truncate text-sm">{acc.email}</span>
              </span>
              <span className="flex items-center gap-2 text-xs text-slate-400">
                <span className="hidden sm:inline">
                  {acc.proxyMode === "rotate" ? "Proxy xoay" : acc.proxyMode === "fixed" ? "Proxy cố định" : "Direct"}
                </span>
                <span className={acc.quotaFull ? "text-amber-300" : "text-slate-400"}>
                  {acc.sentToday || 0}/{acc.dailyLimit || 2}
                </span>
                <span className={`rounded-full px-2 py-0.5 ${badge.cls}`}>{badge.text}</span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
