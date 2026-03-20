# Güvenlik — Qubyt Studio

> ✓ **Güncel** — Bu belge v1.1.7 (Mart 2026) itibarıyla mevcut kod tabanıyla uyumludur.

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

v1.1.7 kurulum dosyası (Qubyt Studio 1.1.7.exe) tarandı: [VirusTotal Raporu](https://www.virustotal.com/gui/file/e42ce8be0f97950429b048b3afe57d5cbbe588a2d5251c28fdb9db76af7ecdbc/details)

### VirusTotal Details (v1.1.7)

| Özellik          | Değer                                                              |
| ---------------- | ------------------------------------------------------------------ |
| **Dosya**        | Qubyt Studio 1.1.7.exe                                             |
| **Boyut**        | 147.63 MB (154801206 bytes)                                        |
| **MD5**          | `9c67c3d751d6aaef9f6ae1136fa9cb8a`                                 |
| **SHA-1**        | `f8da3d37221159481062e755a15ffd1ec9cb9000`                         |
| **SHA-256**      | `e42ce8be0f97950429b048b3afe57d5cbbe588a2d5251c28fdb9db76af7ecdbc` |
| **Imphash**      | `b34f154ec913d2d2c435cbd644e91687`                                 |
| **Dosya tipi**   | Win32 EXE (PE32 executable, Nullsoft Installer)                    |
| **İmza**         | İmzasız (File is not signed)                                       |
| **İlk gönderim** | 2026-03-20 22:37:59 UTC                                            |

## Bağımlılıklar

- `npm audit` ile bağımlılık uyarılarını periyodik kontrol edin.
- Güncellemelerde `package.json` sürümlerini ve Electron/Monaco güvenlik notlarını takip edin.

---

_Son güncelleme: Mart 2026 (v1.1.7)_
