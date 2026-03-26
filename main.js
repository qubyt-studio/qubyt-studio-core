const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  screen,
} = require("electron");
const path = require("path");
const { pathToFileURL, fileURLToPath } = require("url");
const fs = require("fs");
const http = require("http");
const net = require("net");
const WebSocket = require("ws");
const { spawn } = require("child_process");
const esbuild = require("esbuild");
const lsp = require("./lsp-server");

const SERVER_PORT = 9292;
const ROOT = __dirname;
if (process.env.QUBYT_TRACE_NODE_DEBUG === "1") {
  console.log(
    "[qubyt] QUBYT_TRACE_NODE_DEBUG=1 — yalnızca ana süreç `debug-node-paused` gönderdiğinde ek satır düşer; uygulama açılışında durak yoksa başka log beklemeyin.",
  );
}

/** preload ile aynı: Node inspector IPC varsayılan kapalı; yalnızca bu bayrakta açılır. */
function qubytNodeInspectorEnabled() {
  return process.env.QUBYT_ENABLE_NODE_INSPECTOR_UI === "1";
}
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

/** Windows: V8 script URL’si sürücü harfini farklı casing ile verebilir; tek URL ile setBreakpointByUrl kaçar. */
function fileUrlVariantsForDebugger(absPath) {
  const norm = path.resolve(normalizePath(absPath));
  const href = pathToFileURL(norm).href;
  const out = new Set([href]);
  const m = href.match(/^file:\/\/\/([A-Za-z])(:\/.*)$/);
  if (m) {
    const rest = m[2];
    out.add(`file:///${m[1].toLowerCase()}${rest}`);
    out.add(`file:///${m[1].toUpperCase()}${rest}`);
  }
  return [...out];
}

function debuggerPathsSameFile(a, b) {
  const pa = path.resolve(normalizePath(a));
  const pb = path.resolve(normalizePath(b));
  if (process.platform === "win32") {
    return pa.toLowerCase() === pb.toLowerCase();
  }
  return pa === pb;
}

function debuggerUrlToFsPath(u) {
  if (!u || typeof u !== "string" || !u.startsWith("file:")) return null;
  try {
    return path.resolve(normalizePath(fileURLToPath(u)));
  } catch (_) {
    return null;
  }
}

/** setBreakpointByUrl başarılı olup betik henüz yüklenmemişse locations [] dönebilir; breakpointId yine gelir. */
function cdpBreakpointAccepted(br) {
  if (!br || typeof br !== "object") return false;
  if (br.breakpointId != null && br.breakpointId !== "") return true;
  if (Array.isArray(br.locations) && br.locations.length > 0) return true;
  return false;
}

