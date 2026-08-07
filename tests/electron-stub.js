// Minimal electron surface so main-process modules can be unit-tested in node.
module.exports = {
  app: {
    getPath: () => require('os').tmpdir(),
    isReady: () => true,
    // `isPackaged` / `getAppPath` are how model-store.ts decides between the
    // bundled resources directory and the repo's own. Tests run unpackaged.
    isPackaged: false,
    getAppPath: () => process.cwd()
  },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  BrowserWindow: class {}
}
