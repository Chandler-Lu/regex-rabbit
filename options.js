(function () {
  "use strict";
  var fields = {};
  Object.keys(RRRuntimeConfig.defaults).forEach(function (key) { fields[key] = document.getElementById(key); });
  Object.keys(RRRuntimeConfig.numericRanges).forEach(function (key) {
    var field = fields[key], range = RRRuntimeConfig.numericRanges[key];
    field.min = range.min;
    field.max = range.max;
    field.step = range.integer ? "1" : "any";
  });
  var form = document.getElementById("settings");
  var saveButton = document.getElementById("save");
  var retryButton = document.getElementById("retryLoad");
  var scaleVal = document.getElementById("scaleVal");
  var statusEl = document.getElementById("status");
  var actionBar = document.querySelector(".action-bar");
  var advanced = document.getElementById("advancedSettings");
  var modeRadios = Array.from(document.querySelectorAll('input[name="searchMode"]'));
  var scaleButtons = Array.from(document.querySelectorAll("[data-scale]"));
  var budgetButtons = Array.from(document.querySelectorAll("[data-budget]"));
  var dirtyFields = new Set();
  var editVersion = 0, loaded = false, saving = false;
  var colors = ["highlightColor", "currentColor"];
  colors.forEach(function (key) { fields[key].maxLength = RRRuntimeConfig.maxColorChars; });
  var budgetKeys = ["maxMatches", "workerTimeoutMs", "maxScannedChars"];
  var budgets = RRRuntimeConfig.budgetPresets;
  var SCALE_BUTTON_EPSILON = 0.000001;
  var budgetLabels = { light: "options.budgetLight", balanced: "options.budgetBalanced", large: "options.budgetLarge" };
  var statusKey = "", statusParams = {}, renderedLanguage = "";

  function status(key, state, params) {
    statusKey = key;
    statusParams = params || {};
    statusEl.textContent = key ? RRi18n.t(key, statusParams) : "";
    actionBar.dataset.state = state || "ready";
  }
  function translate() {
    RRi18n.setLanguage(fields.uiLanguage ? fields.uiLanguage.value : "auto");
    var language = RRi18n.getLanguage();
    if (renderedLanguage !== language) {
      RRi18n.apply(document);
      document.documentElement.lang = language;
      renderedLanguage = language;
    }
    statusEl.textContent = statusKey ? RRi18n.t(statusKey, statusParams) : "";
    saveButton.textContent = RRi18n.t(saving ? "options.savingButton" : "options.save");
    [["timeoutHelp", "workerTimeoutMs", "options.timeoutHelp"], ["scanHelp", "maxScannedChars", "options.scanHelp"]].forEach(function (entry) {
      var field = fields[entry[1]];
      document.getElementById(entry[0]).textContent = RRi18n.t(entry[2], {
        min: RRi18n.formatNumber(Number(field.min)), max: RRi18n.formatNumber(Number(field.max))
      });
    });
  }
  function pickerColor(value) {
    if (value[0] === "#") {
      var hex = value.slice(1);
      if (hex.length === 3 || hex.length === 4) return "#" + hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      return "#" + hex.slice(0, 6);
    }
    var channels = value.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
    return "#" + channels.slice(1).map(function (channel) { return Number(channel).toString(16).padStart(2, "0"); }).join("");
  }
  function previewTextColor(value) {
    var rgb, alpha = 1;
    if (value[0] === "#") {
      var hex = value.slice(1);
      if (hex.length < 5) hex = hex.split("").map(function (character) { return character + character; }).join("");
      rgb = [0, 2, 4].map(function (index) { return parseInt(hex.slice(index, index + 2), 16); });
      if (hex.length === 8) alpha = parseInt(hex.slice(6), 16) / 255;
    } else {
      var channels = value.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/);
      rgb = channels.slice(1, 4).map(Number);
      if (channels[4] !== undefined) alpha = Number(channels[4]);
    }
    var dark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
    var base = dark ? [32, 33, 36] : [255, 255, 255];
    // sRGB's piecewise transfer function and luminance weights. These values
    // describe the color model; they are not tunable search or UI limits.
    var linear = rgb.map(function (channel, index) {
      var value = (channel * alpha + base[index] * (1 - alpha)) / 255;
      return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    });
    var luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    return luminance > 0.179 ? "#000000" : "#ffffff";
  }
  function characterSummary(field) {
    var value = field.valueAsNumber;
    return Number.isFinite(value) && value > 0 ? RRi18n.t("options.characterSummary", { count: RRi18n.formatNumber(value) }) : "";
  }
  function preview() {
    translate();
    var scale = fields.scale.valueAsNumber;
    scaleVal.textContent = Number.isFinite(scale) ? RRi18n.formatNumber(scale * 100, { maximumFractionDigits: 1 }) + "%" : "—";
    fields.scale.setAttribute("aria-valuetext", scaleVal.textContent);
    scaleButtons.forEach(function (button) { button.setAttribute("aria-pressed", String(Math.abs(Number(button.dataset.scale) - scale) < SCALE_BUTTON_EPSILON)); });
    modeRadios.forEach(function (radio) { radio.checked = radio.value === fields.mode.value; });
    document.getElementById("regexOptions").disabled = fields.mode.value !== "regex";
    var activeBudget = null;
    budgetButtons.forEach(function (button) {
      var selected = budgetKeys.every(function (key) { return fields[key].valueAsNumber === budgets[button.dataset.budget][key]; });
      button.setAttribute("aria-pressed", String(selected));
      if (selected) activeBudget = button.dataset.budget;
    });
    document.getElementById("budgetStatus").textContent = activeBudget ? RRi18n.t("options.budgetSelected", { name: RRi18n.t(budgetLabels[activeBudget]) }) : RRi18n.t("options.budgetCustom");
    document.getElementById("scanSummary").textContent = characterSummary(fields.maxScannedChars);
    colors.forEach(function (key) {
      var color = RRRuntimeConfig.sanitizeColor(fields[key].value);
      fields[key].setCustomValidity(color ? "" : RRi18n.t("options.invalidColor"));
      fields[key].setAttribute("aria-invalid", String(!color));
      if (!color) return;
      var sample = document.getElementById(key === "highlightColor" ? "colorPreview" : "currentPreview");
      sample.style.background = color;
      sample.style.color = previewTextColor(color);
      document.getElementById(key + "Picker").value = pickerColor(color);
    });
    ["scale", "autoSearchDebounce"].concat(budgetKeys).forEach(function (key) {
      var field = fields[key];
      var value = field.valueAsNumber;
      var integer = field.type === "number";
      var valid = Number.isFinite(value) && value >= Number(field.min) && value <= Number(field.max) && (!integer || Number.isSafeInteger(value));
      field.setCustomValidity(valid ? "" : RRi18n.t("options.invalidNumber", {
        min: RRi18n.formatNumber(Number(field.min)), max: RRi18n.formatNumber(Number(field.max)),
        kind: RRi18n.t(integer ? "options.integer" : "options.number")
      }));
      field.setAttribute("aria-invalid", String(!valid));
    });
  }
  function edited(keys) {
    (Array.isArray(keys) ? keys : [keys]).forEach(function (key) { dirtyFields.add(key); });
    editVersion++;
    if (!saving) status("options.unsaved", "pending");
    preview();
  }
  function apply(values, preserveEdits) {
    var cfg = RRRuntimeConfig.normalize(values);
    Object.keys(fields).forEach(function (key) {
      var el = fields[key];
      if (!el || preserveEdits && dirtyFields.has(key)) return;
      if (el.type === "checkbox") el.checked = cfg[key]; else el.value = cfg[key];
    });
    preview();
  }
  Object.keys(fields).forEach(function (key) {
    if (fields[key]) {
      fields[key].addEventListener("input", function () { edited(key); });
      // A select also accepts keyboard changes, including engines that only emit change.
      if (fields[key].tagName === "SELECT") fields[key].addEventListener("change", function () { edited(key); });
    }
  });
  modeRadios.forEach(function (radio) {
    radio.addEventListener("change", function () {
      if (!radio.checked) return;
      fields.mode.value = radio.value;
      edited("mode");
    });
  });
  scaleButtons.forEach(function (button) {
    button.addEventListener("click", function () { fields.scale.value = button.dataset.scale; edited("scale"); });
  });
  budgetButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      var values = budgets[button.dataset.budget];
      budgetKeys.forEach(function (key) { fields[key].value = values[key]; });
      edited(budgetKeys);
    });
  });
  colors.forEach(function (key) {
    document.getElementById(key + "Picker").addEventListener("input", function (event) {
      fields[key].value = event.target.value;
      edited(key);
    });
  });
  function finishLoad(stored, error) {
    apply(error ? RRRuntimeConfig.defaults : RRRuntimeConfig.migrateStored(stored).values, true);
    loaded = !error;
    saveButton.disabled = !loaded || saving;
    retryButton.hidden = !error;
    retryButton.disabled = false;
    if (error) status("options.loadError", "error", { error: error });
    else if (dirtyFields.size) status("options.unsaved", "pending");
    else status("", "ready");
  }
  function loadSettings() {
    retryButton.disabled = true;
    saveButton.disabled = true;
    status("options.loading", "loading");
    try {
      chrome.storage.sync.get(RRRuntimeConfig.storageKeys, function (stored) {
        var error = chrome.runtime.lastError;
        finishLoad(stored, error && error.message);
      });
    } catch (error) { finishLoad(null, error.message); }
  }
  retryButton.addEventListener("click", loadSettings);
  loadSettings();

  function revealInvalidSetting() {
    preview();
    var invalid = form.querySelector("input:invalid");
    if (invalid && advanced.contains(invalid)) advanced.open = true;
    if (invalid) status("options.invalidSettings", "error");
    return invalid;
  }
  // Native validation happens before submit. Reveal invalid fields inside the
  // collapsed group before the browser tries to focus them.
  saveButton.addEventListener("click", revealInvalidSetting);
  form.addEventListener("invalid", function (event) {
    if (advanced.contains(event.target)) advanced.open = true;
    status("options.invalidSettings", "error");
  }, true);
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (!loaded || saving) return;
    revealInvalidSetting();
    if (!form.reportValidity()) return;
    var values = {};
    Object.keys(fields).forEach(function (key) {
      var el = fields[key];
      if (!el) return;
      values[key] = el.type === "checkbox" ? el.checked : (el.type === "number" || el.type === "range" ? el.valueAsNumber : el.value);
    });
    var cfg = RRRuntimeConfig.normalize(values);
    // Save the marker and the user's current budget together. Reads migrate
    // only in memory, so a delayed load never writes over a newer saved choice.
    cfg[RRRuntimeConfig.characterBudgetVersionKey] = RRRuntimeConfig.characterBudgetVersion;
    var savedVersion = editVersion;
    saving = true;
    saveButton.disabled = true;
    saveButton.textContent = RRi18n.t("options.savingButton");
    form.setAttribute("aria-busy", "true");
    status("options.saving", "saving");
    function finishSave(error) {
      saving = false;
      saveButton.disabled = false;
      saveButton.textContent = RRi18n.t("options.save");
      form.setAttribute("aria-busy", "false");
      if (error) { status("options.saveError", "error", { error: error }); return; }
      if (savedVersion === editVersion) { dirtyFields.clear(); status("options.saved", "saved"); }
      else status("options.savedEarlier", "pending");
    }
    try {
      chrome.storage.sync.set(cfg, function () {
        var error = chrome.runtime.lastError;
        finishSave(error && error.message);
      });
    } catch (error) { finishSave(error.message); }
  });
  document.getElementById("reset").addEventListener("click", function () {
    Object.keys(fields).forEach(function (key) { dirtyFields.add(key); });
    editVersion++;
    apply(RRRuntimeConfig.defaults, false);
    status("options.resetPending", "pending");
  });
  if (typeof matchMedia === "function") {
    var colorScheme = matchMedia("(prefers-color-scheme: dark)");
    if (typeof colorScheme.addEventListener === "function") colorScheme.addEventListener("change", preview);
  }
  preview();
})();
