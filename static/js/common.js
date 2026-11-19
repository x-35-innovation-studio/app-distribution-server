"use strict";

/*
 * Shared helpers. All dynamic content is rendered with textContent / DOM APIs,
 * never innerHTML, so values coming from uploaded builds can't inject markup.
 */
(function () {
  const TOKEN_KEY = "X-Auth-Token";

  function storageGet(store, key) {
    try {
      return store.getItem(key);
    } catch (_) {
      return null;
    }
  }

  const auth = {
    get() {
      return storageGet(window.sessionStorage, TOKEN_KEY) || storageGet(window.localStorage, TOKEN_KEY);
    },
    set(token, remember) {
      auth.clear();
      try {
        (remember ? window.localStorage : window.sessionStorage).setItem(TOKEN_KEY, token);
      } catch (_) {
        /* storage unavailable: token lives only for this page */
      }
    },
    clear() {
      try {
        window.localStorage.removeItem(TOKEN_KEY);
        window.sessionStorage.removeItem(TOKEN_KEY);
      } catch (_) {}
    },
  };

  // Deterministic avatar colour from a string.
  function avatarColor(seed) {
    let hash = 0;
    for (const ch of String(seed || "")) hash = (hash * 31 + ch.codePointAt(0)) | 0;
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue} 62% 52%)`;
  }

  function applyAvatar(el, seed) {
    el.style.setProperty("--avatar", avatarColor(seed));
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  function relativeTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const seconds = Math.round((date.getTime() - Date.now()) / 1000);
    const units = [
      ["year", 31536000],
      ["month", 2592000],
      ["week", 604800],
      ["day", 86400],
      ["hour", 3600],
      ["minute", 60],
    ];
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    for (const [unit, size] of units) {
      if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
    }
    return rtf.format(seconds, "second");
  }

  function formatBytes(bytes) {
    if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("time[datetime]").forEach((el) => {
      const formatted = formatDate(el.dateTime);
      if (formatted) el.textContent = formatted;
    });
    document.querySelectorAll("[data-avatar]").forEach((el) => applyAvatar(el, el.dataset.avatar));
  });

  window.ADS = { auth, avatarColor, applyAvatar, formatDate, relativeTime, formatBytes };
})();
