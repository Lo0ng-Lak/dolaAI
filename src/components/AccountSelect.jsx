import { RefreshCw, Search } from "lucide-react";
import { useApp } from "../store.jsx";

function loggedIn(account) {
  return account.status === "active" && account.sessionOk;
}

function label(account) {
  if (loggedIn(account)) return { text: "Đã login", cls: "bg-teal-400/15 text-teal-300" };
  return { text: "Chưa login", cls: "bg-rose-400/10 text-rose-300" };
}

export default function AccountSelect() {
  const {
    accounts,
    selectedAccountIds,
    toggleAccount,
    selectAllAccounts,
    settings,
    setSettings,
    checkAllAccounts,
    setOverlay,
  } = useApp();
  const readyIds = accounts.filter(loggedIn).map((a) => a.id);

  return (
    <div className="panel p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="section-title">
          Tài khoản đã login ({readyIds.length}/{accounts.length}) · chọn {selectedAccountIds.length}
        </h2>
        <div className="flex items-center gap-2">
          <button type="button" className="soft-btn" onClick={checkAllAccounts}>
            <RefreshCw size={13} />
            Kiểm tra phiên
          </button>
          <button type="button" className="soft-btn" onClick={() => setOverlay("accounts")}>
            <Search size={13} />
            Quản lý phiên
          </button>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-zinc-300">
        <button
          type="button"
          className="flex items-center gap-2"
          onClick={() => selectAllAccounts(!(selectedAccountIds.length === readyIds.length && readyIds.length > 0))}
        >
          <span
            className="switch"
            data-on={String(readyIds.length > 0 && selectedAccountIds.length === readyIds.length)}
          />
          Chọn tất cả đã login
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
          <p className="text-sm text-zinc-400">Chưa có tài khoản. Vào Quản lý phiên để thêm Google account.</p>
        )}
        {accounts.length > 0 && readyIds.length === 0 && (
          <p className="text-sm text-rose-300">Chưa có tài khoản đã login — không chạy được. Mở trình duyệt, đăng nhập Google.</p>
        )}
        {accounts.map((acc) => {
          const checked = selectedAccountIds.includes(acc.id);
          const ok = loggedIn(acc);
          const badge = label(acc);
          return (
            <label
              key={acc.id}
              className={`flex items-center justify-between rounded-2xl border px-3 py-2.5 transition ${
                ok
                  ? checked
                    ? "cursor-pointer border-teal-400 bg-teal-400/15"
                    : "cursor-pointer border-teal-400/35 bg-teal-400/5 hover:border-teal-400/60"
                  : "cursor-not-allowed border-zinc-800 bg-zinc-900/80 opacity-70"
              }`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <input
                  className="accent-teal-400"
                  type="checkbox"
                  checked={checked}
                  disabled={!ok}
                  onChange={() => toggleAccount(acc.id)}
                />
                <span
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold text-[#08110f]"
                  style={{ background: acc.accent || "#2ee6c8" }}
                >
                  {(acc.email || "?").slice(0, 1).toUpperCase()}
                </span>
                <span className="truncate text-sm">{acc.email}</span>
              </span>
              <span className="flex items-center gap-2 text-xs text-zinc-400">
                <span className="hidden sm:inline">
                  {acc.proxyMode === "rotate" ? "Proxy xoay" : acc.proxyMode === "fixed" ? "Proxy cố định" : "Direct"}
                </span>
                <span className={acc.quotaFull ? "text-amber-300" : "text-zinc-400"}>
                  {acc.sentToday || 0}/{acc.dailyLimit || 3}
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