/** scriptParsed url → dosya yolu tam eşleşmezse (normalize farkı) basename+klasör ile yedek. */
function scriptIdForResolvedScript(scriptUrlById, resolved) {
  if (!scriptUrlById || !resolved) return null;
  const want = path.resolve(normalizePath(resolved));
  const wantBase = path.basename(want).toLowerCase();
  const wantDir = path.dirname(want).toLowerCase();
  for (const [sid, url] of scriptUrlById.entries()) {
    if (!url || typeof url !== "string") continue;
    const sp = debuggerUrlToFsPath(url);
    if (sp && debuggerPathsSameFile(sp, want)) return sid;
  }
  for (const [sid, url] of scriptUrlById.entries()) {
    if (!url || typeof url !== "string") continue;
    const sp = debuggerUrlToFsPath(url);
    if (!sp) continue;
    if (path.basename(sp).toLowerCase() !== wantBase) continue;
    if (path.dirname(sp).toLowerCase() === wantDir) return sid;
  }
  return null;
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

/** Faz 1 — tek aktif Node debug oturumu (127.0.0.1 inspector + CDP) */
let nodeDebugSession = null;

/** Düz `node dosya.js` — canlı stdout/stderr (inspector yok); Terminal Çalıştır */
let nodeLiveRunSession = null;

function disposeNodeLiveRun() {
  if (!nodeLiveRunSession) return;
  const sess = nodeLiveRunSession;
  nodeLiveRunSession = null;
  try {
    if (sess.child && !sess.child.killed) sess.child.kill("SIGTERM");
  } catch (_) {}
  try {
    if (sess.sender && !sess.sender.isDestroyed()) {
      sess.sender.send("run-node-live-ended", {
        code: null,
        reason: "replaced",
      });
    }
  } catch (_) {}
}

function disposeNodeDebugSession() {
  if (!nodeDebugSession) return;
  const notifySender = nodeDebugSession.sender;
  try {
    if (nodeDebugSession.pauseUiFallbackTimer) {
      clearTimeout(nodeDebugSession.pauseUiFallbackTimer);
      nodeDebugSession.pauseUiFallbackTimer = null;
    }
  } catch (_) {}
  try {
    if (nodeDebugSession.resumeUiTimer) {
      clearTimeout(nodeDebugSession.resumeUiTimer);
      nodeDebugSession.resumeUiTimer = null;
    }
  } catch (_) {}
  try {
    const pend = nodeDebugSession.cdpPending;
    if (pend && pend.size) {
      for (const [, p] of pend) {
        try {
          clearTimeout(p.timeout);
        } catch (_) {}
      }
      pend.clear();
    }
  } catch (_) {}
  try {
    if (nodeDebugSession.ws) {
      nodeDebugSession.ws.removeAllListeners("message");
      nodeDebugSession.ws.removeAllListeners("error");
      nodeDebugSession.ws.removeAllListeners("open");
      if (
        nodeDebugSession.ws.readyState === WebSocket.OPEN ||
        nodeDebugSession.ws.readyState === WebSocket.CONNECTING
      ) {
        nodeDebugSession.ws.close();
      }
    }
  } catch (_) {}
  try {
    if (nodeDebugSession.child && !nodeDebugSession.child.killed) {
      nodeDebugSession.child.kill("SIGTERM");
    }
  } catch (_) {}
  nodeDebugSession = null;
  try {
    if (notifySender && !notifySender.isDestroyed()) {
      notifySender.send("debug-node-resumed");
    }
  } catch (_) {}
}

/** Faz 4 — Debugger.paused: dosya+satır; call stack + kapsam değişkenleri (Runtime.getProperties). */
function buildMinimalNodePausedPayload(params, scriptUrlById) {
  const frames = params && params.callFrames;
  if (!frames || !frames.length) return null;
  /* Duraklat / iç çerçeve: üst kare node:internal olabilir; kullanıcı dosyası altta kalır. */
  for (let fi = 0; fi < frames.length; fi++) {
    const fr = frames[fi];
    const loc = fr && fr.location;
    if (!loc) continue;
    let url = loc.url;
    if ((!url || url === "") && loc.scriptId) {
      url = scriptUrlById.get(loc.scriptId);
    }
    if (!url || typeof url !== "string" || !url.startsWith("file:")) continue;
    let fsPath;
    try {
      fsPath = path.resolve(normalizePath(fileURLToPath(url)));
    } catch (_) {
      continue;
    }
    const line = (loc.lineNumber ?? 0) + 1;
    return {
      filePath: fsPath,
      line,
      reason: (params && params.reason) || "",
    };
  }
  return null;
}

function sessionScriptPathForPausedFallback() {
  return nodeDebugSession && nodeDebugSession.filePath
    ? String(nodeDebugSession.filePath)
    : "";
}

/** callFrames boş veya eşleşmeyen durak — yine de DEBUG’e bir şey gönder.
 *  opts.steppingDisabled: VM gerçekten durmuyorsa true — renderer Adım/Devam açmasın (CDP hatası önlenir). */
function sendSyntheticPausedPayload(sender, params, reasonTag, opts) {
  if (!sender || sender.isDestroyed()) return;
  const fp = sessionScriptPathForPausedFallback();
  const base = fp ? path.basename(fp) : "?";
  const steppingDisabled = !!(opts && opts.steppingDisabled);
  sendDebugNodePausedToRenderer(sender, {
    filePath: fp,
    line: 0,
    reason:
      ((params && params.reason) || "") + (reasonTag ? ` ${reasonTag}` : ""),
    callStack: [
      {
        functionName: steppingDisabled ? "(önizleme — VM boşta)" : "(pause)",
        file: base,
        line: 0,
        filePath: fp,
      },
    ],
    variables: [],
    steppingDisabled,
  });
}

function buildNodeDebugCallStackFromPausedParams(params, scriptUrlById) {
  const frames = params && params.callFrames;
  if (!frames || !frames.length) return [];
  const callStack = [];
  for (let i = 0; i < frames.length; i++) {
    const fr = frames[i];
    const fn = fr.functionName || "(anonymous)";
    const loc2 = fr.location;
    if (!loc2) continue;
    let url = loc2.url;
    if ((!url || url === "") && loc2.scriptId) {
      url = scriptUrlById.get(loc2.scriptId);
    }
    let filePath = "";
    let file = "?";
    if (url && typeof url === "string" && url.startsWith("file:")) {
      try {
        filePath = path.resolve(normalizePath(fileURLToPath(url)));
        file = path.basename(filePath);
      } catch (_) {}
    } else if (url && typeof url === "string") {
      file = url.length > 48 ? `${url.slice(0, 45)}…` : url;
    }
    const line = (loc2.lineNumber ?? 0) + 1;
    callStack.push({ functionName: fn, file, line, filePath });
  }
  return callStack;
}

function sendDebugNodePausedToRenderer(sender, payload) {
  try {
    if (!sender || sender.isDestroyed()) return;
    if (nodeDebugSession && nodeDebugSession.sender === sender) {
      nodeDebugSession.pauseReportedToRenderer = true;
      nodeDebugSession.syntheticPauseActive = !!(
        payload && payload.steppingDisabled === true
      );
    }
    if (process.env.QUBYT_TRACE_NODE_DEBUG === "1") {
      const nStack =
        payload && payload.callStack ? payload.callStack.length : 0;
      const nVar = payload && payload.variables ? payload.variables.length : 0;
      console.log(
        "[qubyt] IPC debug-node-paused",
        payload && payload.filePath,
        payload && payload.line,
        "stack=" + nStack,
        "vars=" + nVar,
      );
    }
    sender.send("debug-node-paused", payload);
  } catch (_) {}
}

/** enrich başarısız / timeout: yine de çağrı yığını + satır gönder (DEBUG paneli boş kalmasın). */
function sendFallbackDebugNodePaused(sender, params, scriptUrlById) {
  if (!sender || sender.isDestroyed()) return;
  const frames = params && params.callFrames;
  if (!frames || !frames.length) {
    sendSyntheticPausedPayload(sender, params, "(no-call-frames)");
    return;
  }
  const callStack = buildNodeDebugCallStackFromPausedParams(
    params,
    scriptUrlById,
  );
  const min = buildMinimalNodePausedPayload(params, scriptUrlById);
  const top = frames[0];
  const line = min
    ? min.line
    : top && top.location
      ? (top.location.lineNumber ?? 0) + 1
      : 0;
  let filePath = min ? min.filePath : "";
  if (!filePath) filePath = sessionScriptPathForPausedFallback();
  sendDebugNodePausedToRenderer(sender, {
    filePath,
    line,
    reason: (params && params.reason) || "",
    callStack,
    variables: [],
  });
}

/** CDP Runtime.consoleAPICalled → tek satır (inspect altında stdout bazen gecikir/kaçırılır). */
function formatRuntimeConsoleApiCalledLine(params) {
  if (!params) return "";
  const args = params.args || [];
  const parts = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    const t = a.type || "";
    if (t === "string" && a.value != null) parts.push(a.value);
    else if (
      (t === "number" ||
        t === "boolean" ||
        t === "bigint" ||
        t === "undefined") &&
      Object.prototype.hasOwnProperty.call(a, "value")
    ) {
      parts.push(String(a.value));
    } else if (a.subtype === "null") {
      parts.push("null");
    } else if (a.description) {
      parts.push(a.description);
    } else {
      parts.push("(" + (t || "?") + ")");
    }
  }
  return parts.join(" ");
}

