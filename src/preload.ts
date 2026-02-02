import { contextBridge, ipcRenderer } from "electron";
import type { DataLoadResult } from "./types";

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld("electronAPI", {
  // Get the loaded data from main process
  getAppData: (): Promise<DataLoadResult> =>
    ipcRenderer.invoke("get-app-data"),

  // Save project file
  saveProject: (data: string): Promise<{ success: boolean; filePath?: string; error?: string }> =>
    ipcRenderer.invoke("save-project", data),

  // Load project file
  loadProject: (): Promise<{ success: boolean; data?: string; error?: string }> =>
    ipcRenderer.invoke("load-project"),
});

// Type declaration for the exposed API
declare global {
  interface Window {
    electronAPI: {
      getAppData: () => Promise<DataLoadResult>;
      saveProject: (data: string) => Promise<{ success: boolean; filePath?: string; error?: string }>;
      loadProject: () => Promise<{ success: boolean; data?: string; error?: string }>;
    };
  }
}
