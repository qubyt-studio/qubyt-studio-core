const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  screen,
} = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");
const esbuild = require("esbuild");

const SERVER_PORT = 9292;
const ROOT = __dirname;
const SKIP_DIRS = new Set(["node_modules", ".git", ".vscode", "__pycache__"]);
const MAX_TREE_DEPTH = 8;

/** Windows uzun yol önekini kaldırır; EPERM vb. hataları azaltır */
function normalizePath(p) {
  if (typeof p !== "string") return p;
  const s = p.trim();
  if (
    process.platform === "win32" &&
    (s.startsWith("\\\\?\\") || s.startsWith("//?/"))
  )
    return s.slice(4).replace(/\//g, path.sep);
  return s.replace(/\//g, path.sep);
}

function readDirTree(dirPath, depth) {
  if (depth <= 0) return null;
  const entries = [];
  try {
    const names = fs.readdirSync(dirPath);
    const dirs = [];
    const files = [];
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = path.join(dirPath, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch (_) {
        continue;
      }
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        dirs.push({ name, full });
      } else {
        files.push({ name, full });
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirs) {
      const children = readDirTree(d.full, depth - 1);
      entries.push({ name: d.name, path: d.full, children: children || [] });
    }
    for (const f of files) {
      entries.push({ name: f.name, path: f.full });
    }
  } catch (_) {
    return [];
  }
  return entries;
}

let projectRoot = null;

function tryListen(server, port, cb) {
  server
    .listen(port, "127.0.0.1", () => cb(null, port))
    .on("error", (err) => {
      if (err.code === "EADDRINUSE" && port < 9300)
        tryListen(server, port + 1, cb);
      else cb(err, null);
    });
}

// Güvenli statik dosya sunumu: ROOT (editör) veya projectRoot (/preview/ altı)
function createStaticServer() {
  const mime = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".ico": "image/x-icon",
    ".ttf": "font/ttf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
  };
  return http.createServer((req, res) => {
    let urlPath = req.url?.split("?")[0] || "/";
    try {
      urlPath = decodeURIComponent(urlPath);
    } catch (_) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request");
      return;
    }
    if (urlPath.includes("..")) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request");
      return;
    }

    // Önizleme: /preview/ ile başlayan istekler proje kökünden (projectRoot)
    const previewPrefix = "/preview/";
    if (urlPath.startsWith(previewPrefix) && projectRoot) {
      const relative = urlPath
        .slice(previewPrefix.length)
        .replace(/^\/+/, "")
        .replace(/\\/g, "/");
      const filePath = path.join(projectRoot, relative || "index.html");
      const resolved = path.resolve(filePath);
      const relToRoot = path.relative(projectRoot, resolved);
      if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      if (ext === ".ts" || ext === ".tsx") {
        fs.readFile(filePath, "utf8", (err, tsCode) => {
          if (err) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not Found");
            return;
          }
          try {
            const result = esbuild.transformSync(tsCode, {
              loader: ext === ".tsx" ? "tsx" : "ts",
              target: "es2020",
            });
            res.writeHead(200, {
              "Content-Type": "application/javascript",
            });
            res.end(result.code);
          } catch (compileErr) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end(
              "TypeScript derleme hatası: " +
                (compileErr.message || String(compileErr)),
            );
          }
        });
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
          return;
        }
        const type = mime[ext] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": type });
        res.end(data);
      });
      return;
    }

    // Editör arayüzü: ROOT altından
    const stripped = urlPath.replace(/^\/+/, "").replace(/^\\+/, "");
    const filePath = path.join(ROOT, stripped || "src/renderer/index.html");
    const resolved = path.resolve(filePath);
    const rootResolved = path.resolve(ROOT);
    const relative = path.relative(rootResolved, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }
      const ext = path.extname(filePath);
      const type = mime[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": type });
      res.end(data);
    });
  });
}

let server = null;
let activePort = SERVER_PORT;

