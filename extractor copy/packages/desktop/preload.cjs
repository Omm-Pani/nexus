// CommonJS on purpose: Electron only loads an ESM preload under narrow
// conditions, and a preload is the one place where a build step failing open
// would silently leave the renderer with no bridge at all.
const { contextBridge, ipcRenderer } = require('electron');

/**
 * The renderer's only channel to the shell. Context isolation stays on and no
 * Node API reaches the page: the renderer gets a fixed set of named
 * operations rather than a bus it could use to reach arbitrary main APIs.
 */
contextBridge.exposeInMainWorld('nexus', {
  invoke: (channel, payload) => ipcRenderer.invoke('nexus', { channel, payload }),
  subscribe: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('nexus:event', listener);
    return () => ipcRenderer.off('nexus:event', listener);
  },
  setViewBounds: (bounds) => ipcRenderer.send('nexus:view-bounds', bounds),
});
