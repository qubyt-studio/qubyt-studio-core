/* Monaco loader'dan önce çalışır; require config + worker yolu */
window.require = {
  paths: { vs: "vs" },
  baseUrl: ".",
  "vs/nls": { availableLanguages: {} },
};

/* Worker: Mutlak URL kullan (Electron path sorunları). Monaco 0.48.0 ile uyumlu. */
(function () {
  var base =
    typeof window !== "undefined" && window.location
      ? window.location.origin + window.location.pathname.replace(/[^/]*$/, "")
      : "";
  var workerUrl = base + "vs/base/worker/workerMain.js";
  window.MonacoEnvironment = {
    getWorkerUrl: function (workerId, label) {
      return workerUrl;
    },
  };
})();
