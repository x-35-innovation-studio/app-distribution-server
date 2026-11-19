"use strict";

/*
 * Dashboard. Security note: never use innerHTML with server data. Every value
 * (app titles, bundle IDs, tags...) comes from uploaded files or user input,
 * so it's rendered with textContent / setAttribute only.
 */
document.addEventListener("DOMContentLoaded", () => {
  const { auth, applyAvatar, formatDate, relativeTime, formatBytes } = window.ADS;

  if (!auth.get()) {
    window.location.replace("/login");
    return;
  }

  const $ = (id) => document.getElementById(id);
  const maxUploadBytes = Number(document.body.dataset.maxUploadMb || 0) * 1024 * 1024;

  const state = {
    builds: [],
    tags: [],
    platform: "",
    selectedTags: new Set(),
    search: "",
    uploadTags: new Set(),
    file: null,
  };

  /* ---------------- helpers ---------------- */

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "className") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function icon(name) {
    const tpl = $("icon-templates").content.querySelector(`[data-icon="${name}"] svg`);
    return tpl ? tpl.cloneNode(true) : document.createTextNode("");
  }

  function toast(message, kind = "success") {
    const node = el("div", { className: `toast ${kind}`, role: "status", text: message });
    $("toasts").append(node);
    setTimeout(() => node.remove(), 3500);
  }

  function showAlert(node, message, kind = "error") {
    node.textContent = message;
    node.className = `alert alert-${kind}`;
    node.hidden = false;
  }

  function hideAlert(node) {
    node.hidden = true;
    node.textContent = "";
  }

  async function errorMessage(res, fallback) {
    try {
      const text = await res.text();
      try {
        const data = JSON.parse(text);
        if (typeof data.detail === "string") return data.detail;
        if (Array.isArray(data.detail) && data.detail[0]?.msg) return data.detail[0].msg;
      } catch (_) {
        if (text && text.length < 300 && !text.trimStart().startsWith("<")) return text;
      }
    } catch (_) {}
    return fallback;
  }

  function handleAuthFailure(res) {
    if (res.status === 401 || res.status === 403) {
      auth.clear();
      window.location.replace("/login");
      return true;
    }
    return false;
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("X-Auth-Token", auth.get() || "");
    const res = await fetch(path, { ...options, headers });
    if (handleAuthFailure(res)) throw new Error("unauthorized");
    return res;
  }

  function isSafeHttpUrl(value) {
    try {
      const url = new URL(value, window.location.origin);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch (_) {
      return false;
    }
  }

  /* ---------------- data ---------------- */

  async function loadTags() {
    try {
      const res = await api("/api/tags");
      if (!res.ok) throw new Error();
      const data = await res.json();
      state.tags = Array.isArray(data.tags) ? data.tags.filter((t) => typeof t === "string") : [];
    } catch (e) {
      if (e.message !== "unauthorized") toast("Couldn't load tags.", "error");
      state.tags = [];
    }
    for (const t of [...state.selectedTags]) if (!state.tags.includes(t)) state.selectedTags.delete(t);
    for (const t of [...state.uploadTags]) if (!state.tags.includes(t)) state.uploadTags.delete(t);
    renderTagFilter();
    renderUploadTagChips();
    renderTagList();
  }

  async function loadBuilds() {
    renderSkeleton();
    try {
      const res = await api("/api/uploads");
      if (!res.ok) throw new Error();
      const data = await res.json();
      state.builds = Array.isArray(data) ? data : [];
    } catch (e) {
      if (e.message === "unauthorized") return;
      state.builds = [];
      toast("Couldn't load builds.", "error");
    }
    renderBuilds();
  }

  /* ---------------- rendering ---------------- */

  function renderSkeleton() {
    const body = $("builds-body");
    body.replaceChildren(
      ...Array.from({ length: 4 }, () =>
        el(
          "tr",
          { className: "skeleton-row" },
          el("td", { colspan: 7 }, el("div", { className: "skeleton", style: "width: 60%" })),
        ),
      ),
    );
    $("empty-state").hidden = true;
  }

  function filteredBuilds() {
    const q = state.search.toLowerCase();
    return state.builds.filter((b) => {
      const info = b.build_info || {};
      if (state.platform && info.platform !== state.platform) return false;
      const tags = Array.isArray(b.tags) ? b.tags : [];
      for (const t of state.selectedTags) if (!tags.includes(t)) return false;
      if (q) {
        const haystack = [info.app_title, info.bundle_id, info.bundle_version].join(" ").toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }

  function platformBadge(platform) {
    const label = platform === "ios" ? "iOS" : platform === "android" ? "Android" : "Unknown";
    const cls = platform === "ios" || platform === "android" ? `badge badge-${platform}` : "badge";
    return el("span", { className: cls, text: label });
  }

  function buildRow(b) {
    const info = b.build_info || {};
    const title = String(info.app_title || "Untitled app");
    const avatar = el("div", { className: "app-avatar", text: title.slice(0, 1).toUpperCase() });
    applyAvatar(avatar, title);

    const created = info.created_at;
    const createdCell = created
      ? el("span", { title: formatDate(created), text: relativeTime(created) })
      : el("span", { className: "faint", text: "—" });

    const tags = Array.isArray(b.tags) ? b.tags : [];
    const tagsCell = tags.length
      ? el("div", { className: "chip-row" }, tags.map((t) => el("span", { className: "chip chip-static", text: t })))
      : el("span", { className: "faint", text: "—" });

    const url = isSafeHttpUrl(b.url) ? b.url : `/get/${encodeURIComponent(b.upload_id)}`;

    const openLink = el(
      "a",
      { className: "btn btn-sm", href: url, target: "_blank", rel: "noopener noreferrer" },
      icon("external"),
      "Open",
    );
    const copyBtn = el(
      "button",
      {
        className: "btn btn-sm btn-icon",
        type: "button",
        title: "Copy install link",
        "aria-label": `Copy install link for ${title}`,
        onclick: () => copyLink(url),
      },
      icon("copy"),
    );
    const deleteBtn = el(
      "button",
      {
        className: "btn btn-sm btn-icon btn-danger",
        type: "button",
        title: "Delete build",
        "aria-label": `Delete ${title}`,
        onclick: () => confirmDelete(b),
      },
      icon("trash"),
    );

    return el(
      "tr",
      {},
      el(
        "td",
        { className: "app-col" },
        el(
          "div",
          { className: "app-cell" },
          avatar,
          el(
            "div",
            {},
            el("div", { className: "app-name", text: title }),
            el("div", { className: "app-bundle", text: info.bundle_id || "" }),
          ),
        ),
      ),
      el("td", { "data-label": "" }, platformBadge(info.platform)),
      el("td", { className: "num", "data-label": "Version" }, info.bundle_version || "—"),
      el("td", { className: "num muted", "data-label": "Size" }, formatBytes(info.file_size) || "—"),
      el("td", { className: "muted", "data-label": "Uploaded" }, createdCell),
      el("td", {}, tagsCell),
      el("td", { className: "actions" }, openLink, copyBtn, deleteBtn),
    );
  }

  function renderBuilds() {
    const all = state.builds;
    $("stat-total").textContent = all.length;
    $("stat-ios").textContent = all.filter((b) => b.build_info?.platform === "ios").length;
    $("stat-android").textContent = all.filter((b) => b.build_info?.platform === "android").length;

    const rows = filteredBuilds();
    $("builds-body").replaceChildren(...rows.map(buildRow));

    const empty = $("empty-state");
    empty.hidden = rows.length > 0;
    if (!rows.length) {
      const filtered = all.length > 0;
      $("empty-title").textContent = filtered ? "No matching builds" : "No builds yet";
      $("empty-text").textContent = filtered
        ? "Try a different search, platform or tag filter."
        : "Upload your first .ipa or .apk to get a shareable install page.";
      $("empty-upload").hidden = filtered;
    }
  }

  function renderTagFilter() {
    const wrap = $("tag-filter");
    wrap.hidden = state.tags.length === 0;
    $("tag-filter-chips").replaceChildren(
      ...state.tags.map((t) =>
        el("button", {
          type: "button",
          className: "chip",
          "aria-pressed": state.selectedTags.has(t) ? "true" : "false",
          text: t,
          onclick: () => {
            if (state.selectedTags.has(t)) state.selectedTags.delete(t);
            else state.selectedTags.add(t);
            renderTagFilter();
            renderBuilds();
          },
        }),
      ),
    );
    $("clear-tags").hidden = state.selectedTags.size === 0;
  }

  function renderUploadTagChips() {
    $("upload-tags-empty").hidden = state.tags.length > 0;
    $("upload-tag-chips").replaceChildren(
      ...state.tags.map((t) =>
        el("button", {
          type: "button",
          className: "chip",
          "aria-pressed": state.uploadTags.has(t) ? "true" : "false",
          text: t,
          onclick: (ev) => {
            if (state.uploadTags.has(t)) state.uploadTags.delete(t);
            else state.uploadTags.add(t);
            ev.currentTarget.setAttribute("aria-pressed", state.uploadTags.has(t) ? "true" : "false");
          },
        }),
      ),
    );
  }

  function renderTagList() {
    const list = $("tag-list");
    if (!state.tags.length) {
      list.replaceChildren(el("div", { className: "empty", style: "padding: 24px" }, "No tags yet."));
      return;
    }
    list.replaceChildren(...state.tags.map(tagItem));
  }

  function tagItem(tag) {
    const row = el("div", { className: "tag-item" });

    function viewMode() {
      row.replaceChildren(
        el("span", { className: "tag-name", text: tag }),
        el(
          "button",
          {
            type: "button",
            className: "btn btn-ghost btn-sm btn-icon",
            title: "Rename",
            "aria-label": `Rename tag ${tag}`,
            onclick: editMode,
          },
          icon("pencil"),
        ),
      );
    }

    function editMode() {
      const input = el("input", { className: "input", value: tag, maxlength: 64, "aria-label": "New tag name" });
      const save = async () => {
        const newTag = input.value.trim();
        if (!newTag || newTag === tag) return viewMode();
        try {
          const res = await api(
            `/api/tags/${encodeURIComponent(tag)}?new_tag=${encodeURIComponent(newTag)}`,
            { method: "PUT" },
          );
          if (!res.ok) {
            showAlert($("tag-msg"), await errorMessage(res, "Couldn't rename tag."));
            return;
          }
          hideAlert($("tag-msg"));
          toast(`Renamed “${tag}” to “${newTag}”`);
          if (state.selectedTags.delete(tag)) state.selectedTags.add(newTag);
          await Promise.all([loadTags(), loadBuilds()]);
        } catch (e) {
          if (e.message !== "unauthorized") showAlert($("tag-msg"), "Couldn't rename tag.");
        }
      };
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          save();
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          ev.stopPropagation();
          viewMode();
        }
      });
      row.replaceChildren(
        input,
        el("button", { type: "button", className: "btn btn-primary btn-sm", text: "Save", onclick: save }),
        el("button", { type: "button", className: "btn btn-sm", text: "Cancel", onclick: viewMode }),
      );
      input.focus();
      input.select();
    }

    viewMode();
    return row;
  }

  /* ---------------- actions ---------------- */

  async function copyLink(url) {
    try {
      await navigator.clipboard.writeText(url);
      toast("Install link copied");
    } catch (_) {
      window.prompt("Copy this link:", url);
    }
  }

  function confirmDelete(build) {
    const dialog = $("delete-dialog");
    const info = build.build_info || {};
    $("delete-name").textContent = `${info.app_title || "This build"} ${info.bundle_version ? "v" + info.bundle_version : ""}`.trim();
    dialog.returnValue = "";
    dialog.showModal();
    dialog.addEventListener(
      "close",
      async () => {
        if (dialog.returnValue !== "confirm") return;
        try {
          const res = await api(`/api/delete/${encodeURIComponent(build.upload_id)}`, { method: "DELETE" });
          if (!res.ok) {
            toast(await errorMessage(res, "Couldn't delete build."), "error");
            return;
          }
          toast("Build deleted");
          state.builds = state.builds.filter((b) => b.upload_id !== build.upload_id);
          renderBuilds();
        } catch (e) {
          if (e.message !== "unauthorized") toast("Couldn't delete build.", "error");
        }
      },
      { once: true },
    );
  }

  /* Upload */

  function setFile(file) {
    const msg = $("upload-msg");
    hideAlert(msg);
    state.file = null;
    $("file-pill").hidden = true;
    $("upload-submit").disabled = true;
    if (!file) return;

    const name = file.name.toLowerCase();
    if (!name.endsWith(".ipa") && !name.endsWith(".apk")) {
      showAlert(msg, "Only .ipa and .apk files are supported.");
      return;
    }
    if (maxUploadBytes && file.size > maxUploadBytes) {
      showAlert(msg, `File is too large. The limit is ${formatBytes(maxUploadBytes)}.`);
      return;
    }
    state.file = file;
    $("file-name").textContent = file.name;
    $("file-size").textContent = formatBytes(file.size);
    $("file-pill").hidden = false;
    $("upload-submit").disabled = false;
  }

  function resetUpload() {
    $("app-file").value = "";
    state.uploadTags.clear();
    renderUploadTagChips();
    setFile(null);
    $("upload-progress").hidden = true;
    $("upload-progress").firstElementChild.style.width = "0";
  }

  function uploadWithProgress(formData, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload");
      xhr.setRequestHeader("X-Auth-Token", auth.get() || "");
      xhr.upload.addEventListener("progress", (ev) => {
        if (ev.lengthComputable) onProgress(ev.loaded / ev.total);
      });
      xhr.addEventListener("load", () => resolve(xhr));
      xhr.addEventListener("error", () => reject(new Error("network")));
      xhr.addEventListener("abort", () => reject(new Error("abort")));
      xhr.send(formData);
    });
  }

  async function submitUpload(ev) {
    ev.preventDefault();
    if (!state.file) return;

    const submit = $("upload-submit");
    const msg = $("upload-msg");
    const progress = $("upload-progress");
    const bar = progress.firstElementChild;
    hideAlert(msg);

    const formData = new FormData();
    formData.append("app_file", state.file);
    state.uploadTags.forEach((t) => formData.append("tags", t));

    submit.disabled = true;
    progress.hidden = false;
    bar.style.width = "0";

    try {
      const xhr = await uploadWithProgress(formData, (p) => {
        bar.style.width = `${Math.round(p * 100)}%`;
      });
      if (xhr.status === 401 || xhr.status === 403) {
        handleAuthFailure({ status: xhr.status });
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        const fakeRes = { text: async () => xhr.responseText };
        showAlert(msg, await errorMessage(fakeRes, `Upload failed (${xhr.status}).`));
        progress.hidden = true;
        return;
      }
      $("upload-dialog").close();
      resetUpload();
      toast("Build uploaded");
      await loadBuilds();
    } catch (_) {
      showAlert(msg, "Upload failed. Check your connection and try again.");
      progress.hidden = true;
    } finally {
      submit.disabled = !state.file;
    }
  }

  /* Tags */

  async function submitCreateTag(ev) {
    ev.preventDefault();
    const input = $("new-tag");
    const msg = $("tag-msg");
    const tag = input.value.trim();
    if (!tag) {
      showAlert(msg, "Enter a tag name.");
      return;
    }
    try {
      const res = await api("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag }),
      });
      if (!res.ok) {
        showAlert(msg, await errorMessage(res, "Couldn't create tag."));
        return;
      }
      hideAlert(msg);
      input.value = "";
      toast(`Tag “${tag}” created`);
      await loadTags();
    } catch (e) {
      if (e.message !== "unauthorized") showAlert(msg, "Couldn't create tag.");
    }
  }

  /* ---------------- wiring ---------------- */

  document.querySelectorAll("dialog [data-close]").forEach((btn) =>
    btn.addEventListener("click", () => btn.closest("dialog").close()),
  );
  document.querySelectorAll("dialog.modal").forEach((dialog) =>
    dialog.addEventListener("click", (ev) => {
      if (ev.target === dialog) dialog.close(); // backdrop click
    }),
  );

  const openUpload = () => {
    hideAlert($("upload-msg"));
    renderUploadTagChips();
    $("upload-dialog").showModal();
  };
  $("open-upload").addEventListener("click", openUpload);
  $("empty-upload").addEventListener("click", openUpload);
  $("open-tags").addEventListener("click", () => {
    hideAlert($("tag-msg"));
    $("tags-dialog").showModal();
    $("new-tag").focus();
  });
  $("logout").addEventListener("click", () => {
    auth.clear();
    window.location.replace("/login");
  });

  $("upload-form").addEventListener("submit", submitUpload);
  $("app-file").addEventListener("change", (ev) => setFile(ev.target.files[0]));
  const dropzone = $("dropzone");
  ["dragenter", "dragover"].forEach((t) =>
    dropzone.addEventListener(t, (ev) => {
      ev.preventDefault();
      dropzone.classList.add("dragging");
    }),
  );
  ["dragleave", "drop"].forEach((t) =>
    dropzone.addEventListener(t, (ev) => {
      ev.preventDefault();
      dropzone.classList.remove("dragging");
    }),
  );
  dropzone.addEventListener("drop", (ev) => setFile(ev.dataTransfer?.files?.[0]));

  $("tag-create-form").addEventListener("submit", submitCreateTag);

  $("search").addEventListener("input", (ev) => {
    state.search = ev.target.value.trim();
    renderBuilds();
  });
  $("platform-filter").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-platform]");
    if (!btn) return;
    state.platform = btn.dataset.platform;
    $("platform-filter")
      .querySelectorAll("button")
      .forEach((b) => b.setAttribute("aria-pressed", b === btn ? "true" : "false"));
    renderBuilds();
  });
  $("clear-tags").addEventListener("click", () => {
    state.selectedTags.clear();
    renderTagFilter();
    renderBuilds();
  });

  loadTags();
  loadBuilds();
});
