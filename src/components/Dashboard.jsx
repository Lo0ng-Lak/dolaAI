import RunBar from "./RunBar.jsx";
import SettingsPanel from "./SettingsPanel.jsx";
import AccountSelect from "./AccountSelect.jsx";
import TaskQueue from "./TaskQueue.jsx";
import VideoPanel from "./VideoPanel.jsx";
import LogPanel from "./LogPanel.jsx";

export default function Dashboard() {
  return (
    <div className="grid h-full grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)] gap-3">
      <section className="flex min-h-0 flex-col gap-3">
        <div className="min-h-0 flex-1 space-y-3 overflow-auto pr-1">
          <SettingsPanel />
          <AccountSelect />
          <TaskQueue />
        </div>
        <RunBar />
      </section>
      <section className="flex min-h-0 flex-col gap-3">
        <VideoPanel />
        <LogPanel />
      </section>
    </div>
  );
}
