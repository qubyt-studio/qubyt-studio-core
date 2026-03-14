# 🚀 Qubyt Studio: Modern Code Editor

![License](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/badge/version-1.0.8-blue)
![VirusTotal](https://img.shields.io/badge/VirusTotal-Verified_Clean-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)

> ✓ **Güncel** — Bu README v1.0.8 (Mart 2026) itibarıyla proje durumunu yansıtmaktadır.

Qubyt Studio, web geliştirme için tasarlanmış masaüstü bir kod editörüdür. Monaco editör çekirdeği, Emmet ve ESLint entegrasyonu ile HTML, CSS, JavaScript ve TypeScript için hızlı ve rahat bir geliştirme deneyimi sunar.

## 🌟 Öne Çıkan Özellikler

- **Monaco Editor:** VS Code'un kalbi olan Monaco ile sözdizimi vurgulama, tamamlama ve snippet desteği.
- **Desteklenen diller:** HTML, CSS, JavaScript (.js, .mjs, .cjs), TypeScript (.ts, .tsx).
- **Debug Tools:** Insert Log (Ctrl+Shift+L), Insert Warn/Error/Debug, Remove Logs, Toggle Logs, Find Logs — Turbo Console Log benzeri özellikler.
- **Tema Oluşturucu:** Kendi editör temanızı oluşturup kaydedebilirsiniz.
- **Developer Insights:** Kod yazma istatistikleri, dil kullanımı ve aktivite takibi (yerel, gizlilik odaklı).
- **ESLint entegrasyonu:** JavaScript dosyalarında otomatik lint ve Problems/Warnings panelleri.
- **Emmet:** HTML ve CSS için hızlı snippet genişletme.
- **Terminal:** npm, npx, node komutları; yerel sunucu ile tarayıcı önizleme.

## 📋 Gereksinimler

- **Node.js** 18+ (geliştirme için)
- **npm** 9+
- **Windows** (mevcut build hedefi)

## 🚀 Yerelde Çalıştırma

```bash
git clone <repo-url>
cd editor-app
npm install
npm start
```

> **Not:** `npm install` sonrası Monaco editör dosyaları otomatik kopyalanır (`postinstall`).

## 📦 Paketleme (Build)

```bash
npm run dist    # NSIS kurulum + portable EXE (dist/ klasörüne)
npm run pack    # Paketleme testi (--dir)
```

## 🏗️ Proje Yapısı

```
├── main.js              # Electron ana süreç, IPC, pencere yönetimi
├── preload.js            # Güvenli IPC köprüsü (context isolation)
├── src/renderer/         # Arayüz: index.html, scripts/, CSS
│   ├── scripts/          # file-tree, editor-init, debug-tools, theme-creator, dev-insights...
│   └── *.css             # Stiller
├── build/                # İkonlar (icon.svg, icon.png, icon.ico)
├── scripts/              # Build betikleri (copy-monaco, svg-to-icon, after-pack...)
├── docs/                 # Raporlar (DEBUG_TOOLS_REPORT, DEV_INSIGHTS_HEATMAP...)
└── SECURITY.md           # Güvenlik detayları
```

## 🛡️ Güvenlik ve Şeffaflık

Projemiz bağımsız bir girişim olduğu için güvenliği en üst sırada tutuyoruz. Sertifika maliyetleri nedeniyle henüz dijital olarak imzalanmamış olsa da, tüm kod tabanımız şeffaf bir şekilde buradadır.

- **Güvenlik Detayları:** [SECURITY.md](./SECURITY.md) — `sandbox`, `contextIsolation`, path doğrulama vb.
- **VirusTotal Raporu:** [Güncel Rapor (v1.0.8)](https://www.virustotal.com/gui/search/qubyt+studio)

## 🛠️ Teknolojiler

- **Electron** 40
- **Monaco Editor** 0.48
- **Emmet** 2.4
- **ESLint** 8.57
- **esbuild** 0.24

## 🌐 Ekosistemimiz

- **ByteOmi:** Algoritma analizi ve bellek yönetimi görselleştirme.
- **Softyla:** Yazılım eğitimi ve mimari odaklı içerik platformu.

## 📩 İletişim

Geri bildirim ve güvenlik bildirimi: **qubytstudio@gmail.com**

---

© 2026 Qubyt Studio. MIT License.
