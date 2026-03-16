# 🚀 Qubyt Studio: Modern Code Editor

![License](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/badge/version-1.1.2-blue)
![VirusTotal](https://img.shields.io/badge/VirusTotal-Verified_Clean-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)

> ✓ **Up to date** — This README reflects the project status as of v1.1.2 (March 2026).

Qubyt Studio is a desktop code editor designed for web development. With Monaco editor core, Emmet, and ESLint integration, it provides a fast and comfortable development experience for HTML, CSS, JavaScript, and TypeScript.

## 🌟 Key Features

- **Monaco Editor:** Syntax highlighting, completion, and snippet support powered by Monaco (the heart of VS Code).
- **Supported languages:** HTML, CSS, JavaScript (.js, .mjs, .cjs), TypeScript (.ts, .tsx), Markdown.
- **Debug Tools:** Insert Log (Ctrl+Shift+L), Insert Warn/Error/Debug, Remove Logs, Toggle Logs, Find Logs.
- **Theme Creator:** Create and save your own editor themes.
- **Developer Insights:** Code writing statistics, language usage, activity heatmap (last 12 weeks).
- **Markup & Style Analyzer:** Unused classes, undefined classes, missing alt, invalid properties for HTML/CSS (experimental).
- **ESLint:** Automatic linting, extended rules (empty function, unreachable, unused params), Problems/Warnings panels.
- **Presentation mode:** Ctrl+Shift+P for code-focused full screen.
- **Emmet:** Fast snippet expansion for HTML and CSS.
- **Terminal:** npm, npx, node commands; browser preview with local server.
- **Live Page:** Real-time live preview on HTML/CSS save; Layout Inspector lets you click elements in the preview and edit style properties from the panel.

## 📋 Requirements

- **Node.js** 18+ (for development)
- **npm** 9+
- **Windows** (current build target)

## 🚀 Running Locally

```bash
git clone <repo-url>
cd editor-app
npm install
npm start
```

> **Note:** Monaco editor files are copied automatically after `npm install` (`postinstall`).

## 📦 Packaging (Build)

```bash
npm run dist    # NSIS installer + portable EXE (to dist/ folder)
npm run pack    # Packaging test (--dir)
```

## 🏗️ Project Structure

```
├── main.js              # Electron main process, IPC, window management
├── preload.js           # Secure IPC bridge (context isolation)
├── src/renderer/        # UI: index.html, scripts/, CSS
│   ├── scripts/         # file-tree, editor-init, debug-tools, theme-creator, dev-insights...
│   └── *.css            # Styles
├── build/               # Icons (icon.svg, icon.png, icon.ico)
├── scripts/             # Build scripts (copy-monaco, svg-to-icon, after-pack...)
├── docs/                # Reports (DEBUG_TOOLS_REPORT, DEV_INSIGHTS_HEATMAP...)
└── SECURITY.md          # Security details
```

## 🛡️ Security and Transparency

We prioritize security as an independent project. Although not yet digitally signed due to certificate costs, our entire codebase is transparently available here.

- **Security Details:** [SECURITY.md](./SECURITY.md) — `sandbox`, `contextIsolation`, path validation, etc.
- **VirusTotal Report:** [Qubyt Studio.exe (v1.1.2)](https://www.virustotal.com/gui/file/0bb502b40761b0f44ae1c97d381d2acfdb83b142bad1e5a500cf610554a278b2) — SHA-256: `0bb502b4...a278b2`

## 🛠️ Technologies

- **Electron** 40
- **Monaco Editor** 0.48
- **Emmet** 2.4
- **ESLint** 8.57
- **esbuild** 0.24

## 📜 Changelog

| Version | Summary |
|---------|---------|
| **v1.1.2** | Terminal panel tab switching fix (TERMINAL, PROBLEMS, WARNINGS tabs always clickable). |
| **v1.1.0** | Live Page — real-time live preview; Layout Inspector to click elements in preview and edit style properties from panel; changes written to CSS file. Markup & Style Analyzer improvements. |
| **v1.0.9** | Markup & Style Analyzer, ESLint extension, Presentation mode (Ctrl+Shift+P), Activity heatmap. |
| **v1.0.8** | Note System, Debug Tools, Markdown preview (Mermaid, task lists), Developer Insights dashboard. |

## 🌐 Our Ecosystem

- **ByteOmi:** Algorithm analysis and memory management visualization.
- **Softyla:** Software education and architecture-focused content platform.

## 💬 Support

Support page for customers who purchased via Shopier: **[Shopier — Qubyt Studio](https://www.shopier.com/qubytstudio)**  
For order, technical support, and update inquiries.

## 📩 Contact

Feedback and security reports: **qubytstudio@gmail.com**

---

© 2026 Qubyt Studio. MIT License.