async function enrichAndSendNodePaused(params, sender, scriptUrlById, cdpSend) {
  const frames = params && params.callFrames;
  if (!frames || !frames.length) {
    sendSyntheticPausedPayload(sender, params, "(no-call-frames)");
    return;
  }
  if (!sender || sender.isDestroyed()) return;

  const minimal = buildMinimalNodePausedPayload(params, scriptUrlById);

  const callStack = buildNodeDebugCallStackFromPausedParams(
    params,
    scriptUrlById,
  );

  const variables = [];
  const MAX_VARS = 56;
  const MAX_PER_SCOPE = 28;
  const MAX_GLOBAL = 16;
  const top = frames[0];
  const scopeChain = top.scopeChain || [];

  for (let s = 0; s < scopeChain.length && variables.length < MAX_VARS; s++) {
    const scope = scopeChain[s];
    if (!scope || !scope.object || !scope.object.objectId) continue;
    const scopeType = scope.type || "scope";
    const cap =
      scopeType === "global" || scopeType === "module"
        ? MAX_GLOBAL
        : MAX_PER_SCOPE;
    try {
      const gp = await cdpSend("Runtime.getProperties", {
        objectId: scope.object.objectId,
        ownProperties: true,
        generatePreview: true,
      });
      const result = (gp && gp.result) || [];
      let n = 0;
      for (
        let j = 0;
        j < result.length && n < cap && variables.length < MAX_VARS;
        j++
      ) {
        const p = result[j];
        if (!p || !p.name || /^__/.test(p.name)) continue;
        const val = p.value;
        let preview = "";
        let vtype = "undefined";
        if (val) {
          vtype = val.type || "?";
          if (vtype === "string") {
            preview =
              val.value != null ? JSON.stringify(String(val.value)) : '""';
          } else if (vtype === "number" || vtype === "boolean") {
            preview = String(val.value);
          } else if (vtype === "bigint") {
            preview = String(val.value);
          } else if (vtype === "object" && val.subtype === "null") {
            preview = "null";
          } else if (
            vtype === "object" &&
            val.preview &&
            val.preview.description
          ) {
            preview = val.preview.description;
          } else if (val.description) {
            preview = val.description;
          } else {
            preview = vtype;
          }
        } else if (p.get && p.get.objectId) {
          preview = "(…)";
          vtype = "accessor";
        } else {
          continue;
        }
        if (preview.length > 220) preview = `${preview.slice(0, 217)}…`;
        variables.push({
          scope: scopeType,
          name: p.name,
          type: vtype,
          preview,
        });
        n++;
      }
    } catch (_) {
      /* bir kapsam atlanır */
    }
  }

  let filePath = minimal ? minimal.filePath : "";
  if (!filePath) filePath = sessionScriptPathForPausedFallback();
  const payload = {
    filePath,
    line: minimal
      ? minimal.line
      : top && top.location
        ? (top.location.lineNumber ?? 0) + 1
        : 0,
    reason: (params && params.reason) || "",
    callStack,
    variables,
  };
  sendDebugNodePausedToRenderer(sender, payload);
}

/** Aktif Node debug oturumunda tek bir CDP komutu (Faz 3: pause / step / resume). */
async function nodeDebugCdpCommand(method, params) {
  if (
    !nodeDebugSession ||
    !nodeDebugSession.ws ||
    nodeDebugSession.ws.readyState !== WebSocket.OPEN ||
    typeof nodeDebugSession.cdpSend !== "function"
  ) {
    return { error: "no-session" };
  }
  /* Duraklat yedeği: DEBUG’te önizleme var ama VM durmamış — Adım CDP hatası vermesin. */
  if (nodeDebugSession.syntheticPauseActive) {
    if (method === "Debugger.resume") {
      nodeDebugSession.syntheticPauseActive = false;
      try {
        const snd = nodeDebugSession.sender;
        if (snd && !snd.isDestroyed()) {
          snd.send("debug-node-resumed");
        }
      } catch (_) {}
      return { ok: true, info: "synthetic-cleared" };
    }
    if (
      method === "Debugger.stepOver" ||
      method === "Debugger.stepInto" ||
      method === "Debugger.stepOut"
    ) {
      return { error: "synthetic-pause-no-vm" };
    }
  }
  try {
    await nodeDebugSession.cdpSend(
      method,
      params && typeof params === "object" ? params : {},
    );
    return { ok: true };
  } catch (err) {
    const msg = err && err.message ? String(err.message) : "";
    /* Resume yalnızca duraktayken; betik zaten akıyorsa aynı CDP metni gelir — adımdan ayır. */
    if (
      method === "Debugger.resume" &&
      (/can only perform operation while paused/i.test(msg) ||
        /while paused/i.test(msg))
    ) {
      return { info: "resume-not-paused" };
    }
    return { error: err.message || String(method) + "-failed" };
  }
}

function findFreePortLocalhost() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const p = addr && addr.port;
      s.close((err) => {
        if (err) reject(err);
        else resolve(p);
      });
    });
  });
}

