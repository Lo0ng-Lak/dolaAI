import { useMemo, useState } from "react";
import {
  Cookie,
  Globe,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useApp } from "../store.jsx";

function statusBadge(account) {
  if (account.status === "active" && account.sessionOk) {
    return <span className="text-xs font-medium text-emerald-700">Active</span>;
  }
  if (account.status === "need_login") {
    return <span className="text-xs font-medium text-rose-700">Chưa đăng nhập</span>;
  }
  return <span className="text-xs font-medium text-amber-700">{account.status || "Chưa kiểm tra"}</span>;
}

export default function AccountsPage({ embedded = false }) {
  const {
    accounts,
    proxies,
    inspectId,
    setInspectId,
    addAccount,
    importAccounts,
    updateAccount,
    removeAccount,
    openAccount,
    checkAccount,
    importAccountCookies,
    refreshData,
    setPage,
  } = useApp();

  const [query, setQuery] = useState("");
  const [email, setEmail] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [cookieOpen, setCookieOpen] = useState(false);
  const [cookieText, setCookieText] = useState("");

  const selected = accounts.find((a) => a.id === inspectId) || accounts[0];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? accounts.filter((a) => a.email.toLowerCase().includes(q)) : accounts;
  }, [accounts, query]);

  const addNew = async () => {
    if (!email.trim()) return;
    await addAccount(email.trim());
    setEmail("");
  };

  const applyCookies = async () => {
    if (!selected) return;
    let cookies;
    try {
      cookies = JSON.parse(cookieText);
      if (!Array.isArray(cookies)) cookies = cookies.cookies || [];
    } catch {
      return;
    }
    await importAccountCookies(selected.id, cookies);
    setCookieOpen(false);
    setCookieText("");
  };

  return (
    <div className={`flex flex-col overflow-hidden ${embedded ? "h-[70vh]" : "panel h-full"}`}>
      {!embedded && (
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-ink-900">
            Quản lý tài khoản Google ({accounts.length} tài khoản)
          </h2>
          <p className="mt-1 text-xs text-ink-700">
            Đăng nhập một lần, giữ phiên. Khi chạy, tool mở đúng Chrome đã login rồi gửi task.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="soft-btn" onClick={refreshData}>
            <RefreshCw size={13} />
            Làm mới
          </button>
          <button type="button" className="soft-btn" onClick={() => setPage("dashboard")}>
            <X size={13} />
            Đóng
          </button>
        </div>
      </div>
      )}
      {embedded && (
        <div className="flex justify-end gap-2 border-b border-line px-5 py-2">
          <button type="button" className="soft-btn" onClick={refreshData}>
            <RefreshCw size={13} />
            Làm mới
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[42%] flex-col border-r border-line p-4">
          <div className="mb-3 flex flex-wrap gap-2">
            <div className="relative min-w-[160px] flex-1">
              <Search size={13} className="absolute left-2.5 top-2.5 text-ink-700" />
              <input
                className="field pl-8"
                placeholder="Tìm email"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <button type="button" className="soft-btn" onClick={() => setImportOpen((v) => !v)}>
              <Upload size={13} />
              Nạp file
            </button>
            <button type="button" className="soft-btn" onClick={() => setCookieOpen((v) => !v)}>
              <Cookie size={13} />
              Cookies
            </button>
          </div>

          <div className="mb-3 flex gap-2">
            <input
              className="field"
              placeholder="email@gmail.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addNew()}
            />
            <button type="button" className="mint-btn shrink-0" onClick={addNew}>
              <Plus size={13} />
              Thêm mới
            </button>
          </div>

          {importOpen && (
            <div className="mb-3 rounded-lg border border-line bg-slate-50 p-3">
              <p className="mb-2 text-xs text-ink-700">Mỗi dòng một email.</p>
              <textarea
                className="field min-h-24 font-mono text-xs"
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
              />
              <div className="mt-2 flex justify-end gap-2">
                <button type="button" className="soft-btn" onClick={() => setImportOpen(false)}>
                  Đóng
                </button>
                <button
                  type="button"
                  className="mint-btn"
                  onClick={async () => {
                    await importAccounts(importText);
                    setImportText("");
                    setImportOpen(false);
                  }}
                >
                  Import
                </button>
              </div>
            </div>
          )}

          <div className="min-h-0 flex-1 space-y-2 overflow-auto pr-1">
            {filtered.length === 0 && (
              <p className="text-sm text-ink-700">Chưa có tài khoản. Thêm email Google của bạn.</p>
            )}
            {filtered.map((acc) => {
              const active = selected?.id === acc.id;
              return (
                <button
                  key={acc.id}
                  type="button"
                  onClick={() => setInspectId(acc.id)}
                  className={`w-full rounded-xl border px-3 py-3 text-left ${
                    active ? "border-mint bg-mintSoft" : "border-line bg-slate-50"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-3">
                      <span
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold text-ink-950"
                        style={{ background: acc.accent }}
                      >
                        {acc.email.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm">{acc.email}</span>
                        <span className="flex items-center gap-2">
                          {statusBadge(acc)}
                          <span className={`text-[11px] ${acc.quotaFull ? "text-amber-700" : "text-ink-700"}`}>
                            {acc.sentToday || 0}/{acc.dailyLimit || 2} video hôm nay
                          </span>
                        </span>
                      </span>
                    </div>
                    <span className="flex shrink-0 gap-1">
                      <span
                        className="soft-btn px-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          checkAccount(acc.id);
                        }}
                      >
                        Kiểm tra
                      </span>
                      <span
                        className="soft-btn px-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          openAccount(acc.id);
                        }}
                      >
                        Mở Web
                      </span>
                      <span
                        className="soft-btn px-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeAccount(acc.id);
                        }}
                      >
                        <Trash2 size={12} />
                      </span>
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="min-w-0 flex-1 overflow-auto p-5">
          {!selected ? (
            <p className="text-sm text-ink-700">Chọn một tài khoản bên trái.</p>
          ) : (
            <div className="space-y-4">
              <div>
                <p className="text-[11px] uppercase tracking-[0.16em] text-ink-700">Tài khoản đang chọn</p>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <h3 className="truncate text-lg font-medium">{selected.email}</h3>
                  {statusBadge(selected)}
                </div>
              </div>

              <div className="rounded-xl border border-line bg-slate-50 p-4">
                <p className="text-sm font-medium">Đăng nhập trực tiếp Google</p>
                <p className="mt-2 text-xs leading-5 text-ink-700">
                  Bấm <span className="font-medium text-ink-950">Mở trình duyệt</span> nếu chưa login.
                  Đã có cookie thì Chrome tự tắt. Kiểm tra phiên xong cũng tự tắt.
                </p>
              </div>

              <div className="rounded-xl border border-line bg-slate-50 p-4">
                <p className="text-sm font-medium">Hạn mức video trong ngày</p>
                <p className="mt-1 text-xs text-ink-700">
                  Tối đa 1 hoặc 2 video / tài khoản / ngày. Hết hạn thì dừng tài khoản đó. Qua ngày tự reset, gửi tiếp được.
                </p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <select
                    className="field"
                    value={selected.dailyLimit || 2}
                    onChange={(e) => updateAccount(selected.id, { dailyLimit: Number(e.target.value) === 1 ? 1 : 2 })}
                  >
                    <option value={1}>1 video / ngày</option>
                    <option value={2}>2 video / ngày</option>
                  </select>
                  <div className="flex items-center rounded-lg border border-line bg-white px-3 text-xs text-ink-800">
                    Hôm nay {selected.sentToday || 0}/{selected.dailyLimit || 2}
                    {selected.quotaFull ? " · hết hạn, chờ ngày mai" : ` · còn ${selected.remaining ?? (selected.dailyLimit || 2) - (selected.sentToday || 0)}`}
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-line bg-slate-50 p-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Cấu hình Proxy lên kết</p>
                    <p className="text-xs text-ink-700">
                      Mặc định dùng IP gốc. Chọn proxy cố định/xoay nếu muốn đổi IP. Cookie đăng nhập vẫn giữ trong profile.
                    </p>
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <select
                    className="field"
                    value={selected.proxyMode}
                    onChange={(e) => updateAccount(selected.id, { proxyMode: e.target.value })}
                  >
                    <option value="direct">Mặc định (IP gốc / Direct)</option>
                    <option value="fixed">Proxy cố định</option>
                    <option value="rotate">Proxy xoay</option>
                  </select>
                  <select
                    className="field"
                    value={selected.proxyId || ""}
                    disabled={selected.proxyMode !== "fixed"}
                    onChange={(e) => updateAccount(selected.id, { proxyId: e.target.value })}
                  >
                    <option value="">Chọn proxy</option>
                    {proxies.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.host}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <button type="button" className="mint-btn justify-center py-3 text-sm" onClick={() => openAccount(selected.id)}>
                  <Globe size={14} />
                  Mở trình duyệt
                </button>
                <button type="button" className="soft-btn justify-center py-3 text-sm" onClick={() => checkAccount(selected.id)}>
                  Kiểm tra phiên
                </button>
              </div>

              <div className="rounded-xl border border-line bg-slate-50 p-4 text-xs text-ink-700">
                <p className="mb-2 font-medium text-ink-900">Trạng thái cookie / session</p>
                <p>
                  {selected.sessionOk
                    ? `Đã lưu phiên Active — chạy task sẽ vào đúng ${selected.email}.`
                    : "Chưa login. Mở trình duyệt, đăng nhập Google. Đã login thì Chrome tự tắt."}
                </p>
                {selected.lastCheck && (
                  <p className="mt-1 text-ink-700">Kiểm tra lần cuối: {new Date(selected.lastCheck).toLocaleString()}</p>
                )}
              </div>

              {cookieOpen && (
                <div className="rounded-xl border border-line bg-slate-50 p-4">
                  <p className="mb-2 text-xs text-ink-700">
                    Dán JSON cookie do bạn xuất từ chính tài khoản này (mảng name/value/domain).
                  </p>
                  <textarea
                    className="field min-h-28 font-mono text-xs"
                    value={cookieText}
                    onChange={(e) => setCookieText(e.target.value)}
                  />
                  <div className="mt-2 flex justify-end gap-2">
                    <button type="button" className="soft-btn" onClick={() => setCookieOpen(false)}>
                      Đóng
                    </button>
                    <button type="button" className="mint-btn" onClick={applyCookies}>
                      Nạp cookie
                    </button>
                  </div>
                </div>
              )}

              <div>
                <p className="mb-2 text-[11px] uppercase tracking-[0.16em] text-ink-700">
                  Danh sách tài khoản ({accounts.length})
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {accounts.map((acc) => (
                    <button
                      key={acc.id}
                      type="button"
                      onClick={() => setInspectId(acc.id)}
                      className="flex items-center justify-between rounded-lg border border-line bg-slate-50 px-3 py-2 text-left"
                    >
                      <span className="truncate text-xs">{acc.email}</span>
                      {statusBadge(acc)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
