import { execSync } from "node:child_process";

const ports = [5176, 5288];

function pidsOnPort(port) {
  try {
    const out = execSync(`netstat -ano | findstr :${port}`, { encoding: "utf8" });
    const ids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const pid = line.trim().split(/\s+/).pop();
      if (pid && pid !== "0") ids.add(pid);
    }
    return [...ids];
  } catch {
    return [];
  }
}

for (const port of ports) {
  for (const pid of pidsOnPort(port)) {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
      console.log(`Freed port ${port} (pid ${pid})`);
    } catch {
      // already gone
    }
  }
}
