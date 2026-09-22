import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER);

process.env.ELECTRON = "1";
process.env.APP_DATA_DIR = app.getPath("userData");

let mainWindow = null;

async function createWindow() {
  const uiUrl = isDev
    ? process.env.VITE_DEV_SERVER
    : (await startServer({
        port: Number(process.env.DOLA_PORT || 5176),
        staticDir: path.join(__dirname, "..", "dist"),
      })).url;

  mainWindow = new BrowserWindow({
    title: "PLENKEX UNLIMITED — Seedance 2.5 Pro",
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#e8eef6",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  await mainWindow.loadURL(uiUrl);
  mainWindow.show();
  mainWindow.focus();
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (!mainWindow) createWindow();
});
