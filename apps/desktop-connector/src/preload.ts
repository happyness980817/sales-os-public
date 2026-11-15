import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('salesosConnect', Object.freeze({
  state: () => ipcRenderer.invoke('connector:get-state'),
  enroll: (value: { serverUrl: string; name: string; code: string }) => ipcRenderer.invoke('connector:enroll', value),
  addRoot: () => ipcRenderer.invoke('connector:add-root'),
  removeRoot: (id: string) => ipcRenderer.invoke('connector:remove-root', id),
  pause: (value: boolean) => ipcRenderer.invoke('connector:pause', value),
  loginStart: (value: boolean) => ipcRenderer.invoke('connector:login-start', value),
  disconnect: () => ipcRenderer.invoke('connector:disconnect'),
  retry: () => ipcRenderer.invoke('connector:retry'),
  quit: () => ipcRenderer.invoke('connector:quit'),
  subscribe: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on('connector:state', listener);
    return () => ipcRenderer.removeListener('connector:state', listener);
  },
}));
