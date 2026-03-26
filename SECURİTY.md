# Güvenlik — Qubyt Studio

> ✓ **Güncel** — Bu belge v1.2.1 (Mart 2026) itibarıyla mevcut kod tabanıyla uyumludur.

Bu belge, Qubyt Studio editörünün güvenlik önlemlerini ve sizin yapmanız gerekenleri özetler.

## Uygulama içi güvenlik (mevcut)

| Önlem                       | Durum                  | Açıklama                                                                                                                                                                   |
| --------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **contextIsolation**        | Açık                   | Renderer ile main process ayrı; preload üzerinden sadece beyaz listelenmiş API açılıyor.                                                                                   |
| **nodeIntegration**         | Kapalı                 | Renderer tarafında Node.js yok; XSS durumunda dosya sistemi erişimi yok.                                                                                                   |
| **sandbox**                 | Açık                   | Chromium sandbox etkin.                                                                                                                                                    |
| **preload**                 | Sadece `contextBridge` | `editorAPI` sadece gerekli IPC metodlarıyla expose ediliyor (`preload.js`).                                                                                                |
| **Content-Security-Policy** | Var                    | `index.html` içinde CSP meta etiketi: `default-src 'self'`, script/style/font kaynakları kısıtlı. LSP WebSocket yalnızca `ws://127.0.0.1` belirli portlarla (19393–19424). |
| **Statik sunucu**           | 127.0.0.1              | Önizleme ve editör sadece yerel döngüde (`http://127.0.0.1:9292`); path traversal engelli.                                                                                 |
| **LSP WebSocket**           | 127.0.0.1              | LSP server'lar yalnızca localhost'ta dinler; `cwd` proje kökü ile sınırlı, path doğrulama mevcut.                                                                          |

## Önerilen ek önlemler

- **Yayın build’inde DevTools:** `main.js` içinde `webPreferences.devTools: true` kullanılıyor. Canlı/dağıtım build’inde `false` yapılabilir (isteğe bağlı).
- **EXE imzalama:** Şu an `forceCodeSigning: false`. Windows’ta SmartScreen uyarısını azaltmak için ileride kod imzalama (sertifika) düşünülebilir.

## Güvenlik açığı bildirimi

Bir güvenlik açığı fark ederseniz lütfen doğrudan proje sahiplerine (veya açık bir repo ise Issue yerine özel iletişimle) bildirin. Sorunu halka açık Issue’da detaylı anlatmayın.

## VirusTotal

**v1.2.1** NSIS kurulum dosyası için VirusTotal raporu, `npm run dist` ile üretim sonrası eklenecektir.

**v1.2.0** kurulum dosyası (`Qubyt Studio 1.2.0.exe`) VirusTotal üzerinde taranmıştır: [VirusTotal raporu](https://www.virustotal.com/gui/file/953bccd87492075a85e544410e6e4d056d3491adb9ec8631b929a2ed9c3abcb5/details)

### VirusTotal özeti (v1.2.0 — referans)

| Özellik          | Değer                                                                 |
| ---------------- | --------------------------------------------------------------------- |
| **Dosya**        | Qubyt Studio 1.2.0.exe                                                |
| **Boyut**        | 147.73 MB (154905938 bytes)                                           |
| **MD5**          | `6341b31cb63da3af7d15afe5aae51e44`                                    |
| **SHA-1**        | `f2d9dda50b8bb9aa894fe71d943542f38546c7f7`                             |
| **SHA-256**      | `953bccd87492075a85e544410e6e4d056d3491adb9ec8631b929a2ed9c3abcb5`     |
| **Vhash**        | `018056655d1c0550d043z800417z47z62z41fz`                              |
| **Authentihash** | `6ee585bbb065aba7738bdd7834adae7fa6f9525e8b24cbda9c49142e1d6ab6b8`    |
| **Imphash**      | `b34f154ec913d2d2c435cbd644e91687`                                    |
| **Rich PE hash** | `f05a488cd83d3aa2b72c1ddefe58cfce`                                    |
| **SSDEEP**       | `3145728:M2Y5YNVzFpCoHX72phReBVbals5y+AbTrdJg4k7:nYIV570hebaudCYl`    |
| **TLSH**         | `T125783379829A3857C65A5C3D368CDFD0D06A719C4CAEA944EBE702E5DC23CDC4363AB1` |
| **Dosya tipi**   | Win32 EXE — PE32 (GUI), Nullsoft Installer (NSIS) self-extracting    |
| **Ürün / sürüm** | Qubyt Studio 1.2.0                                                    |
| **İmza**         | İmzasız (File is not signed)                                          |
| **İlk gönderim** | 2026-03-22 23:02:24 UTC                                               |
| **Son gönderim** | 2026-03-22 23:02:24 UTC                                               |
| **Son analiz**   | 2026-03-22 23:02:24 UTC                                               |

Raporu doğrulamak için SHA-256 değerini VirusTotal’da arayabilir veya yukarıdaki bağlantıyı kullanabilirsiniz.

## Bağımlılıklar

- `npm audit` ile bağımlılık uyarılarını periyodik kontrol edin.
- Güncellemelerde `package.json` sürümlerini ve Electron/Monaco güvenlik notlarını takip edin.

---

_Son güncelleme: Mart 2026 (v1.2.1)_
