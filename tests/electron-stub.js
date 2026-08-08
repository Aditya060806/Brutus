// Minimal electron surface so main-process modules can be unit-tested in node.
//
// Faithful rather than minimal where it matters: a stub that is missing a method
// the real Electron has turns a passing test into a false negative, and a stub
// that is missing a method the code CALLS turns it into a false positive. The
// `app.on` entry below exists because `registerStudio` wires `before-quit`, and
// without it the whole Studio suite failed to register a single channel.
module.exports = {
  app: {
    getPath: () => require('os').tmpdir(),
    isReady: () => true,
    // `isPackaged` / `getAppPath` are how model-store.ts decides between the
    // bundled resources directory and the repo's own. Tests run unpackaged.
    isPackaged: false,
    getAppPath: () => process.cwd(),
    // Lifecycle hooks. Recorded rather than ignored so a test can fire them.
    _events: new Map(),
    on(event, fn) {
      const list = this._events.get(event) ?? []
      list.push(fn)
      this._events.set(event, list)
      return this
    },
    once(event, fn) {
      return this.on(event, fn)
    },
    off() {
      return this
    },
    emit(event, ...args) {
      for (const fn of this._events.get(event) ?? []) fn(...args)
    },
    whenReady: () => Promise.resolve(),
    quit() {
      /* nothing to quit in a test process */
    }
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s) => Buffer.from(s),
    decryptString: (b) => b.toString()
  },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  // Studio's folder picker. Cancelled by default: a test must never be able to
  // open a real dialog, and "the user pressed cancel" is the safe answer.
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
    showMessageBox: async () => ({ response: 0 })
  },
  shell: { openExternal: async () => {}, openPath: async () => '' },
  BrowserWindow: class {}
}
