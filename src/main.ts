import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import started from "electron-squirrel-startup";
import { loadDataFromFiles } from "./data/dataLoader";
import type { DataLoadResult } from "./types";

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
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
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: "L-Acoustics Amplifier Calculator",
  });

  // Load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }

  // Open DevTools in development
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
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