function httpGetJsonLocal(urlStr) {
  return new Promise((resolve, reject) => {
    const req = http.get(urlStr, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error("HTTP " + res.statusCode));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(2000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function waitForNodeInspectorWsUrl(port, deadlineMs) {
  const url = `http://127.0.0.1:${port}/json/list`;
  while (Date.now() < deadlineMs) {
    try {
      const list = await httpGetJsonLocal(url);
      if (Array.isArray(list) && list.length > 0) {
        const wsUrl = list[0].webSocketDebuggerUrl;
        if (wsUrl) return wsUrl;
      }
    } catch (_) {
      /* Inspector henüz dinlemiyor */
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error("inspector-ready-timeout");
}

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
/** tryListen bazen (özellikle Windows) listening callback'ini iki kez tetikleyebilir; IPC çift kayıt hatasını önler. */
let staticServerIpcRegistered = false;

function createWindow(port, folderToOpen) {
  const { resolvePngForWindow } = require("./scripts/icon-paths");
  const iconPath = resolvePngForWindow();
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
    ...(iconPath && fs.existsSync(iconPath) ? { icon: iconPath } : {}),
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

  win.on("close", (e) => {
    if (quitAllowed) {
      quitAllowed = false;
      return;
    }
    e.preventDefault();
    win.webContents.send("check-unsaved-before-close");
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
let quitAllowed = false;
let pendingQuit = false;

app.on("before-quit", (e) => {
  if (quitAllowed) {
    quitAllowed = false;
    return;
  }
  e.preventDefault();
  const w =
    BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (w && !w.isDestroyed()) {
    pendingQuit = true;
    w.webContents.send("check-unsaved-before-close");
  } else {
    app.exit(0);
  }
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
    w.webContents.send("check-unsaved-before-close");
  }
  return null;
});

ipcMain.on("close-response", (e, action) => {
  if (action === "cancel") {
    pendingQuit = false;
    return;
  }
  const w = BrowserWindow.fromWebContents(e.sender);
  if (action === "close" && w && !w.isDestroyed()) {
    if (pendingQuit) {
      pendingQuit = false;
      quitAllowed = true;
      app.quit();
    } else {
      w.destroy();
    }
  }
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
    lsp.startLspServer(projectRoot);
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
    lsp.startLspServer(projectRoot);
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
    lsp.startLspServer(projectRoot);
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
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <h1>Merhaba</h1>
  <script src="script.js" defer></script>
</body>
</html>
`,
      },
      {
        name: "style.css",
        content: `/* Minimal başlangıç */\nbody { margin: 0; font-family: system-ui, sans-serif; }\n`,
      },
      {
        name: "script.js",
        content: `// İsteğe bağlı betik\n`,
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
  const _cdnLib = require("./template-definitions.js");
  const _exampleLib = require("./library-example-definitions.js");
  const _miniProjects = require("./mini-project-templates.js");
  Object.assign(
    TEMPLATES,
    _cdnLib.templates,
    _exampleLib.templates,
    _miniProjects.templates,
  );
  /** Çekirdek üç şablon: proje kökünde components/<şablon>/ (diğer bileşen düzeni ile uyumlu). */
  const CORE_TEMPLATE_SUBDIRS = {
    "html5-empty": path.join("components", "html5-empty"),
    "html5-css-js": path.join("components", "html5-css-js"),
    "single-page": path.join("components", "single-page"),
    "mini-todo-vanilla": "mini-todo-vanilla",
    "mini-api-fetch": "mini-api-fetch",
    "mini-dashboard-skeleton": "mini-dashboard-skeleton",
  };
  const TEMPLATE_SUBDIRS = Object.assign(
    {},
    _cdnLib.subdirs || {},
    _exampleLib.subdirs || {},
    CORE_TEMPLATE_SUBDIRS,
  );

  ipcMain.handle(
    "write-template",
    async (e, folderPath, templateId, entryFileName) => {
      const dir = path.resolve(normalizePath(folderPath));
      const files = TEMPLATES[templateId];
      if (!files || !Array.isArray(files))
        return { error: "Bilinmeyen şablon." };
      const sub = TEMPLATE_SUBDIRS[templateId];
      try {
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
          return { error: "Hedef klasör bulunamadı." };
        let baseDir = dir;
        if (sub) {
          const subPath = path.join(dir, sub);
          if (fs.existsSync(subPath)) {
            const st = fs.statSync(subPath);
            if (!st.isDirectory())
              return {
                error: `'${sub}' bir dosya; aynı ada klasör oluşturulamıyor.`,
              };
            let entries;
            try {
              entries = fs.readdirSync(subPath);
            } catch (e) {
              return { error: e.message || "Klasör okunamadı." };
            }
            if (entries.length > 0)
              return {
                error: `'${sub}' klasörü boş değil. Boş klasör silin veya farklı hedef seçin.`,
              };
          } else {
            fs.mkdirSync(subPath, { recursive: true });
          }
          baseDir = subPath;
        }
        const written = [];
        for (const f of files) {
          const full = path.join(baseDir, f.name);
          const parent = path.dirname(full);
          if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
          if (fs.existsSync(full))
            return {
              error: `${f.name} zaten mevcut. Farklı bir klasör veya boş alt klasör seçin.`,
            };
          fs.writeFileSync(full, f.content, "utf-8");
          written.push(full);
        }
        let entryBase = "index.html";
        if (typeof entryFileName === "string" && entryFileName.trim()) {
          const base = path.basename(entryFileName.replace(/\\/g, "/"));
          if (base && !base.includes("..")) entryBase = base;
        }
        let hasEntryFile = files.some((f) => f && f.name === entryBase);
        if (!hasEntryFile) {
          entryBase = "index.html";
          hasEntryFile = files.some((f) => f && f.name === entryBase);
        }
        if (!hasEntryFile) {
          const firstHtml = files.find(
            (f) => f && typeof f.name === "string" && /\.html?$/i.test(f.name),
          );
          if (firstHtml) entryBase = firstHtml.name;
        }
        const entryRelative = sub
          ? sub.replace(/\\/g, "/") + "/" + entryBase
          : entryBase;
        return { ok: true, path: dir, files: written, entryRelative };
      } catch (err) {
        return { error: err.message || "Yazma hatası." };
      }
    },
  );

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
    disposeNodeDebugSession();
    lsp.stopLspServer();
    projectRoot = null;
    return { ok: true };
  });

  /* LSP Faz 1 — TypeScript Language Server */
  ipcMain.handle("lsp-start", async (e, projectRootPath) => {
    const result = lsp.startLspServer(projectRootPath || projectRoot);
    return result;
  });
  ipcMain.handle("lsp-stop", async () => {
    lsp.stopLspServer();
    return { ok: true };
  });
  ipcMain.handle("lsp-status", async () => lsp.getLspStatus());

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
  const builtinComponentsDir = path.join(ROOT, "docs", "component-library");
  ipcMain.handle("list-builtin-components", async () => {
    try {
      if (!fs.existsSync(builtinComponentsDir)) return { entries: [] };
      let manifest = {};
      const manifestPath = path.join(builtinComponentsDir, "components.json");
      if (fs.existsSync(manifestPath)) {
        try {
          const raw = fs.readFileSync(manifestPath, "utf-8");
          manifest = JSON.parse(raw);
        } catch (_) {}
      }
      const dirs = fs.readdirSync(builtinComponentsDir);
      const result = [];
      for (const dirName of dirs) {
        const dirPath = path.join(builtinComponentsDir, dirName);
        if (!fs.statSync(dirPath).isDirectory()) continue;
        const files = fs.readdirSync(dirPath);
        for (const f of files) {
          if (!/\.(html|htm)$/i.test(f)) continue;
          const relPath = dirName + "/" + f;
          const fullPath = path.join(dirPath, f);
          let type = "design";
          const manifestEntry = manifest[relPath];
          let typeOverride = null;
          let description = "";
          let descriptionEn = "";
          let displayName = "";
          let detailFactKey = "";
          let levelScore = null;
          let scriptCatalogGroup = "";
          if (manifestEntry) {
            if (typeof manifestEntry === "object") {
              if (manifestEntry.type === "script") typeOverride = "script";
              description = manifestEntry.description || "";
              descriptionEn =
                manifestEntry.descriptionEn ||
                manifestEntry.description_en ||
                "";
              displayName = String(manifestEntry.displayName || "").trim();
              detailFactKey = String(manifestEntry.detailFactKey || "").trim();
              const rawScore = manifestEntry.levelScore;
              if (typeof rawScore === "number" && !Number.isNaN(rawScore)) {
                levelScore = rawScore;
              } else if (rawScore != null && rawScore !== "") {
                const n = Number(rawScore);
                if (!Number.isNaN(n)) levelScore = n;
              }
              scriptCatalogGroup = String(
                manifestEntry.scriptCatalogGroup || "",
              ).trim();
            } else if (manifestEntry === "script") {
              typeOverride = "script";
            }
          }
          if (typeOverride === null) {
            try {
              const content = fs.readFileSync(fullPath, "utf-8");
              if (/<script[\s>]/i.test(content)) type = "script";
            } catch (_) {}
          } else {
            type = typeOverride;
          }
          const baseName = f.replace(/\.(html|htm)$/i, "");
          result.push({
            level: dirName,
            name: baseName,
            displayName: displayName || baseName,
            path: fullPath,
            relativePath: relPath,
            type,
            description,
            descriptionEn,
            detailFactKey,
            levelScore,
            scriptCatalogGroup,
          });
        }
      }
      return { entries: result };
    } catch (err) {
      return { error: err.message };
    }
  });
  ipcMain.handle("read-builtin-component", async (e, relativePath) => {
    try {
      const base = path.resolve(builtinComponentsDir);
      const resolved = path.resolve(
        builtinComponentsDir,
        (relativePath || "").replace(/\.\./g, ""),
      );
      if (!resolved.startsWith(base)) return { error: "forbidden" };
      const content = fs.readFileSync(resolved, "utf-8");
      return { content };
    } catch (err) {
      return { error: err.message };
    }
  });

  /** Bileşen galerisini aynı pencerede açar; opts örn. { scrollToCategory: "buttons" } */
  ipcMain.handle("open-component-gallery", async (event, opts) => {
    const payload =
      opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {};
    try {
      event.sender.send("open-component-gallery", payload);
    } catch (_) {}
    return { ok: true };
  });

  const patternBlocksRoot = path.join(ROOT, "blocks");
  const patternBlocksRootResolved = path.resolve(patternBlocksRoot);

  function resolvePatternBlockDir(dirName) {
    const seg = String(dirName || "").trim();
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(seg)) return null;
    const full = path.resolve(patternBlocksRoot, seg);
    const rel = path.relative(patternBlocksRootResolved, full);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return full;
  }

  function readPatternBlocksIndex() {
    const idxPath = path.join(patternBlocksRoot, "index.json");
    if (!fs.existsSync(idxPath)) return [];
    try {
      const raw = fs.readFileSync(idxPath, "utf-8");
      const j = JSON.parse(raw);
      if (!j || !Array.isArray(j.blocks)) return [];
      return j.blocks;
    } catch (_) {
      return [];
    }
  }

  function resolveContentFileForLocale(blockDirAbs, rel, uiLang) {
    const safeRel = String(rel)
      .replace(/\.\./g, "")
      .replace(/^[/\\]+/, "");
    const fp = path.resolve(blockDirAbs, safeRel);
    const relToBlock = path.relative(blockDirAbs, fp);
    if (
      !relToBlock ||
      relToBlock.startsWith("..") ||
      path.isAbsolute(relToBlock)
    )
      return { error: "invalid_content_path" };
    if (uiLang === "en") {
      const ext = path.extname(safeRel);
      if (ext) {
        const base = safeRel.slice(0, -ext.length);
        const enRel = `${base}.en${ext}`;
        const enFp = path.resolve(blockDirAbs, enRel);
        const enRelTo = path.relative(blockDirAbs, enFp);
        if (
          enRelTo &&
          !enRelTo.startsWith("..") &&
          !path.isAbsolute(enRelTo) &&
          fs.existsSync(enFp)
        ) {
          return { path: enFp };
        }
      }
    }
    if (!fs.existsSync(fp)) return { error: "missing_content_file" };
    return { path: fp };
  }

  function resolvePatternInsertions(blockDirAbs, insertions, uiLang) {
    const lang = uiLang === "en" ? "en" : "tr";
    const out = [];
    for (const ins of insertions || []) {
      if (!ins || ins.type !== "html-fragment") continue;
      let text = "";
      if (typeof ins.content === "string") text = ins.content;
      else if (ins.contentFile) {
        const safeRel = String(ins.contentFile)
          .replace(/\.\./g, "")
          .replace(/^[/\\]+/, "");
        const resolved = resolveContentFileForLocale(
          blockDirAbs,
          ins.contentFile,
          lang,
        );
        if (resolved.error) return { error: resolved.error };
        text = fs.readFileSync(resolved.path, "utf-8");
        if (!String(text).trim() && safeRel) {
          const defaultFp = path.resolve(blockDirAbs, safeRel);
          const relToBlock = path.relative(blockDirAbs, defaultFp);
          if (
            relToBlock &&
            !relToBlock.startsWith("..") &&
            !path.isAbsolute(relToBlock) &&
            fs.existsSync(defaultFp)
          ) {
            const fallback = fs.readFileSync(defaultFp, "utf-8");
            if (String(fallback).trim()) text = fallback;
          }
        }
      } else return { error: "insertion_needs_content" };
      if (!String(text).trim()) continue;
      out.push({
        type: ins.type,
        target: ins.target,
        content: text,
      });
    }
    if (out.length === 0) return { error: "no_valid_insertions" };
    return { insertions: out };
  }

  ipcMain.handle("list-pattern-blocks", async () => {
    try {
      if (!fs.existsSync(patternBlocksRoot)) return { blocks: [] };
      const entries = readPatternBlocksIndex();
      const blocks = [];
      for (const ent of entries) {
        const id = ent && ent.id;
        const dir = ent && ent.dir;
        if (!id || !dir) continue;
        const blockDirAbs = resolvePatternBlockDir(dir);
        if (!blockDirAbs) continue;
        const manifestPath = path.join(blockDirAbs, "block.json");
        if (!fs.existsSync(manifestPath)) continue;
        let manifest;
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        } catch (_) {
          continue;
        }
        if (!manifest || manifest.id !== id) continue;
        blocks.push({
          id: manifest.id,
          version: manifest.version,
          title: manifest.title || {},
          description: manifest.description || {},
          tags: Array.isArray(manifest.tags) ? manifest.tags : [],
          category: manifest.category || "other",
          dependencies: Array.isArray(manifest.dependencies)
            ? manifest.dependencies
            : [],
          learningNotesKey: manifest.learningNotesKey || "",
        });
      }
      return { blocks };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle("get-pattern-block", async (e, blockId, uiLang) => {
    try {
      const id = String(blockId || "").trim();
      if (!id) return { error: "missing_id" };
      const lang = uiLang === "en" ? "en" : "tr";
      const entries = readPatternBlocksIndex();
      const ent = entries.find((x) => x && x.id === id);
      if (!ent || !ent.dir) return { error: "not_found" };
      const blockDirAbs = resolvePatternBlockDir(ent.dir);
      if (!blockDirAbs) return { error: "not_found" };
      const manifestPath = path.join(blockDirAbs, "block.json");
      if (!fs.existsSync(manifestPath)) return { error: "not_found" };
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      } catch (err) {
        return { error: err.message };
      }
      if (!manifest || manifest.id !== id) return { error: "not_found" };
      const ins = Array.isArray(manifest.insertions) ? manifest.insertions : [];
      const resolved = resolvePatternInsertions(blockDirAbs, ins, lang);
      if (resolved.error) return { error: resolved.error };
      const outlineKeys = Array.isArray(manifest.learningOutlineKeys)
        ? manifest.learningOutlineKeys.filter(
            (k) => typeof k === "string" && k.trim(),
          )
        : [];
      const docRefs = Array.isArray(manifest.docRefs)
        ? manifest.docRefs.filter(
            (r) =>
              r &&
              typeof r.relPath === "string" &&
              r.relPath.trim() &&
              typeof r.labelKey === "string" &&
              r.labelKey.trim(),
          )
        : [];
      return {
        block: {
          id: manifest.id,
          version: manifest.version,
          title: manifest.title || {},
          description: manifest.description || {},
          tags: Array.isArray(manifest.tags) ? manifest.tags : [],
          category: manifest.category || "other",
          dependencies: Array.isArray(manifest.dependencies)
            ? manifest.dependencies
            : [],
          learningNotesKey: manifest.learningNotesKey || "",
          learningOutlineKeys: outlineKeys,
          docRefs,
          insertions: resolved.insertions,
        },
      };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle("read-bundled-doc", async (e, relPath) => {
    try {
      const raw = String(relPath || "")
        .trim()
        .replace(/\\/g, "/");
      if (!raw || raw.includes("..")) return { error: "invalid_path" };
      if (!/^docs\/(?:[\w-]+\/)*[\w.-]+\.(?:md|txt)$/i.test(raw))
        return { error: "invalid_path" };
      const full = path.resolve(path.join(__dirname, raw));
      const root = path.resolve(__dirname);
      if (!full.startsWith(root + path.sep)) return { error: "invalid_path" };
      if (!fs.existsSync(full) || !fs.statSync(full).isFile())
        return { error: "not_found" };
      const content = fs.readFileSync(full, "utf-8");
      return { path: full, content };
    } catch (err) {
      return { error: err.message };
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

  /**
   * Düz Node çalıştırma — inspector yok; stdout/stderr anında renderer’a (`run-node-live-stream`).
   * Terminal Çalıştır bu yolu kullanır (canlı `console.log`).
   */
  ipcMain.handle("run-node-live", async (e, filePath) => {
    if (!projectRoot || typeof filePath !== "string" || !filePath.trim()) {
      return { error: "no-project" };
    }
    disposeNodeLiveRun();
    disposeNodeDebugSession();

    const resolved = path.resolve(normalizePath(filePath.trim()));
    if (!resolved.startsWith(projectRoot)) return { error: "forbidden" };
    const ext = path.extname(resolved).toLowerCase();
    if (ext !== ".js" && ext !== ".mjs" && ext !== ".cjs") {
      return { error: "not-js" };
    }
    if (!fs.existsSync(resolved)) return { error: "not-found" };

    const sender = e.sender;
    const forwardStream = (stream, chunk) => {
      try {
        if (sender && !sender.isDestroyed()) {
          sender.send("run-node-live-stream", { stream, chunk });
        }
      } catch (_) {}
    };

    const child = spawn("node", [resolved], {
      cwd: projectRoot,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    nodeLiveRunSession = { child, sender };

    child.stderr.on("data", (d) => forwardStream("stderr", d.toString()));
    child.stdout.on("data", (d) => forwardStream("stdout", d.toString()));
    child.on("close", (code) => {
      if (!nodeLiveRunSession || nodeLiveRunSession.child !== child) return;
      const endSender = nodeLiveRunSession.sender;
      nodeLiveRunSession = null;
      try {
        if (endSender && !endSender.isDestroyed()) {
          endSender.send("run-node-live-ended", {
            code: code == null ? null : code,
          });
        }
      } catch (_) {}
    });
    child.on("error", (err) => {
      if (!nodeLiveRunSession || nodeLiveRunSession.child !== child) return;
      const endSender = nodeLiveRunSession.sender;
      nodeLiveRunSession = null;
      try {
        if (endSender && !endSender.isDestroyed()) {
          endSender.send("run-node-live-ended", {
            code: null,
            error: err.message || "spawn-failed",
          });
        }
      } catch (_) {}
    });

    return { ok: true, pid: child.pid, filePath: resolved };
  });

  /**
   * Debugger Faz 1–2: inspect-brk, CDP, setBreakpointByUrl, Debugger.paused/resumed olayları.
   */
  ipcMain.handle("debug-node-start", async (e, filePath, opts) => {
    if (!qubytNodeInspectorEnabled()) {
      return { error: "inspector-disabled" };
    }
    if (!projectRoot || typeof filePath !== "string" || !filePath.trim()) {
      return { error: "no-project" };
    }
    disposeNodeLiveRun();
    disposeNodeDebugSession();

    const o = opts && typeof opts === "object" ? opts : {};
    const breakpointLinesRaw = Array.isArray(o.breakpointLines)
      ? o.breakpointLines
      : [];
    const breakpointLines = [
      ...new Set(
        breakpointLinesRaw
          .map((n) => parseInt(n, 10))
          .filter((n) => Number.isFinite(n) && n > 0),
      ),
    ].sort((a, b) => a - b);

    const resolved = path.resolve(normalizePath(filePath.trim()));
    const rootNorm = path.resolve(normalizePath(projectRoot));
    const relToRoot = path.relative(rootNorm, resolved);
    if (
      relToRoot.startsWith("..") ||
      (path.isAbsolute(relToRoot) && process.platform === "win32")
    ) {
      return { error: "debug-outside-project" };
    }
    const ext = path.extname(resolved).toLowerCase();
    if (ext !== ".js" && ext !== ".mjs" && ext !== ".cjs") {
      return { error: "not-js" };
    }
    if (!fs.existsSync(resolved)) return { error: "not-found" };

    let port;
    try {
      port = await findFreePortLocalhost();
    } catch (err) {
      return { error: err.message || "no-port" };
    }

    const sender = e.sender;
    const forwardStream = (stream, chunk) => {
      try {
        if (sender && !sender.isDestroyed()) {
          sender.send("debug-node-stream", { stream, chunk });
        }
      } catch (_) {}
    };

    const scriptUrlById = new Map();
    const cdpPending = new Map();
    let cdpNextId = 0;

    const child = spawn("node", [`--inspect-brk=127.0.0.1:${port}`, resolved], {
      cwd: projectRoot,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    /* close: stdio kapandıktan sonra (Windows’ta exit ile stdout’un sonu kesilebiliyordu). */
    child.on("close", (code) => {
      if (nodeDebugSession && nodeDebugSession.child === child) {
        const endSender = nodeDebugSession.sender;
        try {
          if (endSender && !endSender.isDestroyed()) {
            endSender.send("debug-node-session-ended", {
              code: code == null ? null : code,
            });
          }
        } catch (_) {}
        disposeNodeDebugSession();
      }
    });

    let stderrBuf = "";
    child.stderr.on("data", (d) => {
      const t = d.toString();
      stderrBuf += t;
      forwardStream("stderr", t);
    });
    child.stdout.on("data", (d) => forwardStream("stdout", d.toString()));

    let ws = null;
    /* inspect-brk ilk duraklaması hemen Debugger.resume ile kalkıyor; bu paused'ı UI'a göndermeyiz
     * (aksi halde DEBUG dolar, ardından resumed ile silinir — breakpoint duraklaması kaçırılmış gibi görünür). */
    let forwardDebuggerPausedToRenderer = false;

    function cdpSend(method, params) {
      const id = ++cdpNextId;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cdpPending.delete(id);
          reject(new Error("cdp-timeout: " + method));
        }, 25000);
        cdpPending.set(id, { resolve, reject, timeout });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
      });
    }

    try {
      const wsUrl = await waitForNodeInspectorWsUrl(port, Date.now() + 12000);
      ws = new WebSocket(wsUrl);
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("ws-open-timeout")), 10000);
        ws.once("open", () => {
          clearTimeout(t);
          resolve();
        });
        ws.once("error", (err) => {
          clearTimeout(t);
          reject(err);
        });
      });

      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch (_) {
          return;
        }
        if (msg.method === "Debugger.scriptParsed") {
          const p = msg.params;
          if (p && p.scriptId && p.url) scriptUrlById.set(p.scriptId, p.url);
          return;
        }
        if (msg.method === "Runtime.consoleAPICalled") {
          try {
            const line = formatRuntimeConsoleApiCalledLine(msg.params);
            if (line) forwardStream("stdout", line + "\n");
          } catch (_) {}
          return;
        }
        if (msg.method === "Debugger.paused") {
          if (!forwardDebuggerPausedToRenderer) {
            return;
          }
          if (nodeDebugSession && nodeDebugSession.sender === sender) {
            if (nodeDebugSession.resumeUiTimer) {
              clearTimeout(nodeDebugSession.resumeUiTimer);
              nodeDebugSession.resumeUiTimer = null;
            }
            nodeDebugSession.pauseGeneration =
              (nodeDebugSession.pauseGeneration || 0) + 1;
          }
          if (nodeDebugSession && nodeDebugSession.pauseUiFallbackTimer) {
            clearTimeout(nodeDebugSession.pauseUiFallbackTimer);
            nodeDebugSession.pauseUiFallbackTimer = null;
          }
          void enrichAndSendNodePaused(
            msg.params,
            sender,
            scriptUrlById,
            cdpSend,
          ).catch(() => {
            sendFallbackDebugNodePaused(sender, msg.params, scriptUrlById);
          });
          return;
        }
        if (msg.method === "Debugger.resumed") {
          try {
            const sess = nodeDebugSession;
            /* inspect-brk sonrası Node birden fazla `resumed` üretebiliyor; ilki kullanıcı duraklamasından
             * önce bile `debug-node-paused` sonrası gecikmeli gelip DEBUG’i siliyordu. Yalnızca en az bir
             * `debug-node-paused` gönderildikten sonra resumed ilet. */
            if (
              !sess ||
              sess.sender !== sender ||
              !sess.pauseReportedToRenderer
            ) {
              return;
            }
            /* Adım (step) sırasında: resumed hemen ardından yeni Debugger.paused gelir. Gecikmiş veya
             * sıra dışı bir resumed, yeni durak verisi renderer’a ulaştıktan sonra debug-node-resumed
             * gönderip DEBUG sekmesini ve yığını boşaltıyordu. pauseGeneration + kısa debounce: yeni
             * paused gelince zamanlayıcı iptal; yalnızca “gerçekten çalışmaya devam” kısmında IPC gider. */
            if (sess.resumeUiTimer) {
              clearTimeout(sess.resumeUiTimer);
              sess.resumeUiTimer = null;
            }
            const genAtResume = sess.pauseGeneration || 0;
            sess.resumeUiTimer = setTimeout(() => {
              sess.resumeUiTimer = null;
              if (!nodeDebugSession || nodeDebugSession !== sess) return;
              if ((sess.pauseGeneration || 0) !== genAtResume) return;
              if (sess.sender && !sess.sender.isDestroyed()) {
                sess.sender.send("debug-node-resumed");
              }
            }, 40);
          } catch (_) {}
          return;
        }
        if (msg.id != null && cdpPending.has(msg.id)) {
          const p = cdpPending.get(msg.id);
          clearTimeout(p.timeout);
          cdpPending.delete(msg.id);
          if (msg.error) {
            p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            p.resolve(msg.result);
          }
        }
      });

      await cdpSend("Runtime.enable", {});
      await cdpSend("Debugger.enable", {});

      const fileHrefVariants = fileUrlVariantsForDebugger(resolved);
      const baseRx = path
        .basename(resolved)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const urlRegexFallback = `.*[/\\\\]${baseRx}$`;
      /** CDP’de gerçekten kayıtlı satırlar (istenen glyph sayısından az olabilir — yol/url uyuşmazlığı). */
      const boundBreakpointLines = new Set();

      for (const lineOneBased of breakpointLines) {
        let placed = false;
        for (let vi = 0; vi < fileHrefVariants.length && !placed; vi++) {
          try {
            const br = await cdpSend("Debugger.setBreakpointByUrl", {
              url: fileHrefVariants[vi],
              lineNumber: lineOneBased - 1,
              columnNumber: 0,
            });
            if (cdpBreakpointAccepted(br)) {
              placed = true;
              boundBreakpointLines.add(lineOneBased);
            }
          } catch (_) {
            /* denenecek diğer URL veya urlRegex */
          }
        }
        if (!placed) {
          try {
            const brx = await cdpSend("Debugger.setBreakpointByUrl", {
              urlRegex: urlRegexFallback,
              lineNumber: lineOneBased - 1,
              columnNumber: 0,
            });
            if (cdpBreakpointAccepted(brx)) {
              placed = true;
              boundBreakpointLines.add(lineOneBased);
            }
          } catch (_) {}
        }
      }

      /* inspect-brk: kullanıcı betiği scriptParsed ile gelene kadar bekle; scriptId + satır en güvenilir. */
      async function applyBreakpointsWhenScriptIdKnown() {
        const maxMs = 3200;
        const step = 30;
        let waited = 0;
        while (waited <= maxMs && breakpointLines.length > 0) {
          const sid = scriptIdForResolvedScript(scriptUrlById, resolved);
          if (sid) {
            for (const lineOneBased of breakpointLines) {
              try {
                await cdpSend("Debugger.setBreakpoint", {
                  location: {
                    scriptId: sid,
                    lineNumber: lineOneBased - 1,
                    columnNumber: 0,
                  },
                });
                boundBreakpointLines.add(lineOneBased);
              } catch (_) {}
            }
            return;
          }
          await new Promise((r) => setTimeout(r, step));
          waited += step;
        }
      }
      if (breakpointLines.length > 0) {
        await applyBreakpointsWhenScriptIdKnown();
      }

      /* inspect-brk ilk Debugger.paused zaten yukarıda flag=false ile düşürüldü.
       * Kısa betiklerde `debugger;` veya hemen tetiklenen breakpoint, Resume CDP *yanıtı*
       * gelmeden önce ikinci Debugger.paused olarak gelebilir; bayrağı yalnızca finally'de
       * açmak bu duraklamayı yanlışlıkla yutardı (DEBUG boş kalırdı). */
      forwardDebuggerPausedToRenderer = true;

      nodeDebugSession = {
        child,
        ws,
        port,
        filePath: resolved,
        cdpPending,
        scriptUrlById,
        cdpSend,
        sender,
        startedAt: Date.now(),
        pauseReportedToRenderer: false,
        pauseGeneration: 0,
        resumeUiTimer: null,
        syntheticPauseActive: false,
      };

      /* inspect-brk genelde ilk satırda duraklar; nadiren bağlantı gecikmesiyle VM
       * zaten çalışıyorsa Debugger.resume CDP hatası verir — oturumu yine kur. */
      try {
        await cdpSend("Debugger.resume", {});
      } catch (resumeErr) {
        const rmsg =
          resumeErr && resumeErr.message ? String(resumeErr.message) : "";
        if (
          !/can only perform operation while paused/i.test(rmsg) &&
          !/while paused/i.test(rmsg)
        ) {
          throw resumeErr;
        }
      }

      return {
        ok: true,
        port,
        pid: child.pid,
        filePath: resolved,
        breakpointsApplied: breakpointLines.length,
        breakpointsBound: boundBreakpointLines.size,
        message:
          breakpointLines.length > 0
            ? boundBreakpointLines.size > 0
              ? "Inspector bağlı; breakpoint(ler) CDP’ye bağlandı. Durunca DEBUG + terminal + satır vurgusu."
              : "Inspector bağlı; glyph satırları CDP’ye bağlanamadı (yol eşleşmesi?). `debugger;` veya satırı kontrol edin."
            : "Inspector bağlı; betik çalışıyor (breakpoint yok).",
      };
    } catch (err) {
      try {
        if (nodeDebugSession && nodeDebugSession.child === child) {
          disposeNodeDebugSession();
        } else {
          for (const [, p] of cdpPending) clearTimeout(p.timeout);
          cdpPending.clear();
          if (ws) ws.close();
          if (child && !child.killed) child.kill("SIGTERM");
        }
      } catch (_) {}
      return {
        error: err.message || "debug-start-failed",
        stderr: stderrBuf.trim().slice(0, 4000),
      };
    }
  });

  ipcMain.handle("debug-node-stop", async () => {
    if (!qubytNodeInspectorEnabled()) {
      return { error: "inspector-disabled" };
    }
    disposeNodeDebugSession();
    return { ok: true };
  });

  ipcMain.handle("debug-node-continue", async () => {
    if (!qubytNodeInspectorEnabled()) {
      return { error: "inspector-disabled" };
    }
    return nodeDebugCdpCommand("Debugger.resume", {});
  });

  ipcMain.handle("debug-node-pause", async () => {
    if (!qubytNodeInspectorEnabled()) {
      return { error: "inspector-disabled" };
    }
    const r = await nodeDebugCdpCommand("Debugger.pause", {});
    if (r.error) return r;
    const sess = nodeDebugSession;
    if (!sess || !sess.sender || sess.sender.isDestroyed()) return r;
    /* Betik senkron kısmı bitmiş, yalnızca `setTimeout`/event loop boştayken `Debugger.pause`
     * CDP başarılı olsa bile `Debugger.paused` gecikmeyebilir veya hiç gelmeyebilir — UI durak
     * görmez (Adım/Devam kapalı kalır). Gerçek paused gelirse zamanlayıcı iptal edilir. */
    try {
      if (sess.pauseUiFallbackTimer) {
        clearTimeout(sess.pauseUiFallbackTimer);
        sess.pauseUiFallbackTimer = null;
      }
      sess.pauseUiFallbackTimer = setTimeout(() => {
        sess.pauseUiFallbackTimer = null;
        if (!nodeDebugSession || nodeDebugSession !== sess) return;
        if (sess.sender && !sess.sender.isDestroyed()) {
          sendSyntheticPausedPayload(
            sess.sender,
            { reason: "other" },
            "(pause-fallback-idle)",
            { steppingDisabled: true },
          );
        }
      }, 500);
    } catch (_) {}
    return r;
  });

  ipcMain.handle("debug-node-step-over", async () => {
    if (!qubytNodeInspectorEnabled()) {
      return { error: "inspector-disabled" };
    }
    return nodeDebugCdpCommand("Debugger.stepOver", {});
  });

  ipcMain.handle("debug-node-step-into", async () => {
    if (!qubytNodeInspectorEnabled()) {
      return { error: "inspector-disabled" };
    }
    return nodeDebugCdpCommand("Debugger.stepInto", {});
  });

  ipcMain.handle("debug-node-step-out", async () => {
    if (!qubytNodeInspectorEnabled()) {
      return { error: "inspector-disabled" };
    }
    return nodeDebugCdpCommand("Debugger.stepOut", {});
  });

  ipcMain.handle("debug-node-status", async () => {
    if (!qubytNodeInspectorEnabled()) {
      return { active: false };
    }
    if (!nodeDebugSession) {
      return { active: false };
    }
    const startedAt = nodeDebugSession.startedAt || 0;
    return {
      active: true,
      pid: nodeDebugSession.child ? nodeDebugSession.child.pid : null,
      port: nodeDebugSession.port,
      filePath: nodeDebugSession.filePath,
      uptimeMs: startedAt ? Date.now() - startedAt : null,
    };
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
      let scriptPath = parts[0];
      if (!scriptPath) return { error: "node-dosya-gerekli" };
      scriptPath = scriptPath.replace(/^["']|["']$/g, "");
      const norm = normalizePath(scriptPath);
      const resolved = path.isAbsolute(norm)
        ? path.resolve(norm)
        : path.resolve(projectRoot, norm);
      let underRoot = resolved.startsWith(projectRoot);
      if (
        !underRoot &&
        process.platform === "win32" &&
        projectRoot &&
        typeof projectRoot === "string"
      ) {
        const rl = resolved.toLowerCase();
        const pl = path.resolve(normalizePath(projectRoot)).toLowerCase();
        underRoot =
          rl === pl || rl.startsWith(pl + path.sep) || rl.startsWith(pl + "/");
      }
      if (!underRoot) return { error: "forbidden" };
      const ext = path.extname(resolved).toLowerCase();
      if (ext !== ".js" && ext !== ".mjs") return { error: "node-sadece-js" };
      if (!fs.existsSync(resolved)) return { error: "not-found" };
      if (
        nodeDebugSession &&
        nodeDebugSession.filePath &&
        debuggerPathsSameFile(resolved, nodeDebugSession.filePath)
      ) {
        return { error: "node-debug-conflict" };
      }
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
    if (!staticServerIpcRegistered) {
      staticServerIpcRegistered = true;
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
      ipcMain.handle(
        "open-folder-in-new-window-at-path",
        async (e, dirPath) => {
          const resolved = path.resolve(normalizePath(dirPath));
          if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory())
            return { ok: false };
          createWindow(activePort, resolved);
          return { ok: true };
        },
      );
      const folderFromArgv = getFolderFromArgv();
      runApp(port, folderFromArgv);
    }
  });
});

app.on("will-quit", () => {
  disposeNodeLiveRun();
  disposeNodeDebugSession();
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
