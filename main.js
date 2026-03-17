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
    ".mjs": "application/javascript",
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

function getFolderFromArgv() {
  for (let i = 1; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (typeof arg !== "string" || arg.startsWith("-")) continue;
    try {
      const resolved = path.resolve(normalizePath(arg));
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory())
        return resolved;
      if (resolved.length > 2 && /[\\/]/.test(resolved)) return resolved;
    } catch (_) {}
  }
  return null;
}

function runApp(port, folderFromArgv) {
  createWindow(port, folderFromArgv || undefined);
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

  /** Dışarıdan sürüklenen dosya/klasör yollarından proje kökünü bulup aç (VS Code tarzı) */
  ipcMain.handle("open-folder-from-dropped-paths", async (e, paths) => {
    if (!paths || !Array.isArray(paths) || paths.length === 0)
      return { error: "Yol yok." };
    const normalized = paths
      .filter((p) => typeof p === "string" && p.trim())
      .map((p) => path.resolve(normalizePath(p)));
    if (normalized.length === 0) return { error: "Geçerli yol yok." };
    let rootDir;
    if (normalized.length === 1) {
      const p = normalized[0];
      try {
        rootDir =
          fs.existsSync(p) && fs.statSync(p).isDirectory()
            ? p
            : path.dirname(p);
      } catch (_) {
        rootDir = path.dirname(p);
      }
    } else {
      let common = path.dirname(normalized[0]);
      for (let i = 1; i < normalized.length; i++) {
        let dir = path.dirname(normalized[i]);
        while (dir !== common && !dir.startsWith(common + path.sep)) {
          const parent = path.dirname(common);
          if (parent === common) break;
          common = parent;
        }
      }
      rootDir = common;
    }
    const resolved = path.resolve(rootDir);
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
  ipcMain.handle("open-external-url", async (e, url) => {
    if (typeof url !== "string" || !url.startsWith("https://")) return;
    try {
      await shell.openExternal(url);
    } catch (_) {}
  });
  ipcMain.handle("preview-debug", async () => {
    if (!projectRoot) return { projectRoot: null, error: "no-project" };
    const base = path.resolve(projectRoot);
    const testPaths = ["style.css", "components.css", "index.html"];
    const results = {};
    for (const p of testPaths) {
      const full = path.join(base, p);
      const inSample = path.join(base, "sample-multi-css", p);
      results[p] = {
        root: fs.existsSync(full),
        "sample-multi-css/": fs.existsSync(inSample),
      };
    }
    return { projectRoot: base, files: results };
  });
  ipcMain.handle("close-folder", async () => {
    projectRoot = null;
    return { ok: true };
  });

  /* Tema kaydetme / yükleme — userData/themes/ */
  const themesDir = path.join(app.getPath("userData"), "themes");
  ipcMain.handle("theme-save", async (e, themeName, colors) => {
    try {
      if (!fs.existsSync(themesDir))
        fs.mkdirSync(themesDir, { recursive: true });
      const slug =
        (themeName || "tema")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9\u00c0-\u024f\u0400-\u04ff\s-]/g, "")
          .replace(/\s+/g, "-")
          .replace(/-+/g, "-")
          .slice(0, 64) || "tema";
      const filePath = path.join(themesDir, slug + ".json");
      const data = JSON.stringify(
        { name: themeName || "Tema", colors: colors || {} },
        null,
        2,
      );
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
  ipcMain.handle("theme-delete", async (e, themeId) => {
    try {
      const filePath = path.join(themesDir, themeId + ".json");
      if (!fs.existsSync(filePath)) return { error: "Tema bulunamadı." };
      fs.unlinkSync(filePath);
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  });
  ipcMain.handle("theme-rename", async (e, themeId, newName) => {
    try {
      const filePath = path.join(themesDir, themeId + ".json");
      if (!fs.existsSync(filePath)) return { error: "Tema bulunamadı." };
      const raw = fs.readFileSync(filePath, "utf-8");
      const obj = JSON.parse(raw);
      obj.name = (newName || "").trim() || obj.name;
      fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf-8");
      return { ok: true, name: obj.name };
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

  /** Project Map Faz 2: Import/dependency graph. Sadece parse; kod çalıştırılmaz. */
  ipcMain.handle("project-map-dependencies", async () => {
    if (!projectRoot) return { error: "no-project", nodes: [], edges: [] };
    const rootNorm = projectRoot.replace(/\\/g, "/").replace(/\/$/, "");

    function collectByExt(dirPath, extSet, out) {
      try {
        const names = fs.readdirSync(dirPath);
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
            collectByExt(full, extSet, out);
          } else if (extSet.has(path.extname(name).toLowerCase())) {
            out.push(full);
          }
        }
      } catch (_) {}
    }

    function toRel(fullPath) {
      const p = fullPath.replace(/\\/g, "/");
      if (p.indexOf(rootNorm) === 0) {
        return p.slice(rootNorm.length).replace(/^\//, "") || ".";
      }
      return fullPath;
    }

    function resolveFrom(baseDir, spec) {
      if (!spec || spec.indexOf("://") >= 0) return null;
      if (!spec.startsWith(".") && !spec.startsWith("/")) return null;
      const baseNorm = baseDir.replace(/\\/g, "/");
      let candidate = path
        .normalize(path.join(baseNorm, spec))
        .replace(/\\/g, "/");
      const tries = [
        candidate,
        candidate + ".js",
        candidate + ".mjs",
        candidate + ".cjs",
        candidate + "/index.js",
      ];
      for (const t of tries) {
        try {
          const s = fs.statSync(t);
          if (s.isFile()) return t;
        } catch (_) {}
      }
      return null;
    }

    const htmlFiles = [];
    const jsFiles = [];
    collectByExt(projectRoot, new Set([".html", ".htm"]), htmlFiles);
    collectByExt(projectRoot, new Set([".js", ".mjs", ".cjs"]), jsFiles);

    const nodeSet = new Set();
    const edges = [];
    const nodeList = [];

    function addNode(rel) {
      if (!rel || nodeSet.has(rel)) return rel;
      nodeSet.add(rel);
      nodeList.push({ id: rel, label: rel });
      return rel;
    }

    const SCRIPT_RE = /<script[^>]+src\s*=\s*["']([^"']+)["']/gi;
    const LINK_RE =
      /<link[^>]+href\s*=\s*["']([^"']+)["'][^>]*(?:rel\s*=\s*["']stylesheet["']|>)/gi;
    const LINK_RE2 =
      /<link[^>]+rel\s*=\s*["']stylesheet["'][^>]+href\s*=\s*["']([^"']+)["']/gi;
    const IMPORT_RE =
      /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?["']([^'"]+)["']/g;
    const IMPORT_RE2 = /import\s+["']([^'"]+)["']/g;
    const REQUIRE_RE = /require\s*\(\s*["']([^'"]+)["']\s*\)/g;

    const processed = new Set();
    const queue = [];

    for (const htmlPath of htmlFiles) {
      const htmlDir = path.dirname(htmlPath).replace(/\\/g, "/");
      let content;
      try {
        content = fs.readFileSync(htmlPath, "utf-8");
      } catch (_) {
        continue;
      }
      const fromRel = addNode(toRel(htmlPath));
      if (!fromRel) continue;

      let m;
      SCRIPT_RE.lastIndex = 0;
      while ((m = SCRIPT_RE.exec(content)) !== null) {
        const href = m[1].trim().replace(/^\//, "");
        const resolved = path.join(htmlDir, href).replace(/\\/g, "/");
        if (
          resolved.indexOf(rootNorm) === 0 &&
          fs.existsSync(resolved) &&
          fs.statSync(resolved).isFile()
        ) {
          const toRel2 = addNode(toRel(resolved));
          if (toRel2) {
            edges.push({ from: fromRel, to: toRel2 });
            queue.push(resolved);
          }
        }
      }
      for (const re of [LINK_RE, LINK_RE2]) {
        re.lastIndex = 0;
        while ((m = re.exec(content)) !== null) {
          const href = m[1].trim().replace(/^\//, "");
          const resolved = path.join(htmlDir, href).replace(/\\/g, "/");
          if (
            resolved.indexOf(rootNorm) === 0 &&
            fs.existsSync(resolved) &&
            fs.statSync(resolved).isFile()
          ) {
            const toRel2 = addNode(toRel(resolved));
            if (toRel2) edges.push({ from: fromRel, to: toRel2 });
          }
        }
      }
    }

    while (queue.length > 0) {
      const filePath = queue.shift();
      const key = filePath.replace(/\\/g, "/");
      if (processed.has(key)) continue;
      processed.add(key);

      const ext = path.extname(filePath).toLowerCase();
      if (ext !== ".js" && ext !== ".mjs" && ext !== ".cjs") continue;

      const fromRel = addNode(toRel(filePath));
      const baseDir = path.dirname(filePath).replace(/\\/g, "/");

      let content;
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch (_) {
        continue;
      }

      const contentNoComments = content
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, " ");

      for (const re of [IMPORT_RE, IMPORT_RE2, REQUIRE_RE]) {
        re.lastIndex = 0;
        while ((m = re.exec(contentNoComments)) !== null) {
          const spec = m[1].trim();
          const resolved = resolveFrom(baseDir, spec);
          if (resolved && resolved.indexOf(rootNorm) === 0) {
            const toRel2 = addNode(toRel(resolved));
            if (toRel2 && toRel2 !== fromRel) {
              edges.push({ from: fromRel, to: toRel2 });
              queue.push(resolved);
            }
          }
        }
      }
    }

    return { nodes: nodeList, edges };
  });

  /** Project Map Faz 3: Component graph. HTML sayfalarının iframe/object/link import ile kullandığı HTML bileşenleri. */
  ipcMain.handle("project-map-components", async () => {
    if (!projectRoot) return { error: "no-project", nodes: [], edges: [] };
    const rootNorm = path
      .resolve(projectRoot)
      .replace(/\\/g, "/")
      .replace(/\/$/, "");

    function collectHtml(dirPath, out) {
      try {
        const names = fs.readdirSync(dirPath);
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
            collectHtml(full, out);
          } else if (/\.(html?)$/i.test(name)) {
            out.push(full);
          }
        }
      } catch (_) {}
    }

    function toRel(fullPath) {
      const abs = path.resolve(fullPath).replace(/\\/g, "/");
      if (abs.toLowerCase().indexOf(rootNorm.toLowerCase()) === 0) {
        return abs.slice(rootNorm.length).replace(/^\//, "") || ".";
      }
      const rel = path.relative(projectRoot, fullPath).replace(/\\/g, "/");
      return rel.startsWith("..") ? fullPath : rel;
    }

    const htmlFiles = [];
    collectHtml(projectRoot, htmlFiles);

    const nodeSet = new Set();
    const edges = [];
    const nodeList = [];

    function addNode(rel) {
      if (!rel || nodeSet.has(rel)) return rel;
      nodeSet.add(rel);
      nodeList.push({ id: rel, label: rel });
      return rel;
    }

    const IFRAME_RE = /<iframe[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi;
    const OBJECT_RE = /<object[^>]*\sdata\s*=\s*["']([^"']+)["']/gi;
    const EMBED_RE = /<embed[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi;
    const LINK_IMPORT_RE =
      /<link[^>]+rel\s*=\s*["']import["'][^>]+href\s*=\s*["']([^"']+)["']/gi;
    const LINK_IMPORT_RE2 =
      /<link[^>]+href\s*=\s*["']([^"']+)["'][^>]+rel\s*=\s*["']import["']/gi;
    const SSI_RE =
      /<!--#include\s+(?:file|virtual)\s*=\s*["']([^"']+)["']\s*-->/gi;

    for (const htmlPath of htmlFiles) {
      const htmlDir = path.dirname(htmlPath);
      let content;
      try {
        content = fs.readFileSync(htmlPath, "utf-8");
      } catch (_) {
        continue;
      }
      const fromRel = addNode(toRel(htmlPath));
      if (!fromRel) continue;

      const patterns = [
        IFRAME_RE,
        OBJECT_RE,
        EMBED_RE,
        LINK_IMPORT_RE,
        LINK_IMPORT_RE2,
        SSI_RE,
      ];

      for (const re of patterns) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(content)) !== null) {
          const href = m[1].trim().replace(/^\//, "");
          if (!href || href.indexOf("://") >= 0) continue;
          const resolved = path.resolve(htmlDir, href).replace(/\\/g, "/");
          const relCheck = path
            .relative(projectRoot, resolved)
            .replace(/\\/g, "/");
          if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) continue;
          try {
            if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile())
              continue;
          } catch (_) {
            continue;
          }
          const ext = path.extname(resolved).toLowerCase();
          if (ext !== ".html" && ext !== ".htm") continue;
          const toRel2 = addNode(toRel(resolved));
          if (toRel2 && toRel2 !== fromRel) {
            edges.push({ from: fromRel, to: toRel2 });
          }
        }
      }
    }

    return { nodes: nodeList, edges };
  });

  async function runMarkupStyleAnalysis() {
    if (!projectRoot) return { error: "no-project", items: [] };
    const CSS_CLASS_RE = /\.([a-zA-Z_-][a-zA-Z0-9_-]*)(?:\s|[,>{+~:\[.\(]|$)/g;
    const HTML_CLASS_RE = /(?<![a-zA-Z0-9_-])class\s*=\s*["']([^"']*)["']/g;
    const IMG_NO_ALT_RE = /<img(?![^>]*\balt\s*=)[^>]*>/gi;
    const CSS_PROP_RE = /([a-zA-Z][a-zA-Z0-9_-]*)\s*:/g;
    const CSS_EMPTY_RULE_RE = /([^{}]+)\{\s*\}/g;

    const VALID_CSS_PROPS = new Set([
      "color",
      "background",
      "background-color",
      "background-image",
      "background-repeat",
      "background-position",
      "background-size",
      "margin",
      "margin-top",
      "margin-right",
      "margin-bottom",
      "margin-left",
      "padding",
      "padding-top",
      "padding-right",
      "padding-bottom",
      "padding-left",
      "border",
      "border-top",
      "border-right",
      "border-bottom",
      "border-left",
      "border-radius",
      "border-width",
      "border-color",
      "border-style",
      "box-shadow",
      "box-sizing",
      "display",
      "flex",
      "flex-direction",
      "flex-wrap",
      "flex-grow",
      "flex-shrink",
      "align-items",
      "justify-content",
      "gap",
      "grid",
      "grid-template-columns",
      "grid-template-rows",
      "grid-column",
      "grid-row",
      "width",
      "height",
      "min-width",
      "min-height",
      "max-width",
      "max-height",
      "font-size",
      "font-weight",
      "font-family",
      "line-height",
      "text-align",
      "text-decoration",
      "text-transform",
      "letter-spacing",
      "opacity",
      "visibility",
      "position",
      "top",
      "right",
      "bottom",
      "left",
      "z-index",
      "overflow",
      "overflow-x",
      "overflow-y",
      "cursor",
      "transition",
      "transform",
      "object-fit",
      "list-style",
      "outline",
      "outline-offset",
      "resize",
      "user-select",
      "pointer-events",
      "content",
      "vertical-align",
    ]);

    function getExcludedHtmlRanges(content) {
      const ranges = [];
      const re =
        /<!--[\s\S]*?-->|<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi;
      let m;
      while ((m = re.exec(content)) !== null) {
        ranges.push({ start: m.index, end: m.index + m[0].length });
      }
      return ranges;
    }

    function isInRange(index, ranges) {
      for (const r of ranges) {
        if (index >= r.start && index < r.end) return true;
      }
      return false;
    }

    function getLineAt(content, index) {
      return content.slice(0, index).split(/\r?\n/).length;
    }

    function stripCommentsFromLine(line, inBlockComment) {
      let out = { line: line, inBlock: inBlockComment };
      if (inBlockComment) {
        const end = line.indexOf("*/");
        if (end >= 0) {
          out.line = line.slice(end + 2);
          out.inBlock = false;
        } else {
          out.line = "";
          return out;
        }
      }
      const idx = out.line.indexOf("/*");
      if (idx >= 0) {
        const end = out.line.indexOf("*/", idx);
        if (end >= 0) {
          out.line = out.line.slice(0, idx) + out.line.slice(end + 2);
        } else {
          out.line = out.line.slice(0, idx);
          out.inBlock = true;
        }
      }
      return out;
    }

    function collectByExt(dirPath, extSet, out) {
      try {
        const names = fs.readdirSync(dirPath);
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
            collectByExt(full, extSet, out);
          } else if (extSet.has(path.extname(name).toLowerCase())) {
            out.push(full);
          }
        }
      } catch (_) {}
    }

    function addItem(
      items,
      severity,
      category,
      message,
      filePath,
      line,
      extra,
    ) {
      const rel = path.relative(projectRoot, filePath).replace(/\\/g, "/");
      items.push({
        severity,
        category,
        message,
        file: filePath,
        rel,
        line: line || 1,
        ...extra,
      });
    }

    const cssFiles = [];
    const htmlFiles = [];
    collectByExt(projectRoot, new Set([".css"]), cssFiles);
    collectByExt(projectRoot, new Set([".html", ".htm"]), htmlFiles);

    const items = [];
    const usedClasses = new Set();
    const definedClasses = new Set();

    for (const filePath of htmlFiles) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split(/\r?\n/);
        const rel = path.relative(projectRoot, filePath).replace(/\\/g, "/");
        const excluded = getExcludedHtmlRanges(content);
        let m;
        HTML_CLASS_RE.lastIndex = 0;
        while ((m = HTML_CLASS_RE.exec(content)) !== null) {
          if (isInRange(m.index, excluded)) continue;
          const classes = m[1].split(/\s+/).filter(Boolean);
          classes.forEach((c) => usedClasses.add(c));
        }
        for (let i = 0; i < lines.length; i++) {
          IMG_NO_ALT_RE.lastIndex = 0;
          if (IMG_NO_ALT_RE.test(lines[i])) {
            addItem(
              items,
              "error",
              "missing-alt",
              "<img> eksik alt attribute",
              filePath,
              i + 1,
            );
          }
        }
      } catch (_) {}
    }

    const DEF_CLASS_RE = /\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g;
    for (const filePath of cssFiles) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const noComments = content.replace(/\/\*[\s\S]*?\*\//g, " ");
        const selectorBlocks = noComments.match(/[^{]+\{/g) || [];
        for (const block of selectorBlocks) {
          const sel = block.replace(/\s*\{$/, "").trim();
          if (
            sel.startsWith("@import") ||
            sel.startsWith("@charset") ||
            sel.includes("url(")
          )
            continue;
          DEF_CLASS_RE.lastIndex = 0;
          let m;
          while ((m = DEF_CLASS_RE.exec(sel)) !== null) {
            if (m[1] !== "css") definedClasses.add(m[1]);
          }
        }
      } catch (_) {}
    }

    for (const filePath of htmlFiles) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const excluded = getExcludedHtmlRanges(content);
        HTML_CLASS_RE.lastIndex = 0;
        let m;
        while ((m = HTML_CLASS_RE.exec(content)) !== null) {
          if (isInRange(m.index, excluded)) continue;
          const classes = m[1].split(/\s+/).filter(Boolean);
          for (const cls of classes) {
            if (cls.startsWith("fa-")) continue;
            if (!definedClasses.has(cls)) {
              addItem(
                items,
                "warning",
                "undefined-class",
                "Tanımsız sınıf: ." + cls,
                filePath,
                getLineAt(content, m.index),
                { class: cls },
              );
            }
          }
        }
      } catch (_) {}
    }

    for (const filePath of cssFiles) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split(/\r?\n/);
        const rel = path.relative(projectRoot, filePath).replace(/\\/g, "/");
        let inBlock = false;
        let m;
        for (let i = 0; i < lines.length; i++) {
          const { line, inBlock: next } = stripCommentsFromLine(
            lines[i],
            inBlock,
          );
          inBlock = next;
          if (!line.trim()) continue;
          if (
            line.trimStart().startsWith("@import") ||
            line.trimStart().startsWith("@charset")
          )
            continue;
          CSS_CLASS_RE.lastIndex = 0;
          while ((m = CSS_CLASS_RE.exec(line)) !== null) {
            const cls = m[1];
            if (cls !== "css" && !usedClasses.has(cls)) {
              addItem(
                items,
                "warning",
                "unused-class",
                "Kullanılmayan sınıf: ." + cls,
                filePath,
                i + 1,
                { class: cls },
              );
            }
          }
          CSS_PROP_RE.lastIndex = 0;
          while ((m = CSS_PROP_RE.exec(line)) !== null) {
            const prop = m[1];
            if (prop.length <= 1) continue;
            if (prop === "https" || prop === "http" || prop === "data")
              continue;
            const afterMatch = line[m.index + m[0].length];
            if (afterMatch === ":") continue;
            const prev = m.index > 0 ? line[m.index - 1] : " ";
            if (prev === ".") continue;
            if (prev === "-") continue;
            if (
              !prop.startsWith("-") &&
              !prop.startsWith("--") &&
              !VALID_CSS_PROPS.has(prop)
            ) {
              addItem(
                items,
                "error",
                "invalid-property",
                "Geçersiz property: " + prop,
                filePath,
                i + 1,
                { property: prop },
              );
            }
          }
        }
        let emptyM;
        CSS_EMPTY_RULE_RE.lastIndex = 0;
        while ((emptyM = CSS_EMPTY_RULE_RE.exec(content)) !== null) {
          const before = content.slice(0, emptyM.index);
          const lineNum = before.split(/\r?\n/).length;
          const sel = (emptyM[1] || "")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 40);
          if (!/^[.#@a-zA-Z*\[:]/.test(sel)) continue;
          addItem(
            items,
            "info",
            "empty-rule",
            "Boş kural: " + (sel || "(anon)"),
            filePath,
            lineNum,
            { selector: sel },
          );
        }
      } catch (_) {}
    }

    return { items };
  }

  ipcMain.handle("analyze-markup-style", runMarkupStyleAnalysis);
  ipcMain.handle("analyze-css-usage", async () => {
    const res = await runMarkupStyleAnalysis();
    if (res.error) return { error: res.error, unused: [] };
    const unused = (res.items || [])
      .filter((i) => i.category === "unused-class")
      .map((i) => ({ class: i.class, file: i.file, rel: i.rel, line: i.line }));
    return { unused };
  });

  const LOG_EXT = new Set([".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"]);
  const CONSOLE_LINE_RE =
    /^\s*(?:\/\/\s*)?console\.(log|warn|error|debug|info)\s*\(/;

  function collectFiles(dirPath, out) {
    try {
      const names = fs.readdirSync(dirPath);
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
          collectFiles(full, out);
        } else if (LOG_EXT.has(path.extname(name).toLowerCase())) {
          out.push(full);
        }
      }
    } catch (_) {}
  }

  ipcMain.handle("find-logs", async () => {
    if (!projectRoot) return { error: "no-project", results: [] };
    const files = [];
    collectFiles(projectRoot, files);
    const results = [];
    for (const filePath of files) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split(/\r?\n/);
        const rel = path.relative(projectRoot, filePath).replace(/\\/g, "/");
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(CONSOLE_LINE_RE);
          if (m) {
            results.push({
              file: filePath,
              rel,
              line: i + 1,
              content: lines[i].trim(),
              type: m[1],
            });
          }
        }
      } catch (_) {}
    }
    return { results };
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
  ipcMain.handle("markdown-parse", async (e, md) => {
    if (typeof md !== "string") return { error: "invalid" };
    try {
      const marked = require("marked");
      const createDOMPurify = require("dompurify");
      const { JSDOM } = require("jsdom");
      const window = new JSDOM("").window;
      const DOMPurify = createDOMPurify(window);
      marked.setOptions({ gfm: true, breaks: true });
      const renderer = new marked.Renderer();
      const origCode = renderer.code.bind(renderer);
      renderer.code = function (token) {
        const langNorm = (token.lang || "").trim().toLowerCase();
        if (langNorm === "mermaid") {
          return '<div class="mermaid">' + escapeHtml(token.text) + "</div>";
        }
        return origCode(token);
      };
      function escapeHtml(s) {
        return String(s)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      }
      let raw = marked.parse(md, { renderer });
      if (raw && typeof raw.then === "function") raw = await raw;
      if (typeof raw !== "string") return { error: "parse-failed" };
      const html = DOMPurify.sanitize(raw, {
        ALLOWED_TAGS: [
          "h1",
          "h2",
          "h3",
          "h4",
          "h5",
          "h6",
          "p",
          "br",
          "hr",
          "ul",
          "ol",
          "li",
          "strong",
          "em",
          "s",
          "code",
          "pre",
          "blockquote",
          "a",
          "img",
          "input",
          "table",
          "thead",
          "tbody",
          "tr",
          "th",
          "td",
          "div",
        ],
        ALLOWED_ATTR: [
          "href",
          "src",
          "alt",
          "title",
          "class",
          "id",
          "type",
          "checked",
          "disabled",
        ],
      });
      return { html };
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
  /** CodeDiagram Faz 1: AST'tan sınıf/metod modeli çıkar. Sadece parse; kod çalıştırılmaz. */
  const CODE_DIAGRAM_MAX_BYTES = 512 * 1024; // 500KB
  ipcMain.handle("code-diagram-parse", async (e, filePath, content) => {
    if (typeof content !== "string" || !filePath)
      return { error: "invalid-input" };
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== ".js" && ext !== ".mjs" && ext !== ".cjs")
      return { error: "unsupported-ext", supported: [".js", ".mjs", ".cjs"] };
    const byteLen = Buffer.byteLength(content, "utf-8");
    if (byteLen > CODE_DIAGRAM_MAX_BYTES)
      return { error: "file-too-large", maxBytes: CODE_DIAGRAM_MAX_BYTES };
    try {
      const acorn = require("acorn");
      let ast;
      try {
        ast = acorn.parse(content, {
          ecmaVersion: 2022,
          sourceType: "module",
          locations: true,
        });
      } catch (moduleErr) {
        ast = acorn.parse(content, {
          ecmaVersion: 2022,
          sourceType: "script",
          locations: true,
        });
      }
      const classNames = new Set();
      const classes = [];
      for (const node of ast.body || []) {
        if (node.type === "ClassDeclaration" && node.id) {
          const methods = [];
          const attributes = [];
          const body = node.body && node.body.body;
          if (Array.isArray(body)) {
            for (const el of body) {
              if (el.type === "MethodDefinition" && el.key) {
                const name =
                  el.key.type === "Identifier"
                    ? el.key.name
                    : el.key.type === "PrivateIdentifier"
                      ? "#" + el.key.name
                      : null;
                if (name) methods.push(name);
              } else if (el.type === "PropertyDefinition" && el.key) {
                const name =
                  el.key.type === "Identifier"
                    ? el.key.name
                    : el.key.type === "PrivateIdentifier"
                      ? "#" + el.key.name
                      : null;
                if (name) attributes.push(name);
              }
            }
          }
          const extendsName =
            node.superClass && node.superClass.type === "Identifier"
              ? node.superClass.name
              : null;
          classNames.add(node.id.name);
          classes.push({
            type: "class",
            name: node.id.name,
            methods,
            attributes,
            extends: extendsName,
          });
        }
      }

      const deps = [];
      function walk(node, fromClass) {
        if (!node) return;
        if (node.type === "NewExpression" && node.callee) {
          const name =
            node.callee.type === "Identifier"
              ? node.callee.name
              : node.callee.type === "MemberExpression" &&
                  node.callee.property?.type === "Identifier"
                ? node.callee.property.name
                : null;
          if (name && classNames.has(name) && fromClass && fromClass !== name) {
            deps.push({ from: fromClass, to: name });
          }
        }
        for (const k of Object.keys(node)) {
          const v = node[k];
          if (v && typeof v === "object") {
            if (Array.isArray(v)) {
              v.forEach((c) => walk(c, fromClass));
            } else if (v.type) {
              walk(v, fromClass);
            }
          }
        }
      }
      for (const cls of classes) {
        const decl = ast.body?.find(
          (n) =>
            n.type === "ClassDeclaration" && n.id && n.id.name === cls.name,
        );
        if (decl) walk(decl, cls.name);
      }

      return {
        diagram: { classes, dependencies: deps },
        error: null,
      };
    } catch (err) {
      return { error: "parse-error", message: err.message };
    }
  });

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
          rules: {
            "no-undef": "error",
            "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
            "no-empty-function": "warn",
            "no-constant-condition": "warn",
            "no-unreachable": "warn",
          },
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
    ipcMain.handle("open-folder-in-new-window-at-path", async (e, dirPath) => {
      const resolved = path.resolve(normalizePath(dirPath));
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory())
        return { ok: false };
      createWindow(activePort, resolved);
      return { ok: true };
    });
    const folderFromArgv = getFolderFromArgv();
    runApp(port, folderFromArgv);
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
