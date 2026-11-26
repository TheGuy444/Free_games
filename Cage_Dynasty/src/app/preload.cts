// Exposes one generic command call to the renderer. No Node access leaks through.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("gameApi", {
  call: (name: string, ...args: unknown[]) => ipcRenderer.invoke("api", name, args),
});