function createWindow(port, folderToOpen) {
  const iconPath = path.join(ROOT, "build", "icon.png");
  const primary = screen.getPrimaryDisplay();
  const { x, y, width, height } = primary.workArea;
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: "#0c0e12",
    show: false,
    frame: false,
    titleBarStyle: "hidden",
    icon: iconPath,
    webPreferences: {
      preload: path.join(ROOT, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: true,
    },
  });

  win.loadURL(`http://127.0.0.1:${port}/src/renderer/index.html`);
  if (folderToOpen) win.pendingFolderToOpen = folderToOpen;
  win.once("ready-to-show", () => win.show());

  // Splash: zamanlayıcı main process'te — odakta olmasa bile çalışır (renderer setTimeout throttle edilir)
  const SPLASH_MIN_MS = 2600;
  win.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.send("splash-hide");
    }, SPLASH_MIN_MS);
  });

  // Harici linkler (target="_blank") sistem tarayıcısında açılsın
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Aynı pencerede harici URL'ye gitmeyi engelle — editörde kal, linki sistem tarayıcısında aç
  const localHost = `http://127.0.0.1:${port}`;
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      if (!url.startsWith(localHost)) {
        e.preventDefault();
        shell.openExternal(url);
      }
    }
  });
}

ipcMain.on("toggle-devtools", () => {
  const w = require("electron").BrowserWindow.getFocusedWindow();
  if (w) w.webContents.toggleDevTools();
});
ipcMain.on("app-quit", () => app.quit());
ipcMain.on("window-minimize", () => {
  const w = require("electron").BrowserWindow.getFocusedWindow();
  if (w) w.minimize();
});
ipcMain.on("window-maximize", () => {
  const w = require("electron").BrowserWindow.getFocusedWindow();
  if (w) w.isMaximized() ? w.unmaximize() : w.maximize();
});
ipcMain.handle("close-current-window", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed()) {
    setImmediate(() => w.destroy());
  }
  return null;
});
ipcMain.on("window-toggle-fullscreen", () => {
  const w = require("electron").BrowserWindow.getFocusedWindow();
  if (w) w.setFullScreen(!w.isFullScreen());
});

function runApp(port) {
  createWindow(port);
}

