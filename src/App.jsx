import Header from "./components/Header.jsx";
import Dashboard from "./components/Dashboard.jsx";
import AccountsPage from "./components/AccountsPage.jsx";
import ProxyPage from "./components/ProxyPage.jsx";
import LibraryPage from "./components/LibraryPage.jsx";
import SettingsModal from "./components/SettingsModal.jsx";
import Modal from "./components/Modal.jsx";
import { useApp } from "./store.jsx";

export default function App() {
  const { page, overlay, setOverlay } = useApp();

  return (
    <div className="flex h-full flex-col">
      <Header />
      <main className="min-h-0 flex-1 overflow-hidden p-3">
        {page === "library" ? <LibraryPage /> : <Dashboard />}
      </main>
      {overlay === "accounts" && (
        <Modal
          title="Quản lý tài khoản Google"
          subtitle="Mỗi email một phiên / một tab. Tối đa 1–2 video/ngày."
          wide
          onClose={() => setOverlay(null)}
        >
          <AccountsPage embedded />
        </Modal>
      )}
      {overlay === "proxy" && (
        <Modal
          title="Trung tâm quản lý Proxy"
          subtitle="Gắn proxy cố định hoặc xoay cho từng tài khoản."
          wide
          onClose={() => setOverlay(null)}
        >
          <ProxyPage embedded />
        </Modal>
      )}
      <SettingsModal />
    </div>
  );
}
