# Güvenlik — Qubyt Studio

> ✓ **Güncel** — Bu belge v1.1.8 (Mart 2026) itibarıyla mevcut kod tabanıyla uyumludur.

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

v1.1.8 kurulum dosyası (Qubyt Studio 1.1.8.exe) tarandı: [VirusTotal Raporu](https://www.virustotal.com/gui/file/3347c7e6a78598487db4e0c8d08bd33195041ec30af216fedba25a278b33639c/details)

### VirusTotal Details (v1.1.8)

| Özellik          | Değer                                                              |
| ---------------- | ------------------------------------------------------------------ |
| **Dosya**        | Qubyt Studio 1.1.8.exe                                             |
| **Boyut**        | 147.64 MB (154810170 bytes)                                        |
| **MD5**          | `4f17f862ed4fe832afd19865aec8029e`                                 |
| **SHA-1**        | `86227e69ddd25e5d303504933329e6da45bae607`                         |
| **SHA-256**      | `3347c7e6a78598487db4e0c8d08bd33195041ec30af216fedba25a278b33639c` |
| **Authentihash** | `4a517521b27d79fa0bcd71670712187da4678a6ef89f1a392e5f9cb0d283feb0` |
| **Imphash**      | `b34f154ec913d2d2c435cbd644e91687`                                 |
| **Dosya tipi**   | Win32 EXE (PE32 executable, Nullsoft Installer)                    |
| **İmza**         | İmzasız (File is not signed)                                       |
| **İlk gönderim** | 2026-03-21 14:53:42 UTC                                            |
| **Son analiz**   | 2026-03-21 14:53:42 UTC                                            |

## Bağımlılıklar

- `npm audit` ile bağımlılık uyarılarını periyodik kontrol edin.
- Güncellemelerde `package.json` sürümlerini ve Electron/Monaco güvenlik notlarını takip edin.

---

_Son güncelleme: Mart 2026 (v1.1.8)_