app.whenReady().then(() => {
  ipcMain.handle("open-folder", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths.length) return null;
    projectRoot = path.resolve(normalizePath(result.filePaths[0]));
    const tree = readDirTree(projectRoot, MAX_TREE_DEPTH);
    return { rootPath: projectRoot, tree };
  });
  ipcMain.handle("pick-folder", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return { path: path.resolve(normalizePath(result.filePaths[0])) };
  });
  ipcMain.handle("create-project-folder", async (e, parentDir, folderName) => {
    const parent = path.resolve(normalizePath(parentDir));
    const name = (folderName || "").trim().replace(/[/\\:*?"<>|]/g, "");
    if (!name) return { error: "Geçerli bir klasör adı girin." };
    const full = path.join(parent, name);
    try {
      if (!fs.existsSync(parent)) return { error: "Seçilen konum bulunamadı." };
      if (!fs.statSync(parent).isDirectory())
        return { error: "Seçilen konum bir klasör değil." };
      if (fs.existsSync(full))
        return { error: "Bu konumda aynı isimde bir öğe zaten var." };
      fs.mkdirSync(full, { recursive: false });
      return { ok: true, path: full };
    } catch (err) {
      const msg = err.code === "EPERM" ? "İzin reddedildi." : err.message;
      return { error: msg };
    }
  });
  ipcMain.handle("open-folder-at-path", async (e, dirPath) => {
    const resolved = path.resolve(normalizePath(dirPath));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory())
      return { error: "Klasör bulunamadı." };
    projectRoot = resolved;
    const tree = readDirTree(projectRoot, MAX_TREE_DEPTH);
    return { rootPath: projectRoot, tree };
  });

  const TEMPLATES = {
    "html5-empty": [
      {
        name: "index.html",
        content: `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Yeni Sayfa</title>
</head>
<body>
  <h1>Merhaba</h1>
</body>
</html>
`,
      },
    ],
    "html5-css-js": [
      {
        name: "index.html",
        content: `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Yeni Proje</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <h1>Merhaba</h1>
  <script src="script.js"></script>
</body>
</html>
`,
      },
      {
        name: "style.css",
        content: `/* stiller */\nbody { margin: 0; font-family: system-ui, sans-serif; }\n`,
      },
      {
        name: "script.js",
        content: `// JavaScript\nconsole.log("Proje yüklendi.");\n`,
      },
    ],
    "single-page": [
      {
        name: "index.html",
        content: `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Tek Sayfa</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <div id="app">
    <header>Başlık</header>
    <main>İçerik buraya.</main>
    <footer>Alt bilgi</footer>
  </div>
  <script src="script.js"></script>
</body>
</html>
`,
      },
      {
        name: "style.css",
        content: `* { box-sizing: border-box; }\nbody { margin: 0; font-family: system-ui, sans-serif; }\n#app { min-height: 100vh; display: flex; flex-direction: column; }\n`,
      },
      {
        name: "script.js",
        content: `// Tek sayfa uygulaması\nconst app = document.getElementById("app");\n`,
      },
    ],
  };
  ipcMain.handle("write-template", async (e, folderPath, templateId) => {
    const dir = path.resolve(normalizePath(folderPath));
    const files = TEMPLATES[templateId];
    if (!files || !Array.isArray(files)) return { error: "Bilinmeyen şablon." };
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
        return { error: "Hedef klasör bulunamadı." };
      const written = [];
      for (const f of files) {
        const full = path.join(dir, f.name);
        if (fs.existsSync(full))
          return { error: `${f.name} zaten mevcut. Farklı bir klasör seçin.` };
        fs.writeFileSync(full, f.content, "utf-8");
        written.push(full);
      }
      return { ok: true, path: dir, files: written };
    } catch (err) {
      return { error: err.message || "Yazma hatası." };
    }
  });

  ipcMain.handle("get-project-root", async () => projectRoot);
  ipcMain.handle("close-folder", async () => {
    projectRoot = null;
    return { ok: true };
  });

  /* Tema kaydetme / yükleme — userData/themes/ */
  const themesDir = path.join(app.getPath("userData"), "themes");
  ipcMain.handle("theme-save", async (e, themeName, colors) => {
    try {
      if (!fs.existsSync(themesDir)) fs.mkdirSync(themesDir, { recursive: true });
      const slug = (themeName || "tema")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u00c0-\u024f\u0400-\u04ff\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 64) || "tema";
      const filePath = path.join(themesDir, slug + ".json");
      const data = JSON.stringify({ name: themeName || "Tema", colors: colors || {} }, null, 2);
      fs.writeFileSync(filePath, data, "utf-8");
      return { ok: true, id: slug, path: filePath };
    } catch (err) {
      return { error: err.message };
    }
  });
  ipcMain.handle("theme-list", async () => {
    try {
      if (!fs.existsSync(themesDir)) return { themes: [] };
      const files = fs.readdirSync(themesDir);
      const themes = [];
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const fp = path.join(themesDir, f);
        try {
          const raw = fs.readFileSync(fp, "utf-8");
          const obj = JSON.parse(raw);
          themes.push({ id: f.replace(/\.json$/, ""), name: obj.name || f });
        } catch (_) {}
      }
      return { themes };
    } catch (err) {
      return { themes: [], error: err.message };
    }
  });
  ipcMain.handle("theme-load", async (e, themeId) => {
    try {
      const filePath = path.join(themesDir, themeId + ".json");
      if (!fs.existsSync(filePath)) return { error: "Tema bulunamadı." };
      const raw = fs.readFileSync(filePath, "utf-8");
      const obj = JSON.parse(raw);
      return { name: obj.name, colors: obj.colors || {} };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle("open-file", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const filePath = path.resolve(normalizePath(result.filePaths[0]));
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return { path: filePath, content };
    } catch (err) {
      return { error: err.message };
    }
  });
  ipcMain.handle("get-tree", async () => {
    if (!projectRoot) return null;
    const tree = readDirTree(projectRoot, MAX_TREE_DEPTH);
    return { tree };
  });
  ipcMain.handle("create-file", async (e, parentDir, name) => {
    const parent = path.resolve(normalizePath(parentDir));
    if (!projectRoot || !parent.startsWith(projectRoot))
      return { error: "forbidden" };
    if (!name || name.includes("..") || path.isAbsolute(name))
      return { error: "invalid name" };
    const full = path.join(parent, name);
    const rel = path.relative(projectRoot, full);
    if (rel.startsWith("..")) return { error: "forbidden" };
    try {
      if (fs.existsSync(full)) {
        const stat = fs.statSync(full);
        return {
          error: stat.isDirectory()
            ? "Bu adda bir klasör zaten var."
            : "Bu adda bir dosya zaten var.",
        };
      }
      fs.writeFileSync(full, "", "utf-8");
      return { ok: true, path: full };
    } catch (err) {
      const msg =
        err.code === "EPERM"
          ? "İzin reddedildi. Klasörü başka bir program kullanıyor olabilir."
          : err.message;
      return { error: msg };
    }
  });
  ipcMain.handle("create-folder", async (e, parentDir, name) => {
    const parent = path.resolve(normalizePath(parentDir));
    if (!projectRoot || !parent.startsWith(projectRoot))
      return { error: "forbidden" };
    if (!name || name.includes("..") || path.isAbsolute(name))
      return { error: "invalid name" };
    const full = path.join(parent, name);
    const rel = path.relative(projectRoot, full);
    if (rel.startsWith("..")) return { error: "forbidden" };
    try {
      if (fs.existsSync(full)) {
        const stat = fs.statSync(full);
        return {
          error: stat.isDirectory()
            ? "Bu adda bir klasör zaten var."
            : "Bu adda bir dosya var; klasör aynı isimde olamaz.",
        };
      }
      fs.mkdirSync(full, { recursive: false });
      return { ok: true, path: full };
    } catch (err) {
      const msg =
        err.code === "EPERM"
          ? "İzin reddedildi. Klasörü başka bir program kullanıyor olabilir veya aynı isimde dosya/klasör var."
          : err.code === "EEXIST"
            ? "Bu adda bir öğe zaten var."
            : err.message;
      return { error: msg };
    }
  });
  ipcMain.handle("delete-path", async (e, targetPath) => {
    const target = path.resolve(normalizePath(targetPath));
    if (!projectRoot || !target.startsWith(projectRoot))
      return { error: "forbidden" };
    const rel = path.relative(projectRoot, target);
    if (rel.startsWith("..")) return { error: "forbidden" };
    if (target === projectRoot) return { error: "cannot delete root" };
    try {
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        fs.rmSync(target, { recursive: true });
      } else {
        fs.unlinkSync(target);
      }
      return { ok: true };
    } catch (err) {
      const msg =
        err.code === "EPERM"
          ? "İzin reddedildi. Dosya/klasör başka bir program tarafından kullanılıyor olabilir."
          : err.message;
      return { error: msg };
    }
  });
  ipcMain.handle("rename-path", async (e, oldPath, newName) => {
    const oldResolved = path.resolve(normalizePath(oldPath));
    if (!projectRoot || !oldResolved.startsWith(projectRoot))
      return { error: "forbidden" };
    if (!newName || newName.includes("..") || path.isAbsolute(newName))
      return { error: "invalid name" };
    const parent = path.dirname(oldResolved);
    const newPath = path.join(parent, newName);
    const rel = path.relative(projectRoot, newPath);
    if (rel.startsWith("..")) return { error: "forbidden" };
    if (oldResolved === projectRoot) return { error: "cannot rename root" };
    try {
      fs.renameSync(oldResolved, newPath);
      return { ok: true, path: newPath };
    } catch (err) {
      const msg =
        err.code === "EPERM"
          ? "İzin reddedildi. Dosya/klasör kullanımda olabilir."
          : err.code === "ENOENT"
            ? "Dosya veya klasör bulunamadı."
            : err.message;
      return { error: msg };
    }
  });
  ipcMain.handle("move-path", async (e, sourcePath, destDirPath) => {
    const src = path.resolve(normalizePath(sourcePath));
    const destDir = path.resolve(normalizePath(destDirPath));
    if (!projectRoot || !src.startsWith(projectRoot))
      return { error: "forbidden" };
    if (!projectRoot || !destDir.startsWith(projectRoot))
      return { error: "forbidden" };
    const relDest = path.relative(projectRoot, destDir);
    if (relDest.startsWith("..") || path.isAbsolute(relDest))
      return { error: "forbidden" };
    if (!fs.existsSync(src)) return { error: "source not found" };
    if (!fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory())
      return { error: "destination is not a directory" };
    const name = path.basename(src);
    const newPath = path.join(destDir, name);
    if (newPath === src) return { ok: true, path: newPath };
    if (fs.statSync(src).isDirectory()) {
      if (destDir === src || destDir.startsWith(src + path.sep))
        return { error: "cannot move folder into itself or descendant" };
    }
    try {
      fs.renameSync(src, newPath);
      return { ok: true, path: newPath };
    } catch (err) {
      const msg =
        err.code === "EPERM"
          ? "İzin reddedildi. Taşıma başarısız; dosya/klasör kullanımda olabilir."
          : err.message;
      return { error: msg };
    }
  });
  ipcMain.handle("read-directory", async (e, dirPath) => {
    const resolved = path.resolve(normalizePath(dirPath));
    if (!projectRoot || !resolved.startsWith(projectRoot))
      return { error: "forbidden" };
    try {
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory())
        return { error: "Klasör bulunamadı." };
      const names = fs.readdirSync(resolved);
      const entries = [];
      for (const name of names) {
        if (name.startsWith(".")) continue;
        const full = path.join(resolved, name);
        try {
          const stat = fs.statSync(full);
          entries.push({
            name,
            path: full,
            isDir: stat.isDirectory(),
          });
        } catch (_) {
          continue;
        }
      }
      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return { entries };
    } catch (err) {
      return { error: err.message };
    }
  });
  ipcMain.handle("read-file", async (e, filePath) => {
    const resolved = path.resolve(normalizePath(filePath));
    if (!projectRoot || !resolved.startsWith(projectRoot))
      return { error: "forbidden" };
    try {
      const content = fs.readFileSync(resolved, "utf-8");
      return { content };
    } catch (err) {
      return { error: err.message };
    }
  });
  ipcMain.handle(
    "emmet-expand-at-position",
    async (e, source, offset, type) => {
      try {
        const emmet = require("emmet");
        const opts = type === "stylesheet" ? { type: "stylesheet" } : {};
        const data = emmet.extract(source, offset, opts);
        if (!data || !data.abbreviation) return null;
        const expand = emmet.default || emmet;
        const expanded = expand(data.abbreviation, opts);
        return {
          abbreviation: data.abbreviation,
          start: data.start,
          end: data.end,
          expanded,
        };
      } catch (err) {
        return null;
      }
    },
  );
  ipcMain.handle("lint-file", async (e, filePath, content) => {
    if (typeof content !== "string" || !filePath) return { markers: [] };
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== ".js" && ext !== ".mjs" && ext !== ".cjs")
      return { markers: [] };
    try {
      const { ESLint } = require("eslint");
      const eslint = new ESLint({
        useEslintrc: false,
        overrideConfig: {
          env: { browser: true, es2022: true, node: true },
          parserOptions: { ecmaVersion: 2022, sourceType: "script" },
          rules: { "no-undef": "error", "no-unused-vars": "warn" },
        },
      });
      const results = await eslint.lintText(content, { filePath });
      const markers = [];
      for (const r of results) {
        for (const m of r.messages) {
          if (m.line && m.column) {
            markers.push({
              startLineNumber: m.line,
              startColumn: m.column,
              endLineNumber: m.endLine || m.line,
              endColumn: m.endColumn || m.column + 1,
              message: m.message + (m.ruleId ? " (" + m.ruleId + ")" : ""),
              severity: m.severity === 2 ? 8 : 4,
            });
          }
        }
      }
      return { markers };
    } catch (err) {
      return { markers: [], error: err.message };
    }
  });
  ipcMain.handle("save-file", async (e, filePath, content) => {
    const resolved = path.resolve(normalizePath(filePath));
    if (!projectRoot || !resolved.startsWith(projectRoot))
      return { error: "forbidden" };
    const rel = path.relative(projectRoot, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel))
      return { error: "forbidden" };
    try {
      fs.writeFileSync(resolved, content, "utf-8");
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  });
  ipcMain.handle("run-preview", async (e, htmlPath) => {
    if (!projectRoot) return { error: "no-project" };
    let relativePath = "index.html";
    if (htmlPath) {
      const resolved = path.resolve(normalizePath(htmlPath));
      const ext = path.extname(resolved).toLowerCase();
      if (
        (ext === ".html" || ext === ".htm") &&
        resolved.startsWith(projectRoot) &&
        fs.existsSync(resolved)
      ) {
        relativePath = path.relative(projectRoot, resolved).replace(/\\/g, "/");
      }
    }
    const fullPath = path.join(projectRoot, relativePath);
    if (!fs.existsSync(fullPath)) return { error: "no-index" };
    const url = `http://127.0.0.1:${activePort}/preview/${relativePath}`;
    try {
      await shell.openExternal(url);
      return { ok: true, url };
    } catch (err) {
      return { error: err.message || "open failed" };
    }
  });
  ipcMain.handle("run-script", async (e, filePath) => {
    if (!projectRoot || !filePath) return { error: "no-project" };
    const resolved = path.resolve(normalizePath(filePath));
    if (!resolved.startsWith(projectRoot)) return { error: "forbidden" };
    const ext = path.extname(resolved).toLowerCase();
    if (ext !== ".js" && ext !== ".mjs") return { error: "not-js" };
    if (!fs.existsSync(resolved)) return { error: "not-found" };
    return new Promise((resolve) => {
      const arg =
        resolved.indexOf(" ") >= 0 || resolved.indexOf('"') >= 0
          ? '"' + resolved.replace(/"/g, '\\"') + '"'
          : resolved;
      const child = spawn("node", [arg], {
        cwd: projectRoot,
        shell: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("close", (code) => {
        resolve({ ok: code === 0, stdout, stderr, code: code ?? null });
      });
      child.on("error", (err) => {
        resolve({ ok: false, error: err.message, stdout: "", stderr: "" });
      });
    });
  });

  /** Terminal komutu: sadece npm, node, npx (izin listesi). Proje kökünde çalışır. */
  ipcMain.handle("run-terminal-command", async (e, commandString) => {
    if (!projectRoot) return { error: "no-project" };
    const raw = typeof commandString === "string" ? commandString.trim() : "";
    if (!raw) return { error: "empty" };
    if (/[;&|`]|\$\(/.test(raw))
      return { error: "not-allowed", message: "Komut enjeksiyonu engellendi." };

    const firstWord = raw.split(/\s+/)[0].toLowerCase();

    if (firstWord === "npm" || firstWord === "npx") {
      // npm install, npm run dev, npx create-react-app vb.
    } else if (firstWord === "node") {
      const parts = raw.slice(5).trim().split(/\s+/);
      const scriptPath = parts[0];
      if (!scriptPath) return { error: "node-dosya-gerekli" };
      const resolved = path.resolve(projectRoot, normalizePath(scriptPath));
      if (!resolved.startsWith(projectRoot)) return { error: "forbidden" };
      const ext = path.extname(resolved).toLowerCase();
      if (ext !== ".js" && ext !== ".mjs") return { error: "node-sadece-js" };
      if (!fs.existsSync(resolved)) return { error: "not-found" };
    } else {
      return {
        error: "not-allowed",
        message: "İzin verilen komutlar: npm ... , node <dosya.js> , npx ...",
      };
    }

    return new Promise((resolve) => {
      const child = spawn(raw, [], {
        cwd: projectRoot,
        shell: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("close", (code) => {
        resolve({ ok: code === 0, stdout, stderr, code: code ?? null });
      });
      child.on("error", (err) => {
        resolve({ ok: false, error: err.message, stdout: "", stderr: "" });
      });
    });
  });
  const vsPath = path.join(ROOT, "src", "renderer", "vs", "loader.js");
  if (!fs.existsSync(vsPath)) {
    console.error(
      "Monaco vs bulunamadı. Lütfen: npm install (postinstall ile src/renderer/vs kopyalanır)",
    );
  }
  server = createStaticServer();
  tryListen(server, SERVER_PORT, (err, port) => {
    if (err || !port) {
      console.error("Server başlatılamadı:", err || "port yok");
      return;
    }
    activePort = port;
    ipcMain.on("new-window", () => {
      createWindow(activePort);
    });
    ipcMain.on("renderer-ready", (e) => {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (w && w.pendingFolderToOpen) {
        w.webContents.send("open-folder-on-load", w.pendingFolderToOpen);
        w.pendingFolderToOpen = null;
      }
    });
    ipcMain.handle("open-folder-in-new-window", async () => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
      });
      if (result.canceled || !result.filePaths.length) return { ok: false };
      const folderPath = path.resolve(normalizePath(result.filePaths[0]));
      createWindow(activePort, folderPath);
      return { ok: true };
    });
    runApp(port);
  });
});

app.on("window-all-closed", () => {
  if (server) server.close();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    if (server) createWindow(activePort);
    else app.whenReady().then(() => createWindow(activePort));
  }
});
