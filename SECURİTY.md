# Güvenlik — Qubyt Studio

> ✓ **Güncel** — Bu belge v1.1.5 (Mart 2026) itibarıyla mevcut kod tabanıyla uyumludur.

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

v1.1.5 kurulum dosyası (Qubyt Studio 1.1.5.exe) tarandı: [VirusTotal Raporu](https://www.virustotal.com/gui/file/bb85d4774fcec6659f9851d317b504c9f537472c14c5d78f6425927e95f81096) — SHA-256: `bb85d4774fcec6659f9851d317b504c9f537472c14c5d78f6425927e95f81096`

## Bağımlılıklar

- `npm audit` ile bağımlılık uyarılarını periyodik kontrol edin.
- Güncellemelerde `package.json` sürümlerini ve Electron/Monaco güvenlik notlarını takip edin.

---

_Son güncelleme: Mart 2026 (v1.1.5)_
