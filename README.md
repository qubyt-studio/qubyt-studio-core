# 🚀 Qubyt Studio: Modern Code Editor

![License](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/badge/version-1.1.8-blue)
![VirusTotal](https://img.shields.io/badge/VirusTotal-Verified_Clean-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)

> ✓ **Güncel** — Bu README v1.1.8 (Mart 2026) itibarıyla proje durumunu yansıtmaktadır.

Qubyt Studio, web geliştirme için tasarlanmış masaüstü bir kod editörüdür. Monaco editör çekirdeği, Emmet ve ESLint entegrasyonu ile HTML, CSS, JavaScript ve TypeScript için hızlı ve rahat bir geliştirme deneyimi sunar.

## 🌟 Öne Çıkan Özellikler

- **Monaco Editor:** VS Code'un kalbi olan Monaco ile sözdizimi vurgulama, tamamlama ve snippet desteği.
- **Desteklenen diller:** HTML, CSS, JavaScript (.js, .mjs, .cjs), TypeScript (.ts, .tsx), Markdown.
- **Debug Tools:** Insert Log (Ctrl+Shift+L), Insert Warn/Error/Debug, Remove Logs, Toggle Logs, Find Logs.
- **Tema Oluşturucu:** Kendi editör temanızı oluşturup kaydedebilirsiniz.
- **Developer Insights:** Kod yazma istatistikleri, dil kullanımı, aktivite heatmap (son 12 hafta).
- **Markup & Style Analyzer:** HTML/CSS için kullanılmayan sınıf, tanımsız sınıf, eksik alt, geçersiz property (deneysel).
- **ESLint:** Otomatik lint, genişletilmiş kurallar (boş fonksiyon, unreachable, kullanılmayan parametre), Problems/Warnings.
- **Sunum modu:** Ctrl+Shift+P ile kod odaklı tam ekran.
- **Emmet:** HTML ve CSS için hızlı snippet genişletme.
- **Terminal:** npm, npx, node komutları; yerel sunucu ile tarayıcı önizleme.
- **Live Page:** HTML/CSS kaydedilince anlık canlı önizleme; Layout Inspector ile önizlemede elemente tıklayıp stil özelliklerini panelden düzenleme.

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
- **VirusTotal Raporu:** [Qubyt Studio 1.1.8.exe](https://www.virustotal.com/gui/file/3347c7e6a78598487db4e0c8d08bd33195041ec30af216fedba25a278b33639c/details) — SHA-256: `3347c7e6...639c`

## 🛠️ Teknolojiler

- **Electron** 40
- **Monaco Editor** 0.48
- **Emmet** 2.4
- **ESLint** 8.57
- **esbuild** 0.24

## 📜 Değişiklik Geçmişi

| Sürüm      | Özet                                                                                                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **v1.1.8** | Shoelace öznitelik tamamlamaları; Kütüphaneler modalı (genişlik, tipografi, kartlarda “Sınırlar”); HTML `<style>` içinde Qubyt HTML/CDN/path önerilerinin kapatılması; Chart.js (snippet, `Chart.`, örnek sayfa); `docs/html-embedded-completion-test.html`; starter types ve dokümantasyon güncellemeleri. |
| **v1.1.7** | Desteklenen Kütüphaneler — Alpine.js, htmx, Lodash, dayjs, Axios, Chart.js, Shoelace tamamlama ve snippet. x-, @, hx- attribute tamamlamaları; hx-swap/hx-trigger değer önerileri; alpine, htmx, lodash, axios, chart, dayjs, shoelace Emmet; HTML’de &lt;sl-*&gt; etiket tamamlamaları; Chart. (UMD) tamamlamaları. |
| **v1.1.6** | i18n (TR/EN dil desteği). Tab sürükle-bırak ile sıralama. Monaco üst mavi çizgi kaldırma. Explorer'dan editöre dosya sürükle-bırak.                                                                      |
| **v1.1.5** | LSP Faz 6: JSON Language Server (package.json, tsconfig.json vb.). Error recovery (server çökmesinde otomatik yeniden başlatma). LSP bağlantı düzeltmesi (editor-ready race condition).                  |
| **v1.1.4** | Kaydedilmemiş değişiklik uyarısı (uygulama kapatılırken). Explorer'da ana klasör adı başlıkta. CSS Builder paneli. Live Page ve Markup & Style Analyzer @import desteği.                                 |
| **v1.1.3** | Project Map sistemi (dosya yapısı, Import Graph, Component Graph). Status bar ve Hakkında penceresinden "Powered by Electron" kaldırıldı.                                                                |
| **v1.1.2** | Terminal panel tab geçişi düzeltmesi (TERMINAL, PROBLEMS, WARNINGS tab'ları her zaman tıklanabilir).                                                                                                     |
| **v1.1.0** | Live Page — anlık canlı önizleme; Layout Inspector ile önizlemede elemente tıklayıp stil özelliklerini panelden düzenleme; değişiklikler CSS dosyasına yazılır. Markup & Style Analyzer iyileştirmeleri. |
| **v1.0.9** | Markup & Style Analyzer, ESLint genişletmesi, Sunum modu (Ctrl+Shift+P), Aktivite heatmap.                                                                                                               |
| **v1.0.8** | Not Sistemi, Debug Tools, Markdown önizleme (Mermaid, görev listeleri), Developer Insights dashboard.                                                                                                    |

## 🌐 Ekosistemimiz

- **ByteOmi:** Algoritma analizi ve bellek yönetimi görselleştirme.
- **Softyla:** Yazılım eğitimi ve mimari odaklı içerik platformu.

## 💬 Destek / Support

Shopier üzerinden satın alan kullanıcılarımız için destek sayfası: **[Shopier — Qubyt Studio](https://www.shopier.com/qubytstudio)**  
Sipariş, teknik destek ve güncelleme sorularınız için buradan ulaşabilirsiniz.

## 📩 İletişim

Geri bildirim ve güvenlik bildirimi: **qubytstudio@gmail.com**

---

© 2026 Qubyt Studio. MIT License.
