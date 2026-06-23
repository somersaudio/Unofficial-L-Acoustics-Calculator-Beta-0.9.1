import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { watch } from "node:fs";
import started from "electron-squirrel-startup";
import { updateElectronApp } from "update-electron-app";
import { loadDataFromFiles } from "./data/dataLoader";
import type { DataLoadResult } from "./types";

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Auto-update: on launch (and periodically), check GitHub Releases via the free
// update.electronjs.org service, download a newer signed build in the background, and
// prompt the user to restart to apply. Only runs in packaged (signed) builds — no-op in dev.
if (app.isPackaged) {
  updateElectronApp();
}

// Store loaded data globally so it can be accessed by IPC handlers
let appData: DataLoadResult | null = null;

function getDataPath(): string {
  // In development, data is in project root /data
  // In production, data is in resources folder
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "data");
  } else {
    return path.join(app.getAppPath(), "data");
  }
}

async function loadAndValidateData(): Promise<DataLoadResult> {
  const dataPath = getDataPath();
  console.log("Loading data from:", dataPath);

  const result = await loadDataFromFiles(dataPath);

  if (!result.success) {
    console.error("Data validation failed:");
    for (const error of result.errors) {
      console.error(`  [${error.type}] ${error.file}: ${error.message}`);
      if (error.path) {
        console.error(`    at: ${error.path}`);
      }
    }
  } else {
    console.log("Data loaded successfully!");
    console.log(
      `  - ${result.data!.amplifiers.amplifiers.length} amplifiers`
    );
    console.log(
      `  - ${result.data!.enclosures.enclosures.length} enclosures`
    );
    console.log(`  - ${result.data!.ampConfigs.length} amp configurations`);
  }

  return result;
}

function showValidationErrorDialog(result: DataLoadResult): void {
  const errorMessages = result.errors
    .map((err) => {
      let msg = `[${err.file}] ${err.message}`;
      if (err.path) {
        msg += `\n  Location: ${err.path}`;
      }
      return msg;
    })
    .join("\n\n");

  dialog.showErrorBox(
    "Data Validation Failed",
    `The application cannot start because the data files contain errors.\n\n${errorMessages}\n\nPlease fix the data files and restart the application.`
  );
}

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1680,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: "Unofficial L-Acoustics Calculator Beta 0.9.10",
  });

  // Load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }

};

// Set up IPC handlers
function setupIpcHandlers(): void {
  ipcMain.handle("get-app-data", (): DataLoadResult => {
    if (!appData) {
      return {
        success: false,
        errors: [
          {
            type: "data",
            file: "N/A",
            message: "Data not loaded yet",
          },
        ],
      };
    }
    return appData;
  });

  // Open an external URL (e.g. a rigging manual PDF) in the user's default browser
  ipcMain.handle("open-external", (_event, url: string) => {
    if (typeof url === "string" && /^https:\/\//i.test(url)) {
      shell.openExternal(url);
    }
  });

  ipcMain.handle("save-project", async (_event, data: string): Promise<{ success: boolean; filePath?: string; error?: string }> => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showSaveDialog(win!, {
      title: "Save Project",
      defaultPath: "project.lacalc",
      filters: [{ name: "L-Acoustics Amp Calc", extensions: ["lacalc"] }],
    });
    if (result.canceled || !result.filePath) {
      return { success: false };
    }
    try {
      await fs.writeFile(result.filePath, data, "utf-8");
      return { success: true, filePath: result.filePath };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle("load-project", async (): Promise<{ success: boolean; data?: string; error?: string }> => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win!, {
      title: "Open Project",
      filters: [{ name: "L-Acoustics Amp Calc", extensions: ["lacalc"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false };
    }
    try {
      const data = await fs.readFile(result.filePaths[0], "utf-8");
      return { success: true, data };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });
}

// Dev only: live-reload data edits. Renderer code hot-reloads via Vite HMR and main.ts edits
// auto-restart the main process, but data/*.json is read once at startup — so watch it and, on
// change, re-read the data and reload open windows so the dev app always reflects the latest
// data without a manual restart. Guarded by isPackaged so it never runs in a shipped build.
function watchDataInDev(): void {
  if (app.isPackaged) return;
  const dataPath = getDataPath();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    watch(dataPath, (_event, filename) => {
      if (filename && !filename.endsWith(".json")) return; // ignore manuals/, images, etc.
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        console.log(`[dev] data change (${filename ?? "?"}) — reloading data + windows`);
        appData = await loadAndValidateData();
        for (const win of BrowserWindow.getAllWindows()) win.webContents.reload();
      }, 250); // debounce: editors fire several events per save
    });
    console.log("[dev] watching data/ for live reload");
  } catch (err) {
    console.error("[dev] could not watch data dir:", err);
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
app.on("ready", async () => {
  // Load and validate data first
  appData = await loadAndValidateData();

  // If validation failed, show error dialog and quit (strict mode)
  if (!appData.success) {
    showValidationErrorDialog(appData);
    app.quit();
    return;
  }

  // Set up IPC handlers
  setupIpcHandlers();

  // Create the main window
  createWindow();

  // Dev only: live-reload on data/*.json edits (no-op in packaged builds)
  watchDataInDev();

  // Build native application menu
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Project...",
          accelerator: "CmdOrCtrl+O",
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.send("menu-open-project");
          },
        },
        {
          label: "Save Project...",
          accelerator: "CmdOrCtrl+S",
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.send("menu-save-project");
          },
        },
        { type: "separator" },
        isMac ? { role: "close" as const } : { role: "quit" as const },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
});

// Quit when all windows are closed, except on macOS.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  // On macOS, re-create window when dock icon is clicked and no windows exist.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
