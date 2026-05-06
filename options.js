(function () {
  "use strict";
  var scaleEl = document.getElementById("scale");
  var scaleVal = document.getElementById("scaleVal");
  var maxEl = document.getElementById("maxMatches");
  var hlEl = document.getElementById("highlightColor");
  var curEl = document.getElementById("currentColor");
  var caseEl = document.getElementById("caseSensitive");
  var autoDebounceEl = document.getElementById("autoSearchDebounce");
  var hlPrev = document.getElementById("colorPreview");
  var curPrev = document.getElementById("currentPreview");
  var statusEl = document.getElementById("status");

  var defaults = { scale: 1.0, maxMatches: 1000, highlightColor: "#ffe082", currentColor: "#ff6d00", caseSensitive: false, autoSearchDebounce: 1500 };

  scaleEl.addEventListener("input", function () { scaleVal.textContent = this.value + "x"; });
  hlEl.addEventListener("input", function () { hlPrev.style.background = this.value; });
  curEl.addEventListener("input", function () { curPrev.style.background = this.value; });

  chrome.storage.sync.get(defaults, function (cfg) {
    scaleEl.value = cfg.scale; scaleVal.textContent = cfg.scale + "x";
    maxEl.value = cfg.maxMatches;
    hlEl.value = cfg.highlightColor; hlPrev.style.background = cfg.highlightColor;
    curEl.value = cfg.currentColor; curPrev.style.background = cfg.currentColor;
    caseEl.checked = cfg.caseSensitive;
    if (autoDebounceEl) autoDebounceEl.value = cfg.autoSearchDebounce;
  });

  function sanitizeColor(color) {
    if (typeof color !== "string") return null;
    if (/^#[0-9a-fA-F]{3,8}$/.test(color)) return color;
    if (/^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/.test(color)) return color;
    if (/^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+)\s*\)$/.test(color)) return color;
    return null;
  }

  document.getElementById("save").addEventListener("click", function () {
    var scale = parseFloat(scaleEl.value);
    if (isNaN(scale) || scale < 0.5 || scale > 2.5) scale = 1.0;
    var maxMatches = parseInt(maxEl.value, 10);
    if (isNaN(maxMatches) || maxMatches < 100) maxMatches = 1000;
    var hl = sanitizeColor(hlEl.value) || "#ffe082";
    var cur = sanitizeColor(curEl.value) || "#ff6d00";

    var debounceMs = autoDebounceEl ? parseInt(autoDebounceEl.value, 10) : 1500;
    if (isNaN(debounceMs) || debounceMs < 500 || debounceMs > 5000) debounceMs = 1500;

    chrome.storage.sync.set({
      scale: scale,
      maxMatches: maxMatches,
      highlightColor: hl,
      currentColor: cur,
      caseSensitive: caseEl.checked,
      autoSearchDebounce: debounceMs
    }, function () {
      if (chrome.runtime.lastError) {
        statusEl.textContent = "Save failed: " + chrome.runtime.lastError.message;
        setTimeout(function () { statusEl.textContent = ""; }, 3000);
      } else {
        statusEl.textContent = "Saved.";
        setTimeout(function () { statusEl.textContent = ""; }, 1500);
      }
    });
  });
})();
