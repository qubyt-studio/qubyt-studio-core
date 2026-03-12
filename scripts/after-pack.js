/**
 * electron-builder afterPack hook: win-unpacked oluşturulduktan sonra,
 * NSIS/portable paketlenmeden önce exe'ye özel ikonu uygular.
 * Böylece kurulumcu ve portable exe Qubyt Studio logosu ile çıkar.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

module.exports = async function (context) {
  if (context.electronPlatformName !== "win32") return;

  const appOutDir = context.appOutDir;
  const productFilename = context.packager.appInfo.productFilename;
  const exeName = productFilename.endsWith(".exe")
    ? productFilename
    : productFilename + ".exe";
  const exePath = path.join(appOutDir, exeName);

  if (!fs.existsSync(exePath)) {
    console.warn("[afterPack] Exe bulunamadi:", exePath);
    return;
  }

  const ROOT = path.join(__dirname, "..");
  const ICON_ICO = path.join(ROOT, "build", "icon.ico");

  if (!fs.existsSync(ICON_ICO)) {
    console.warn("[afterPack] build/icon.ico yok, ikon atlanıyor.");
    return;
  }

  const iconPath = path.resolve(ICON_ICO);
  const rceditBin = path.join(
    ROOT,
    "node_modules",
    "rcedit",
    "bin",
    process.arch === "x64" ? "rcedit-x64.exe" : "rcedit.exe",
  );

  if (fs.existsSync(rceditBin)) {
    const sub = spawnSync(rceditBin, [exePath, "--set-icon", iconPath], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (sub.status === 0) {
      console.log("[afterPack] Exe ikonu uygulandi:", exeName);
    } else if (sub.stderr) {
      console.warn("[afterPack] rcedit uyari:", sub.stderr.trim());
    }
  } else {
    try {
      const rcedit = require("rcedit");
      await rcedit(exePath, { icon: iconPath });
      console.log("[afterPack] Exe ikonu uygulandi:", exeName);
    } catch (e) {
      console.warn("[afterPack] rcedit hatasi:", e.message);
    }
  }
};
