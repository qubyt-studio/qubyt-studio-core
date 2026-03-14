const electron = require("electron");
const { contextBridge, ipcRenderer } = electron;
const webUtils = electron.webUtils || null;

/** Electron 32+ sandbox: File.path yok; webUtils.getPathForFile kullan. Eski sürümde file.path fallback. */
function getPathsFromDroppedFiles(fileList) {
  const paths = [];
  if (!fileList || !fileList.length) return paths;
  for (let i = 0; i < fileList.length; i++) {
    const f = fileList[i];
    try {
      const p = webUtils ? webUtils.getPathForFile(f) : (f && f.path) || "";
      if (p && typeof p === "string") paths.push(p);
    } catch (_) {}
  }
  return paths;
}

contextBridge.exposeInMainWorld("editorAPI", {
  openFolder: () => ipcRenderer.invoke("open-folder"),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  createProjectFolder: (parentDir, folderName) =>
    ipcRenderer.invoke("create-project-folder", parentDir, folderName),
  openFolderAtPath: (dirPath) =>
    ipcRenderer.invoke("open-folder-at-path", dirPath),
  getPathsFromDroppedFiles: (fileList) => getPathsFromDroppedFiles(fileList),
  openFolderFromDroppedPaths: (paths) =>
    ipcRenderer.invoke("open-folder-from-dropped-paths", paths),
  writeTemplate: (folderPath, templateId) =>
    ipcRenderer.invoke("write-template", folderPath, templateId),
  getProjectRoot: () => ipcRenderer.invoke("get-project-root"),
  findLogs: () => ipcRenderer.invoke("find-logs"),
  closeFolder: () => ipcRenderer.invoke("close-folder"),
  openFile: () => ipcRenderer.invoke("open-file"),
  getTree: () => ipcRenderer.invoke("get-tree"),
  readFile: (filePath) => ipcRenderer.invoke("read-file", filePath),
  readDirectory: (dirPath) => ipcRenderer.invoke("read-directory", dirPath),
  saveFile: (filePath, content) =>
    ipcRenderer.invoke("save-file", filePath, content),
  lintFile: (filePath, content) =>
    ipcRenderer.invoke("lint-file", filePath, content),
  createFile: (parentDir, name) =>
    ipcRenderer.invoke("create-file", parentDir, name),
  createFolder: (parentDir, name) =>
    ipcRenderer.invoke("create-folder", parentDir, name),
  deletePath: (targetPath) => ipcRenderer.invoke("delete-path", targetPath),
  renamePath: (oldPath, newName) =>
    ipcRenderer.invoke("rename-path", oldPath, newName),
  movePath: (sourcePath, destDirPath) =>
    ipcRenderer.invoke("move-path", sourcePath, destDirPath),
  runPreview: (htmlPath) => ipcRenderer.invoke("run-preview", htmlPath),
  runScript: (filePath) => ipcRenderer.invoke("run-script", filePath),
  runTerminalCommand: (command) =>
    ipcRenderer.invoke("run-terminal-command", command),
  expandEmmetAtPosition: (source, offset, type) =>
    ipcRenderer.invoke("emmet-expand-at-position", source, offset, type),
  toggleDevTools: () => ipcRenderer.send("toggle-devtools"),
  newWindow: () => ipcRenderer.send("new-window"),
  openFolderInNewWindow: () => ipcRenderer.invoke("open-folder-in-new-window"),
  openFolderInNewWindowAtPath: (dirPath) =>
    ipcRenderer.invoke("open-folder-in-new-window-at-path", dirPath),
  onOpenFolderOnLoad: (fn) => {
    ipcRenderer.on("open-folder-on-load", (_e, path) => fn(path));
  },
  rendererReady: () => ipcRenderer.send("renderer-ready"),
  quit: () => ipcRenderer.send("app-quit"),
  windowMinimize: () => ipcRenderer.send("window-minimize"),
  windowMaximize: () => ipcRenderer.send("window-maximize"),
  windowClose: () => ipcRenderer.invoke("close-current-window"),
  windowToggleFullscreen: () => ipcRenderer.send("window-toggle-fullscreen"),
  themeSave: (name, colors) => ipcRenderer.invoke("theme-save", name, colors),
  themeList: () => ipcRenderer.invoke("theme-list"),
  themeLoad: (id) => ipcRenderer.invoke("theme-load", id),
  themeDelete: (id) => ipcRenderer.invoke("theme-delete", id),
  themeRename: (id, newName) => ipcRenderer.invoke("theme-rename", id, newName),
  onSplashHide: (fn) => ipcRenderer.on("splash-hide", () => fn()),
  markdownParse: (md) => ipcRenderer.invoke("markdown-parse", md),
});
