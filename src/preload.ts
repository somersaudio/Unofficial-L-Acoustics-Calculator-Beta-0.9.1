import { contextBridge, ipcRenderer } from "electron";
import type { DataLoadResult } from "./types";

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld("electronAPI", {
  // Get the loaded data from main process
  getAppData: (): Promise<DataLoadResult> =>
    ipcRenderer.invoke("get-app-data"),
});

// Type declaration for the exposed API
declare global {
  interface Window {
    electronAPI: {
      getAppData: () => Promise<DataLoadResult>;
    };
  }
}
