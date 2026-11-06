(() => {
  "use strict";

  const FIELDS = ["title", "artist", "album_artist", "composer", "track", "disc", "album", "genre", "year", "release_date", "publisher", "copyright", "isrc", "bpm", "key", "language", "lyrics", "comments"];
  const LABELS = { title: "Song title", artist: "Artist", album_artist: "Album artist", composer: "Composer", track: "Track", disc: "Disc", album: "Album", genre: "Genre", year: "Release year", release_date: "Release date", publisher: "Publisher", copyright: "Copyright", isrc: "ISRC", bpm: "BPM", key: "Musical key", language: "Language", lyrics: "Lyrics", comments: "Comments", filename: "Output filename" };
  const EMPTY = Object.fromEntries(FIELDS.map((field) => [field, ""]));
  const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
  const MAX_COVER_BYTES = 10 * 1024 * 1024;
  const MAX_BATCH_FILES = 25;
  const MAX_BATCH_BYTES = 250 * 1024 * 1024;
  const OUTPUT_TTL_MS = 60 * 60 * 1000;
  const PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 400'%3E%3Crect width='400' height='400' fill='%23101010'/%3E%3Cpath d='M200 112a88 88 0 1 0 0 176 88 88 0 0 0 0-176Zm0 26a62 62 0 1 1 0 124 62 62 0 0 1 0-124Z' fill='%23242424'/%3E%3C/svg%3E";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const state = {
    audioFile: null, audioUrl: "", artworkBlob: null, artworkUrl: "", removeArtwork: false,
    baseline: { ...EMPTY }, baselineArtwork: false, embedded: { ...EMPTY }, dirty: new Set(),
    editingTrackId: null, editingRecord: null, currentRecordId: null, fileToken: 0,
    past: [], future: [], lastSnapshot: null, batch: [], batchBusy: false,
    library: [], libraryFilter: "tracks", libraryList: false, libraryUrls: [], dashboardUrls: [],
    playerTrackId: null, playerQueue: [], playerObjectUrl: "", mutedVolume: 1,
    aiImages: [], selectedAiIndex: -1, analysisFile: null, analysisTrackId: null, analysis: null,
    waveformZoom: 1, coverRotation: 0, coverCropped: false, coverEdited: false,
    settings: { filenameTemplate: "{artist} - {title}", playbackRate: 1, reducedMotion: false },
  };

  const audio = $("#realAudio");
  const metaInputs = Object.fromEntries(FIELDS.map((field) => [field, $(`[name="${field === "release_date" ? "date" : field}"]`)]).filter(([, node]) => node));

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function toast(message, type = "success", duration = 4200) {
    const region = $("#toastRegion");
    if (!region) return;
    const item = document.createElement("div");
    item.className = `toast ${type === "error" ? "error" : type === "warning" ? "warning" : ""}`.trim();
    const icon = type === "error" ? "circle-alert" : type === "warning" ? "triangle-alert" : "circle-check";
    item.innerHTML = `<i data-lucide="${icon}"></i><p>${escapeHTML(message)}</p>`;
    region.append(item);
    refreshIcons(item);
    window.setTimeout(() => item.remove(), duration);
  }

  function refreshIcons(root = document) {
    if (window.lucide?.createIcons) window.lucide.createIcons({ root });
  }

  function showModal(id) { const modal = document.getElementById(id); if (modal) modal.classList.remove("hidden"); }
  function closeModal(id) { const modal = document.getElementById(id); if (modal) modal.classList.add("hidden"); }

  async function apiJSON(url, options = {}) {
    const response = await fetch(url, options);
    let data = {};
    try { data = await response.json(); } catch (_) { /* response may be empty */ }
    if (!response.ok) throw new Error(data.detail || `Request failed (${response.status}).`);
    return data;
  }

  function formDataForMetadata(file, cover, values, options = {}) {
    const data = new FormData();
    data.append("audio_file", file, file.name || "audio.mp3");
    for (const field of FIELDS) {
      const key = field === "release_date" ? "release_date" : field;
      data.append(key, values[field] ?? "");
    }
    if (cover && options.embedArtwork !== false) data.append("cover_image", cover, "cover.jpg");
    data.append("remove_artwork", String(Boolean(options.removeArtwork || options.embedArtwork === false)));
    data.append("clean_filename", String(options.cleanFilename !== false));
    data.append("output_filename", options.outputFilename || "");
    return data;
  }

  function showView(viewId) {
    const view = document.getElementById(viewId);
    if (!view) return;
    $$(".view").forEach((node) => { node.classList.toggle("active", node === view); node.classList.toggle("hidden", node !== view); });
    $$(".nav-item[data-target], .mobile-nav-item[data-target]").forEach((node) => node.classList.toggle("active", node.dataset.target === viewId));
    window.scrollTo({ top: 0, behavior: state.settings.reducedMotion ? "instant" : "smooth" });
  }

  function openEditor() { showView("view-editor"); $("#audioFile")?.click(); }

  function bindNavigation() {
    document.addEventListener("click", (event) => {
      const nav = event.target.closest("[data-target]");
      if (nav) showView(nav.dataset.target);
      const close = event.target.closest("[data-close-modal]");
      if (close) closeModal(close.dataset.closeModal);
      if (event.target.classList?.contains("modal")) event.target.classList.add("hidden");
    });
    $("#globalUploadBtn")?.addEventListener("click", openEditor);
    $("#dashUpload")?.addEventListener("click", openEditor);
    $("#dashBatch")?.addEventListener("click", () => showView("view-batch"));
    $("#dashAnalyze")?.addEventListener("click", () => {
      showView("view-analyzer");
      if (state.audioFile) setAnalysisFile(state.audioFile, state.editingTrackId);
    });
    $("#dashLibrary")?.addEventListener("click", () => showView("view-library"));
    $("#viewAllRecent")?.addEventListener("click", () => showView("view-library"));
    $("#quickGenerateArt")?.addEventListener("click", () => showView("view-studio"));
    $("#mobileUpload")?.addEventListener("click", openEditor);
    $("#btnOpenArtworkStudio")?.addEventListener("click", () => showView("view-studio"));
  }

  function bindAudioUpload() {
    const input = $("#audioFile");
    const drop = $("#editorDropZone");
    input?.addEventListener("change", () => { const file = input.files?.[0]; if (file) void handleAudioFile(file); input.value = ""; });
    drop?.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); input?.click(); } });
    ["dragenter", "dragover"].forEach((name) => drop?.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add("drag-active"); }));
    ["dragleave", "drop"].forEach((name) => drop?.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove("drag-active"); }));
    drop?.addEventListener("drop", (event) => { const file = event.dataTransfer?.files?.[0]; if (file) void handleAudioFile(file); });
    $("#metadataForm")?.addEventListener("submit", (event) => { event.preventDefault(); openComparison(); });
    $$(".tab-btn").forEach((button) => button.addEventListener("click", () => {
      $$(".tab-btn").forEach((node) => node.classList.toggle("active", node === button));
      $$(".tab-panel").forEach((node) => { const active = node.id === button.dataset.tab; node.classList.toggle("active", active); node.classList.toggle("hidden", !active); });
    }));
  }

  function cleanFilename(name) {
    const stem = String(name || "").replace(/\.[^.]+$/, "").replace(/\\/g, "/").split("/").pop() || "Untitled";
    return stem
      .replace(/^vlc-record-\d{4}-\d{2}-\d{2}-\d{2}h\d{2}m\d{2}s-/i, "")
      .replace(/\b\d{4}-\d{2}-\d{2}[-_ ]\d{2}h\d{2}m\d{2}s\b/gi, " ")
      .replace(/\b\d{4}[-_]\d{2}[-_]\d{2}\b/g, " ")
      .replace(/\b\d{1,2}h\d{2}m\d{2}s\b/gi, " ")
      .replace(/(?:[-_\s]+)(?:tagged|official(?:\s+video)?|lyrics?|audio|video|hd|4k|1080p|320\s?kbps|downloaded|recording)(?:[-_\s].*)?$/i, "")
      .replace(/[._]+/g, " ").replace(/[_]+/g, " ").replace(/\s*[-–—]\s*/g, " - ")
      .replace(/\s+/g, " ").replace(/^[\s-]+|[\s-]+$/g, "").trim() || "Untitled";
  }

  function parseFilename(name) {
    const cleaned = cleanFilename(name);
    const split = cleaned.split(/\s+-\s+/, 2).map((part) => part.trim());
    return split.length === 2 ? { title: split[1], artist: split[0] } : { title: cleaned, artist: "" };
  }

  function validAudio(file) {
    const ext = file.name.toLowerCase().split(".").pop();
    if (!["mp3", "m4a"].includes(ext)) { toast("Choose an MP3 or M4A file.", "error"); return false; }
    if (!file.size) { toast("That audio file is empty.", "error"); return false; }
    if (file.size > MAX_AUDIO_BYTES) { toast("Audio files must be 50 MB or smaller.", "error"); return false; }
    return true;
  }

  async function handleAudioFile(file, options = {}) {
    if (!validAudio(file)) return;
    state.fileToken += 1;
    const token = state.fileToken;
    resetEditorState();
    state.audioFile = file;
    state.editingTrackId = options.trackId ?? null;
    state.editingRecord = options.record ?? null;
    state.currentRecordId = options.trackId ?? null;
    state.analysisTrackId = options.trackId ?? null;
    state.embedded = { ...EMPTY };
    state.baseline = { ...EMPTY };
    const guess = parseFilename(file.name);
    setValues({ ...EMPTY, title: guess.title, artist: guess.artist });
    state.lastSnapshot = takeSnapshot();
    $("#editorDropZone")?.classList.add("hidden");
    $("#metadataForm")?.classList.remove("hidden");
    ["btnAutoDetect", "btnValidateMetadata", "btnHistory", "btnUndo", "btnRedo", "btnSaveExport"].forEach((id) => { const node = document.getElementById(id); if (node) node.disabled = false; });
    setPlayer(file, { id: state.editingTrackId, title: guess.title, artist: guess.artist, artworkBlob: null });
    setTechnical({ format: file.name.split(".").pop().toUpperCase(), size: file.size });
    updateCompletion();
    showView("view-editor");
    state.analysisFile = null;
    if (state.analysis) {
      state.analysis = null;
      $("#analyzerResults")?.classList.add("hidden");
      $("#analyzerEmpty")?.classList.remove("hidden");
    }
    toast(`Loaded ${file.name}`);
    const body = new FormData();
    body.append("audio_file", file, file.name);
    try {
      const result = await apiJSON("/api/read-metadata", { method: "POST", body });
      if (token !== state.fileToken) return;
      const extracted = { ...EMPTY, ...(result.metadata || {}) };
      state.embedded = extracted;
      state.baseline = { ...extracted, title: extracted.title || guess.title, artist: extracted.artist || guess.artist };
      for (const field of FIELDS) {
        if (!state.dirty.has(field)) {
          const value = extracted[field] || (field === "title" ? guess.title : field === "artist" ? guess.artist : "");
          if (metaInputs[field]) metaInputs[field].value = value;
        }
      }
      if (result.artwork) {
        const art = dataUrlToBlob(result.artwork);
        if (art && !state.artworkBlob && !state.removeArtwork) setArtwork(art, false);
        state.baselineArtwork = Boolean(art);
      }
      $("#playerTitle").textContent = readValues().title || file.name;
      $("#playerArtist").textContent = readValues().artist || "Unknown artist";
      setPlayerArtwork(state.artworkBlob);
      state.lastSnapshot = takeSnapshot();
      setTechnical(result.technical || { format: file.name.split(".").pop().toUpperCase(), size: file.size });
      updateCompletion();
      updateButtons();
      presentSuggestions(file.name, guess);
    } catch (error) {
      if (token === state.fileToken) {
        setTechnical({ format: file.name.split(".").pop().toUpperCase(), size: file.size });
        toast(`Could not read existing tags: ${error.message}`, "warning", 6500);
        presentSuggestions(file.name, guess);
      }
    }
  }

  function resetEditorState() {
    state.dirty.clear(); state.past = []; state.future = []; state.artworkBlob = null; state.removeArtwork = false; state.artworkGenerated = false;
    state.editingRecord = null; state.editingTrackId = null; state.currentRecordId = null; state.baselineArtwork = false;
    state.coverRotation = 0; state.coverCropped = false; state.coverEdited = false;
    revokeUrl(state.artworkUrl); state.artworkUrl = "";
    for (const [field, input] of Object.entries(metaInputs)) input.value = "";
    $("#coverImage").value = "";
    setArtworkPreview(null);
    $("#completenessWidget")?.classList.remove("hidden");
    updateButtons();
  }

  function dataUrlToBlob(dataUrl) {
    try { const [head, encoded] = dataUrl.split(",", 2); const mime = head.match(/data:(.*?);base64/)?.[1] || "image/jpeg"; const raw = atob(encoded); const bytes = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i); return new Blob([bytes], { type: mime }); } catch (_) { return null; }
  }

  function setValues(values = {}) { for (const field of FIELDS) if (metaInputs[field]) metaInputs[field].value = values[field] ?? ""; }
  function readValues() { return Object.fromEntries(FIELDS.map((field) => [field, metaInputs[field]?.value.trim() || ""])); }
  function takeSnapshot() { return { values: readValues(), artworkBlob: state.artworkBlob, removeArtwork: state.removeArtwork, artworkGenerated: Boolean(state.artworkGenerated) }; }

  function setTechnical(info = {}) {
    const format = info.format || (state.audioFile?.name.split(".").pop().toUpperCase() ?? "--");
    const set = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
    set("infoFormat", info.codec ? `${format} · ${info.codec}` : format);
    set("infoSize", info.size ? formatBytes(info.size) : "--");
    set("infoDuration", Number.isFinite(info.duration) && info.duration > 0 ? formatTime(info.duration) : "--");
    set("infoBitrate", info.bitrate ? `${Math.round(info.bitrate / 1000)} kbps` : "--");
    set("infoSampleRate", info.sample_rate ? `${(info.sample_rate / 1000).toFixed(info.sample_rate % 1000 ? 1 : 0)} kHz` : "--");
    set("infoChannels", info.channels ? (info.channels === 1 ? "Mono" : info.channels === 2 ? "Stereo" : `${info.channels} channels`) : "--");
    if (info.duration && audio.src) $("#playerDuration").textContent = formatTime(info.duration);
  }

  function updateCompletion() {
    const values = readValues();
    const checks = [Boolean(values.title), Boolean(values.artist), Boolean(values.album), Boolean(values.genre), Boolean(values.year), Boolean(state.artworkBlob && !state.removeArtwork)];
    const count = checks.filter(Boolean).length;
    const percent = Math.round((count / checks.length) * 100);
    const label = $("#compPercentage"); if (label) label.textContent = `${percent}%`;
    const bar = $("#compBar"); if (bar) bar.style.width = `${percent}%`;
    const missing = [];
    if (!values.title) missing.push("Song title");
    if (!values.artist) missing.push("Artist");
    if (!values.album) missing.push("Album");
    if (!values.genre) missing.push("Genre");
    if (!values.year) missing.push("Release year");
    if (!state.artworkBlob || state.removeArtwork) missing.push("Album artwork");
    const list = $("#missingDataList");
    if (list) list.innerHTML = missing.length ? missing.map((name) => `<li>${escapeHTML(name)}</li>`).join("") : "<li class='text-primary'>Core metadata looks complete.</li>";
    $("#completenessWidget")?.classList.toggle("hidden", !state.audioFile);
    updateFilenamePreview();
  }

  function updateButtons() {
    const canUndo = state.past.length > 0, canRedo = state.future.length > 0;
    if ($("#btnUndo")) $("#btnUndo").disabled = !canUndo;
    if ($("#btnRedo")) $("#btnRedo").disabled = !canRedo;
  }

  function pushUndo() {
    const next = takeSnapshot();
    if (JSON.stringify(serializableSnapshot(next)) === JSON.stringify(serializableSnapshot(state.lastSnapshot || next))) return;
    state.past.push(state.lastSnapshot || next);
    if (state.past.length > 80) state.past.shift();
    state.lastSnapshot = next;
    state.future = [];
    updateButtons();
  }

  function checkpointBeforeChange() {
    const snapshot = takeSnapshot();
    state.past.push(snapshot);
    if (state.past.length > 80) state.past.shift();
    state.future = [];
    state.lastSnapshot = snapshot;
    updateButtons();
  }

  function serializableSnapshot(snapshot) {
    if (!snapshot) return null;
    return { values: snapshot.values, removeArtwork: snapshot.removeArtwork, artworkGenerated: snapshot.artworkGenerated, artworkSize: snapshot.artworkBlob?.size || 0, artworkType: snapshot.artworkBlob?.type || "" };
  }

  function restoreSnapshot(snapshot) {
    if (!snapshot) return;
    setValues(snapshot.values);
    state.artworkBlob = snapshot.artworkBlob || null;
    state.removeArtwork = Boolean(snapshot.removeArtwork);
    state.artworkGenerated = Boolean(snapshot.artworkGenerated);
    state.coverEdited = false;
    setArtworkPreview(state.artworkBlob);
    state.lastSnapshot = takeSnapshot();
    updateCompletion();
    updateButtons();
  }

  function undo() {
    if (!state.past.length) return;
    state.future.push(takeSnapshot());
    restoreSnapshot(state.past.pop());
    toast("Last metadata edit undone.");
  }

  function redo() {
    if (!state.future.length) return;
    state.past.push(takeSnapshot());
    restoreSnapshot(state.future.pop());
    toast("Metadata edit restored.");
  }

  function bindMetadataFields() {
    for (const [field, input] of Object.entries(metaInputs)) {
      input.addEventListener("input", () => {
        state.dirty.add(field);
        pushUndo();
        updateCompletion();
      });
    }
    $("#btnUndo")?.addEventListener("click", undo);
    $("#btnRedo")?.addEventListener("click", redo);
    $("#btnAutoDetect")?.addEventListener("click", () => {
      if (!state.audioFile) return;
      presentSuggestions(state.audioFile.name, parseFilename(state.audioFile.name), true);
    });
    $("#btnValidateMetadata")?.addEventListener("click", showValidation);
    $("#btnHistory")?.addEventListener("click", () => void openHistory());
    $("#btnSaveExport")?.addEventListener("click", openComparison);
    $("#btnConfirmExport")?.addEventListener("click", () => void exportCurrentTrack());
  }

  function presentSuggestions(fileName, guessed, forced = false) {
    const values = readValues();
    const candidates = {};
    if (guessed.title && !state.embedded.title && (guessed.title !== values.title || forced)) candidates.title = guessed.title;
    if (guessed.artist && !state.embedded.artist && (guessed.artist !== values.artist || forced)) candidates.artist = guessed.artist;
    const date = fileName.match(/\b(19|20)\d{2}\b/);
    if (!values.year && date && !state.embedded.year) candidates.year = date[0];
    const cleanName = filenameFromTemplate("{title}", { title: guessed.title }, fileName);
    if (cleanName.toLowerCase() !== fileName.toLowerCase()) candidates.filename = cleanName;
    if (!Object.keys(candidates).length) {
      if (forced) toast("No safe filename suggestions. Existing tags and your edits were kept.", "warning");
      return;
    }
    const rows = Object.entries(candidates).map(([field, value]) => `<div class="compare-item"><span class="compare-label">${escapeHTML(LABELS[field])}</span><span>Current: ${escapeHTML(field === "filename" ? fileName : values[field] || "Empty")}</span><strong>Suggested: ${escapeHTML(value)}</strong></div>`).join("");
    $("#suggestDiff").innerHTML = rows;
    $("#btnAcceptSuggest").onclick = () => {
      for (const [field, value] of Object.entries(candidates)) {
        if (field === "filename") { $("#exportCleanName").checked = true; continue; }
        if (!state.embedded[field] && !state.dirty.has(field) && metaInputs[field]) {
          metaInputs[field].value = value;
          state.dirty.add(field);
        }
      }
      pushUndo(); updateCompletion(); closeModal("suggestModal"); toast("Safe filename suggestions applied.");
    };
    showModal("suggestModal");
  }

  function validateMetadata() {
    const values = readValues();
    const errors = [], warnings = [];
    if (values.year && (!/^\d{1,4}$/.test(values.year) || Number(values.year) < 1 || Number(values.year) > 9999)) errors.push("Release year must be from 1 to 9999.");
    for (const field of ["track", "disc"]) if (values[field] && !/^\d{1,4}(?:\/\d{1,4})?$/.test(values[field])) errors.push(`${LABELS[field]} number must look like 1 or 1/12.`);
    if (values.bpm && (!/^\d{1,3}$/.test(values.bpm) || Number(values.bpm) < 1 || Number(values.bpm) > 999)) errors.push("BPM must be between 1 and 999.");
    if (values.release_date && !/^\d{4}-\d{2}-\d{2}$/.test(values.release_date)) errors.push("Release date must use YYYY-MM-DD.");
    if (!values.title) warnings.push("Song title is empty.");
    if (!values.artist) warnings.push("Artist is empty.");
    if (!values.album) warnings.push("Album is missing.");
    if (!values.genre) warnings.push("Genre is missing.");
    if (!values.year && !values.release_date) warnings.push("Release year or date is missing.");
    if (!state.artworkBlob || state.removeArtwork) warnings.push("No artwork will be embedded.");
    return { errors, warnings };
  }

  function showValidation() {
    const { errors, warnings } = validateMetadata();
    const groups = [];
    if (errors.length) groups.push(`<section class="validation-section"><h3>Fix before exporting</h3><ul>${errors.map((x) => `<li class="error">${escapeHTML(x)}</li>`).join("")}</ul></section>`);
    if (warnings.length) groups.push(`<section class="validation-section"><h3>Suggested information</h3><ul>${warnings.map((x) => `<li class="warning">${escapeHTML(x)}</li>`).join("")}</ul></section>`);
    if (!groups.length) groups.push("<section class='validation-section'><h3>Ready to export</h3><ul><li>Metadata values look valid and core fields are complete.</li></ul></section>");
    $("#validationResults").innerHTML = groups.join("");
    showModal("metadataValidationModal");
    return { errors, warnings };
  }

  function openComparison() {
    if (!state.audioFile) { toast("Choose an audio file first.", "warning"); return; }
    const before = { ...state.baseline };
    const after = readValues();
    const beforeRows = FIELDS.filter((field) => before[field] !== after[field]).map((field) => `<div class="compare-item"><span class="compare-label">${escapeHTML(LABELS[field])}</span><span>${escapeHTML(before[field] || "Empty")}</span></div>`);
    const afterRows = FIELDS.filter((field) => before[field] !== after[field]).map((field) => `<div class="compare-item"><span class="compare-label">${escapeHTML(LABELS[field])}</span><strong>${escapeHTML(after[field] || "Empty")}</strong></div>`);
    if (state.baselineArtwork !== Boolean(state.artworkBlob && !state.removeArtwork)) {
      beforeRows.push(`<div class="compare-item"><span class="compare-label">Artwork</span><span>${state.baselineArtwork ? "Embedded artwork" : "No artwork"}</span></div>`);
      afterRows.push(`<div class="compare-item"><span class="compare-label">Artwork</span><strong>${state.removeArtwork || !state.artworkBlob ? "No artwork" : "Updated artwork"}</strong></div>`);
    }
    $("#compareBefore").innerHTML = beforeRows.length ? beforeRows.join("") : "<p>No metadata differences from the imported values.</p>";
    $("#compareAfter").innerHTML = afterRows.length ? afterRows.join("") : "<p>Export will preserve the current tags.</p>";
    const settingsTemplate = state.settings.filenameTemplate;
    const select = $("#exportFilenameTemplate");
    if (select && [...select.options].some((option) => option.value === settingsTemplate)) select.value = settingsTemplate;
    updateFilenamePreview();
    showModal("compareModal");
  }

  function filenameFromTemplate(template, values, fileName = "") {
    const output = String(template || "{artist} - {title}").replace(/\{(artist|title|album|track)\}/g, (_, key) => values[key] || "");
    const safe = output.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/[. ]+$/g, "").replace(/\s+/g, " ").trim();
    const extension = fileName.includes(".") ? `.${fileName.split(".").pop().toLowerCase()}` : ".mp3";
    return `${safe || cleanFilename(fileName || "Untitled")}${extension}`;
  }

  function updateFilenamePreview() {
    const input = $("#exportFilenameTemplate");
    const target = $("#exportFilenamePreview");
    if (!input || !target) return;
    target.textContent = `Output: ${filenameFromTemplate(input.value, readValues(), state.audioFile?.name || "track.mp3")}`;
  }

  async function exportCurrentTrack() {
    const { errors, warnings } = validateMetadata();
    if (errors.length) { closeModal("compareModal"); showValidation(); return; }
    if (warnings.length && !window.confirm(`Some recommended metadata is missing:\n\n${warnings.join("\n")}\n\nExport anyway?`)) return;
    if (!state.audioFile) { toast("The selected audio file is no longer available.", "error"); return; }
    closeModal("compareModal");
    showModal("progressModal"); setProgress(12, 1);
    const values = readValues();
    const template = $("#exportFilenameTemplate")?.value || state.settings.filenameTemplate;
    const embed = $("#exportEmbedArtwork")?.checked !== false;
    const cleanName = $("#exportCleanName")?.checked !== false;
    const keepBackup = Boolean($("#exportKeepBackup")?.checked);
    try {
      const response = await apiJSON("/generate", { method: "POST", body: formDataForMetadata(state.audioFile, state.artworkBlob, values, {
        embedArtwork: embed, removeArtwork: state.removeArtwork, cleanFilename: cleanName,
        outputFilename: filenameFromTemplate(template, values, state.audioFile.name).replace(/\.[^.]+$/, ""),
      }) });
      setProgress(100, 4); closeModal("progressModal");
      showSuccess(response, values);
      const saveTask = persistGeneratedTrack(response, values, keepBackup);
      void cacheGeneratedOutput(response, saveTask);
    } catch (error) {
      closeModal("progressModal"); toast(error.message || "Could not process this audio file.", "error", 8000);
    }
  }

  function setProgress(percent, activeStep) {
    const bar = $("#progressBar"); if (bar) bar.style.width = `${percent}%`;
    for (let index = 1; index <= 4; index++) {
      const step = $(`#step${index}`); if (!step) continue;
      step.classList.toggle("active", index === activeStep);
      step.classList.toggle("completed", index < activeStep || percent === 100);
    }
  }

  function showSuccess(response, values) {
    const link = $("#downloadBtn");
    link.href = new URL(response.download_url, window.location.origin).href;
    link.download = response.filename || "MetaTune_Track.mp3";
    $("#successTitle").textContent = values.title || response.filename || "Processed track";
    $("#successArtist").textContent = values.artist || "Unknown artist";
    $("#successMessage").textContent = `Your file is ready to download (${formatBytes(response.size)}). The link remains available for about one hour; a device-local copy is being saved in the background.`;
    const art = $("#successCoverPreview");
    art.src = state.artworkBlob && !state.removeArtwork ? URL.createObjectURL(state.artworkBlob) : PLACEHOLDER;
    showModal("successModal");
    $("#btnSuccessLibrary").onclick = () => { closeModal("successModal"); showView("view-library"); void refreshLibrary(); };
  }

  async function persistGeneratedTrack(response, values, keepBackup) {
    const now = new Date().toISOString();
    const old = state.currentRecordId ? await window.MetatuneStore.getTrack(state.currentRecordId) : null;
    const record = {
      ...(old || {}), ...values, id: old?.id, title: values.title || cleanFilename(state.audioFile?.name),
      filename: response.filename, format: state.audioFile?.name.split(".").pop().toLowerCase() || "mp3",
      fileSize: response.size, duration: Number($("#playerDuration")?.dataset.seconds || 0) || old?.duration || 0,
      blob: null, sourceBlob: state.audioFile, artworkBlob: state.removeArtwork ? null : state.artworkBlob,
      artworkGenerated: Boolean(state.artworkGenerated && state.artworkBlob && !state.removeArtwork),
      jobId: response.job_id, downloadUrl: response.download_url, expiresAt: Date.now() + OUTPUT_TTL_MS,
      date: old?.date || now, createdAt: old?.createdAt || now, updatedAt: now, lastEdited: now,
      favorite: Boolean(old?.favorite), review: !values.title || !values.artist || !values.album || !values.genre || !values.year,
    };
    try {
      if (old) {
        const oldSnapshot = snapshotRecord(old);
        await window.MetatuneStore.addVersion(old.id, oldSnapshot);
        if (keepBackup && old.blob) {
          const backup = { ...old, id: undefined, title: `${old.title || "Track"} (Original backup)`, isBackup: true, date: now, createdAt: now, updatedAt: now };
          delete backup.id;
          await window.MetatuneStore.saveTrack(backup);
        }
        await window.MetatuneStore.updateTrack(old.id, record);
        state.currentRecordId = old.id;
      } else {
        state.currentRecordId = await window.MetatuneStore.saveTrack(record);
        await window.MetatuneStore.addVersion(state.currentRecordId, snapshotRecord({ ...record, ...state.baseline }));
      }
      await window.MetatuneStore.appendActivity({ trackId: state.currentRecordId, type: "exported", message: `Exported ${record.title}` });
      await refreshLibrary();
      return state.currentRecordId;
    } catch (error) {
      toast(`The file is ready, but local library storage failed: ${error.message}`, "warning", 8000);
      return null;
    }
  }

  function snapshotRecord(record) {
    return { values: Object.fromEntries(FIELDS.map((field) => [field, record[field] || ""])), artworkBlob: record.artworkBlob || null, artworkGenerated: Boolean(record.artworkGenerated), fileName: record.filename || "" };
  }

  async function cacheGeneratedOutput(response, saveTask) {
    try {
      const recordId = await saveTask;
      if (recordId == null) return;
      const url = new URL(response.download_url, window.location.origin);
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 120000);
      const result = await fetch(url, { signal: controller.signal });
      window.clearTimeout(timeout);
      if (!result.ok) throw new Error(`Download returned ${result.status}`);
      const blob = await result.blob();
      if (!blob.size) throw new Error("Downloaded file was empty.");
      await window.MetatuneStore.updateTrack(recordId, { blob, sourceBlob: null, fileSize: blob.size, cachedAt: new Date().toISOString() });
      toast("A local library copy is ready for offline playback.");
      if (state.playerTrackId === recordId || state.currentRecordId === recordId) {
        const record = await window.MetatuneStore.getTrack(recordId);
        if (record) setPlayer(record, { id: recordId });
      }
      await refreshLibrary();
    } catch (error) {
      toast("The download link is ready. Local caching did not finish; download the file before its one-hour link expires.", "warning", 9000);
    }
  }

  function setArtwork(blob, generated = false) {
    state.artworkBlob = blob || null;
    state.removeArtwork = false;
    state.artworkGenerated = Boolean(generated);
    state.coverEdited = false;
    setArtworkPreview(blob);
    updateCompletion();
  }

  function setArtworkPreview(blob) {
    const preview = $("#mainArtworkPreview");
    revokeUrl(state.artworkUrl); state.artworkUrl = "";
    if (blob) {
      state.artworkUrl = URL.createObjectURL(blob);
      if (preview) preview.src = state.artworkUrl;
    } else if (preview) preview.src = PLACEHOLDER;
    if (preview) preview.alt = blob ? "Selected album artwork" : "No album artwork selected";
  }

  function bindArtwork() {
    const input = $("#coverImage");
    const preview = $("#mainArtworkPreview");
    const dropTargets = [$("#tab-artwork"), $(".artwork-preview-large")].filter(Boolean);
    input?.addEventListener("change", () => {
      const file = input.files?.[0]; input.value = "";
      if (!file) return;
      if (!["image/jpeg", "image/png"].includes(file.type)) { toast("Artwork must be a JPG or PNG image.", "error"); return; }
      if (file.size > MAX_COVER_BYTES) { toast("Artwork must be 10 MB or smaller.", "error"); return; }
      checkpointBeforeChange(); setArtwork(file, false); state.dirty.add("artwork"); state.lastSnapshot = takeSnapshot(); toast("Artwork added.");
    });
    dropTargets.forEach((target) => {
      target.addEventListener("dragover", (event) => { event.preventDefault(); target.classList.add("drag-active"); });
      target.addEventListener("dragleave", () => target.classList.remove("drag-active"));
      target.addEventListener("drop", (event) => {
        event.preventDefault(); target.classList.remove("drag-active");
        const file = event.dataTransfer?.files?.[0]; if (file) { if (input) { const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files; input.dispatchEvent(new Event("change")); } }
      });
    });
    $("#btnRemoveArtwork")?.addEventListener("click", () => {
      if (!state.artworkBlob && !state.baselineArtwork) { toast("There is no artwork to remove.", "warning"); return; }
      checkpointBeforeChange(); state.artworkBlob = null; state.removeArtwork = true; state.artworkGenerated = false; setArtworkPreview(null); updateCompletion(); state.lastSnapshot = takeSnapshot(); toast("Artwork will be removed from the exported file.");
    });
    $("#btnCropCover")?.addEventListener("click", () => { if (!state.artworkBlob) return toast("Choose artwork before editing it.", "warning"); state.coverCropped = true; state.coverEdited = true; redrawCoverCanvas(); });
    $("#btnRotateCover")?.addEventListener("click", () => { if (!state.artworkBlob) return toast("Choose artwork before editing it.", "warning"); state.coverRotation = (state.coverRotation + 90) % 360; state.coverEdited = true; redrawCoverCanvas(); });
    ["coverBrightness", "coverContrast", "coverSaturation", "coverOverlayText"].forEach((id) => document.getElementById(id)?.addEventListener("input", () => { state.coverEdited = true; if (state.artworkBlob) redrawCoverCanvas(); }));
    $("#btnResetCover")?.addEventListener("click", () => {
      $("#coverBrightness").value = "100"; $("#coverContrast").value = "100"; $("#coverSaturation").value = "100"; $("#coverOverlayText").value = "";
      state.coverRotation = 0; state.coverCropped = false; state.coverEdited = false;
      if (state.artworkBlob) setArtworkPreview(state.artworkBlob);
    });
    $("#btnApplyCoverEdit")?.addEventListener("click", async () => {
      if (!state.artworkBlob) return toast("Choose artwork before editing it.", "warning");
      const canvas = $("#coverCanvas");
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      if (!blob) return toast("Could not export the edited artwork.", "error");
      checkpointBeforeChange(); setArtwork(blob, state.artworkGenerated); state.coverEdited = false; state.lastSnapshot = takeSnapshot(); toast("Artwork edits applied to the track.");
    });
    if (preview) preview.addEventListener("dblclick", () => $("#coverImage")?.click());
  }

  async function redrawCoverCanvas() {
    const source = state.artworkBlob;
    if (!source) return;
    const temporaryUrl = URL.createObjectURL(source);
    const image = new Image();
    image.onload = () => {
      const canvas = $("#coverCanvas"), context = canvas.getContext("2d");
      const rotate = state.coverRotation % 180 !== 0;
      const width = rotate ? image.height : image.width, height = rotate ? image.width : image.height;
      const side = state.coverCropped ? Math.min(width, height) : Math.max(width, height);
      const output = 1200;
      canvas.width = output; canvas.height = output;
      context.clearRect(0, 0, output, output);
      context.save(); context.translate(output / 2, output / 2); context.rotate((state.coverRotation * Math.PI) / 180);
      context.filter = `brightness(${$("#coverBrightness").value}%) contrast(${$("#coverContrast").value}%) saturate(${$("#coverSaturation").value}%)`;
      const scale = output / side;
      context.drawImage(image, -image.width * scale / 2, -image.height * scale / 2, image.width * scale, image.height * scale);
      context.restore(); context.filter = "none";
      const overlay = $("#coverOverlayText").value.trim();
      if (overlay) {
        context.font = "600 44px Inter, sans-serif"; context.textAlign = "center"; context.textBaseline = "bottom";
        context.lineWidth = 5; context.strokeStyle = "rgba(0,0,0,.7)"; context.fillStyle = "#fff";
        context.strokeText(overlay, output / 2, output - 56, output - 96); context.fillText(overlay, output / 2, output - 56, output - 96);
      }
      URL.revokeObjectURL(temporaryUrl);
      const previewUrl = URL.createObjectURL(canvasToBlobSync(canvas));
      revokeUrl(state.artworkUrl); state.artworkUrl = previewUrl;
      if ($("#mainArtworkPreview")) $("#mainArtworkPreview").src = previewUrl;
    };
    image.onerror = () => { URL.revokeObjectURL(temporaryUrl); toast("Could not load this artwork for editing.", "error"); };
    image.src = temporaryUrl;
  }

  function canvasToBlobSync(canvas) {
    return new Blob([Uint8Array.from(atob(canvas.toDataURL("image/jpeg", 0.88).split(",")[1]), (char) => char.charCodeAt(0))], { type: "image/jpeg" });
  }

  function revokeUrl(url) { if (url && url.startsWith("blob:")) URL.revokeObjectURL(url); }

  function bindAIStudio() {
    $("#generateAiBtn")?.addEventListener("click", () => void generateArtwork());
    $("#btnApplyArtwork")?.addEventListener("click", () => void applyGeneratedArtwork());
    $("#aiGallery")?.addEventListener("click", (event) => {
      const select = event.target.closest("[data-art-select]");
      const download = event.target.closest("[data-art-download]");
      if (select) { state.selectedAiIndex = Number(select.dataset.artSelect); renderAiGallery(); }
      if (download) void downloadArtwork(Number(download.dataset.artDownload));
    });
  }

  async function generateArtwork() {
    const prompt = $("#aiPrompt").value.trim();
    if (!prompt) { toast("Describe the artwork you want to create.", "warning"); $("#aiPrompt").focus(); return; }
    const style = $("#aiStyle").value, mood = $("#aiMood").value, color = $("#aiColor").value.trim(), aspect = $("#aiAspect").value;
    $("#generateAiBtn").disabled = true;
    $("#aiLoading").classList.remove("hidden"); $("#aiGallery").classList.add("hidden"); $("#btnApplyArtwork").classList.add("hidden");
    try {
      const result = await apiJSON("/api/generate-cover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, style, mood, color, aspect }) });
      state.aiImages = result.images || []; state.selectedAiIndex = state.aiImages.length ? 0 : -1;
      if (!state.aiImages.length) throw new Error("The artwork provider returned no variations.");
      renderAiGallery();
      toast("Artwork variations are ready.");
    } catch (error) { toast(error.message || "Artwork generation failed.", "error", 7500); }
    finally { $("#generateAiBtn").disabled = false; $("#aiLoading").classList.add("hidden"); }
  }

  function renderAiGallery() {
    const gallery = $("#aiGallery");
    gallery.innerHTML = state.aiImages.map((url, index) => `<article class="ai-variation ${index === state.selectedAiIndex ? "selected" : ""}"><button type="button" class="ai-variation-select" data-art-select="${index}" aria-label="Select variation ${index + 1}"><img src="${escapeHTML(url)}" alt="Generated artwork variation ${index + 1}" loading="lazy"><span>${index === state.selectedAiIndex ? "Selected" : `Variation ${index + 1}`}</span></button><button type="button" class="btn-text" data-art-download="${index}">Download</button></article>`).join("");
    gallery.classList.remove("hidden");
    $("#btnApplyArtwork").classList.toggle("hidden", state.selectedAiIndex < 0);
    refreshIcons(gallery);
  }

  async function fetchArtworkBlob(index) {
    const url = state.aiImages[index];
    if (!url) throw new Error("Select an artwork variation first.");
    const proxy = `/api/proxy-image?url=${encodeURIComponent(url)}`;
    const response = await fetch(proxy);
    if (!response.ok) {
      let detail = "Could not retrieve the generated artwork.";
      try { detail = (await response.json()).detail || detail; } catch (_) { /* use default */ }
      throw new Error(detail);
    }
    const blob = await response.blob();
    if (blob.size > MAX_COVER_BYTES) throw new Error("The generated artwork is larger than 10 MB.");
    return blob;
  }

  async function downloadArtwork(index) {
    try {
      const blob = await fetchArtworkBlob(index);
      const url = URL.createObjectURL(blob), anchor = document.createElement("a");
      anchor.href = url; anchor.download = `MetaTune_Artwork_${index + 1}.${blob.type === "image/png" ? "png" : "jpg"}`;
      document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 3000);
    } catch (error) { toast(error.message, "error"); }
  }

  async function applyGeneratedArtwork() {
    if (!state.audioFile) { toast("Open a track in Metadata Editor before applying artwork.", "warning"); showView("view-editor"); return; }
    try {
      const blob = await fetchArtworkBlob(state.selectedAiIndex);
      checkpointBeforeChange(); setArtwork(blob, true); state.lastSnapshot = takeSnapshot();
      showView("view-editor"); $$(".tab-btn").find((button) => button.dataset.tab === "tab-artwork")?.click();
      toast("Generated artwork applied to the current track.");
    } catch (error) { toast(error.message, "error"); }
  }

  function bindPlayer() {
    $("#playerPlayBtn")?.addEventListener("click", togglePlayback);
    $("#playerPreviousBtn")?.addEventListener("click", () => changeTrack(-1));
    $("#playerNextBtn")?.addEventListener("click", () => changeTrack(1));
    $("#playerSeek")?.addEventListener("input", (event) => { if (audio.duration) audio.currentTime = (Number(event.target.value) / 100) * audio.duration; });
    $("#playerVolume")?.addEventListener("input", (event) => { audio.volume = Number(event.target.value) / 100; if (audio.volume > 0) { state.mutedVolume = audio.volume; audio.muted = false; } updateMuteButton(); });
    $("#playerMuteBtn")?.addEventListener("click", () => { audio.muted = !audio.muted; updateMuteButton(); });
    $("#playerSpeed")?.addEventListener("change", () => { audio.playbackRate = Number($("#playerSpeed").value) || 1; });
    audio?.addEventListener("play", updatePlayButton);
    audio?.addEventListener("pause", updatePlayButton);
    audio?.addEventListener("timeupdate", updatePlayerTime);
    audio?.addEventListener("loadedmetadata", updatePlayerTime);
    audio?.addEventListener("ended", () => changeTrack(1));
    audio?.addEventListener("error", () => { if (audio.src) toast("The audio preview could not be played in this browser.", "error"); });
    updatePlayButton();
  }

  function setPlayer(fileOrRecord, options = {}) {
    const blob = fileOrRecord instanceof Blob ? fileOrRecord : (fileOrRecord.blob || fileOrRecord.sourceBlob);
    if (!blob) return;
    const previousTime = audio.currentTime || 0;
    const wasPlaying = !audio.paused;
    revokeUrl(state.playerObjectUrl);
    state.playerObjectUrl = URL.createObjectURL(blob);
    audio.src = state.playerObjectUrl;
    state.playerTrackId = options.id ?? fileOrRecord.id ?? null;
    const title = options.title || fileOrRecord.title || fileOrRecord.name || "Untitled track";
    const artist = options.artist || fileOrRecord.artist || "Unknown artist";
    $("#playerTitle").textContent = title;
    $("#playerArtist").textContent = artist;
    setPlayerArtwork(options.artworkBlob || fileOrRecord.artworkBlob || null);
    audio.playbackRate = Number(state.settings.playbackRate) || 1;
    $("#playerSpeed").value = String(audio.playbackRate);
    audio.addEventListener("loadedmetadata", function restorePosition() {
      audio.removeEventListener("loadedmetadata", restorePosition);
      if (Number.isFinite(previousTime) && previousTime > 0 && previousTime < audio.duration) audio.currentTime = previousTime;
      if (wasPlaying) void audio.play().catch(() => {});
    });
    if (state.playerTrackId != null) {
      state.playerQueue = state.library.filter((item) => item.blob || item.sourceBlob).map((item) => item.id);
      void window.MetatuneStore.updateTrack(state.playerTrackId, { lastPlayed: new Date().toISOString() }).then(() => refreshLibrary()).catch(() => {});
    }
    updatePlayButton();
  }

  function setPlayerArtwork(blob) {
    const image = $("#playerArt");
    if (!image) return;
    if (blob) {
      const artUrl = URL.createObjectURL(blob);
      const old = image.dataset.objectUrl; revokeUrl(old);
      image.dataset.objectUrl = artUrl; image.src = artUrl;
    } else { revokeUrl(image.dataset.objectUrl); image.dataset.objectUrl = ""; image.src = PLACEHOLDER; }
  }

  async function togglePlayback() {
    if (!audio.src) {
      if (state.audioFile) setPlayer(state.audioFile, { title: readValues().title, artist: readValues().artist, artworkBlob: state.artworkBlob });
      else { toast("Choose a track to play.", "warning"); return; }
    }
    if (audio.paused) { try { await audio.play(); } catch (_) { toast("Could not start playback. Tap play again to allow audio.", "warning"); } }
    else audio.pause();
  }

  function updatePlayButton() {
    const button = $("#playerPlayBtn"); if (!button) return;
    button.innerHTML = `<i data-lucide="${audio.paused ? "play" : "pause"}"></i>`;
    button.setAttribute("aria-label", audio.paused ? "Play" : "Pause"); refreshIcons(button);
  }

  function updatePlayerTime() {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    $("#playerTime").textContent = formatTime(audio.currentTime || 0);
    $("#playerDuration").textContent = formatTime(duration);
    $("#playerDuration").dataset.seconds = String(duration);
    $("#playerSeek").value = duration ? String((audio.currentTime / duration) * 100) : "0";
    if (state.analysis) {
      $("#waveformPosition").textContent = formatTime(audio.currentTime || 0);
      drawWaveform();
    }
  }

  function updateMuteButton() {
    const button = $("#playerMuteBtn"); if (!button) return;
    button.innerHTML = `<i data-lucide="${audio.muted || audio.volume === 0 ? "volume-x" : "volume-2"}"></i>`;
    button.setAttribute("aria-label", audio.muted ? "Unmute" : "Mute"); refreshIcons(button);
  }

  async function changeTrack(direction) {
    if (!state.playerQueue.length) await refreshLibrary();
    if (!state.playerQueue.length) return;
    let index = state.playerQueue.indexOf(state.playerTrackId);
    index = index < 0 ? 0 : (index + direction + state.playerQueue.length) % state.playerQueue.length;
    const record = await window.MetatuneStore.getTrack(state.playerQueue[index]);
    if (record) setPlayer(record, { id: record.id });
    void audio.play().catch(() => {});
  }

  function bindAnalyzer() {
    $("#analyzerChooseFile")?.addEventListener("click", () => $("#analyzerFile").click());
    $("#analyzerFile")?.addEventListener("change", (event) => { const file = event.target.files?.[0]; if (file) setAnalysisFile(file, null); event.target.value = ""; });
    $("#btnAnalyze")?.addEventListener("click", () => void runAnalysis());
    $("#waveformZoom")?.addEventListener("input", (event) => { state.waveformZoom = Number(event.target.value) || 1; drawWaveform(); });
    $("#waveformCanvas")?.addEventListener("click", (event) => {
      if (!state.analysis || !audio.duration) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      const zoom = state.waveformZoom, center = audio.duration ? audio.currentTime / audio.duration : 0.5;
      const start = Math.max(0, Math.min(1 - 1 / zoom, center - 0.5 / zoom));
      audio.currentTime = Math.max(0, Math.min(audio.duration, (start + ratio / zoom) * audio.duration));
    });
    window.addEventListener("resize", () => { if (state.analysis) { drawWaveform(); drawSpectrum(); drawSpectrogram(); } });
  }

  function setAnalysisFile(file, trackId) {
    if (!validAudio(file)) return;
    state.analysisFile = file; state.analysisTrackId = trackId;
    setPlayer(file, { id: trackId, title: file.name, artist: "Local audio file" });
    $("#analyzerEmpty").classList.remove("hidden"); $("#analyzerEmpty").querySelector("h3").textContent = file.name;
    $("#analyzerEmpty").querySelector("p").textContent = `${formatBytes(file.size)} · Ready for local analysis.`;
    $("#analyzerResults").classList.add("hidden"); $("#btnAnalyze").disabled = false;
  }

  async function runAnalysis() {
    const file = state.analysisFile || state.audioFile;
    if (!file) { toast("Choose an MP3 or M4A file to analyze.", "warning"); return; }
    $("#btnAnalyze").disabled = true;
    $("#analysisProgress").textContent = "Starting local analysis…";
    try {
      state.analysis = await window.MetatuneAudioAnalysis.analyze(file, (status) => { $("#analysisProgress").textContent = status; });
      renderAnalysis(state.analysis);
      if (state.analysisTrackId != null) await window.MetatuneStore.saveAnalysis(state.analysisTrackId, state.analysis);
      toast("Local audio analysis complete.");
    } catch (error) { toast(error.message || "Analysis failed.", "error", 8000); }
    finally { $("#btnAnalyze").disabled = false; $("#analysisProgress").textContent = ""; }
  }

  function renderAnalysis(result) {
    $("#analyzerEmpty").classList.add("hidden"); $("#analyzerResults").classList.remove("hidden");
    $("#qualityScore").textContent = result.score;
    $("#qualityGrade").textContent = `${result.grade} quality estimate`;
    $("#qualityAdvice").textContent = `${result.recommendations.length ? result.recommendations[0] : "Audio decoded and measured locally."} Values are estimates and can vary by browser decoder.`;
    $("#waveformDuration").textContent = formatTime(result.duration);
    const metrics = [
      ["Average bitrate", `${Math.round(result.bitrate / 1000)} kbps · estimated`], ["Sample rate", `${(result.sampleRate / 1000).toFixed(1)} kHz`],
      ["Channels", result.channels === 1 ? "Mono" : `${result.channels} channels`], ["Integrated loudness", formatDb(result.integratedLufs, " LUFS")],
      ["Sample peak", formatDb(result.samplePeakDb, " dBFS")], ["Inter-sample peak estimate", formatDb(result.interSamplePeakDb, " dBFS")],
      ["Loudness range estimate", formatDb(result.loudnessRange, " LU")], ["RMS level", formatDb(result.rmsDb, " dBFS")],
      ["Tempo estimate", result.bpm ? `${result.bpm} BPM · ${Math.round(result.bpmConfidence * 100)}% confidence` : "Not detected"],
      ["Key estimate", result.key === "Not detected" ? result.key : `${result.key} · ${Math.round(result.keyConfidence * 100)}% confidence`],
      ["Silence estimate", `${result.silenceSeconds.toFixed(1)} s`], ["Clipped samples", result.clippedSamples.toLocaleString()],
    ];
    $("#analysisMetrics").innerHTML = metrics.map(([label, value]) => `<div class="metric-card"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong></div>`).join("");
    $("#analysisFindings").innerHTML = result.recommendations.map((text) => `<div class="analysis-finding ${/clip|peak|below|high/i.test(text) ? "warning" : ""}"><i data-lucide="${/clip|peak|below|high/i.test(text) ? "triangle-alert" : "check"}"></i><span>${escapeHTML(text)}</span></div>`).join("");
    refreshIcons($("#analysisFindings"));
    drawWaveform(); drawSpectrum(); drawSpectrogram();
  }

  function setupCanvas(canvas) {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio);
    const context = canvas.getContext("2d"); context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { context, width: rect.width, height: rect.height };
  }

  function drawWaveform() {
    if (!state.analysis) return;
    const canvas = $("#waveformCanvas"), surface = setupCanvas(canvas); if (!surface) return;
    const { context: ctx, width, height } = surface, waveform = state.analysis.waveform;
    ctx.clearRect(0, 0, width, height); ctx.fillStyle = "#101010"; ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(255,255,255,.07)"; ctx.beginPath(); ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2); ctx.stroke();
    const count = waveform.length / 2, zoom = state.waveformZoom;
    const center = audio.duration ? audio.currentTime / audio.duration : 0.5;
    const start = Math.max(0, Math.min(1 - 1 / zoom, center - 0.5 / zoom));
    const begin = Math.floor(start * count), end = Math.min(count, Math.ceil((start + 1 / zoom) * count));
    const step = Math.max(1, (end - begin) / width);
    ctx.fillStyle = "#1ed760";
    for (let x = 0; x < width; x++) {
      const index = Math.min(end - 1, begin + Math.floor(x * step));
      const low = waveform[index * 2] || 0, high = waveform[index * 2 + 1] || 0;
      const top = (1 - high) * height / 2, bottom = (1 - low) * height / 2;
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
    if (audio.duration && state.playerTrackId != null) {
      const current = audio.currentTime / audio.duration;
      const visible = (current - start) * zoom;
      if (visible >= 0 && visible <= 1) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(visible * width, 0); ctx.lineTo(visible * width, height); ctx.stroke(); }
    }
  }

  function drawSpectrum() {
    if (!state.analysis) return;
    const surface = setupCanvas($("#spectrumCanvas")); if (!surface) return;
    const { context: ctx, width, height } = surface, values = state.analysis.spectrum;
    ctx.clearRect(0, 0, width, height); ctx.fillStyle = "#101010"; ctx.fillRect(0, 0, width, height);
    const bar = width / values.length;
    for (let index = 0; index < values.length; index++) {
      const normalized = Math.max(0, Math.min(1, (values[index] + 90) / 90));
      const h = normalized * (height - 12);
      ctx.fillStyle = `hsl(${145 - normalized * 28} 70% ${34 + normalized * 20}%)`;
      ctx.fillRect(index * bar, height - h, Math.max(1, bar), h);
    }
  }

  function drawSpectrogram() {
    if (!state.analysis) return;
    const surface = setupCanvas($("#spectrogramCanvas")); if (!surface) return;
    const { context: ctx, width, height } = surface, values = state.analysis.spectrogram;
    const columns = 72, rows = 72, cellW = width / columns, cellH = height / rows;
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
      const power = values[y * columns + x] / 255;
      ctx.fillStyle = `hsl(${245 - power * 100} 74% ${10 + power * 58}%)`;
      ctx.fillRect(x * cellW, y * cellH, Math.ceil(cellW), Math.ceil(cellH));
    }
  }

  function bindLibrary() {
    $("#libSearch")?.addEventListener("input", renderLibrary);
    $("#libFormat")?.addEventListener("change", renderLibrary);
    $("#libSort")?.addEventListener("change", renderLibrary);
    $$("[data-library-filter]").forEach((button) => button.addEventListener("click", () => {
      state.libraryFilter = button.dataset.libraryFilter;
      $$("[data-library-filter]").forEach((node) => node.classList.toggle("active", node === button));
      renderLibrary();
    }));
    $("#btnLibraryView")?.addEventListener("click", () => { state.libraryList = !state.libraryList; $("#libraryGrid").classList.toggle("list-view", state.libraryList); $("#btnLibraryView").setAttribute("aria-label", state.libraryList ? "Switch to grid view" : "Switch to list view"); renderLibrary(); });
    $("#btnExportLibraryManifest")?.addEventListener("click", downloadLibraryManifest);
    $("#btnDownloadLibraryIndex")?.addEventListener("click", downloadLibraryManifest);
    $("#libraryGrid")?.addEventListener("click", (event) => void handleLibraryAction(event));
    $("#dashboardRecentList")?.addEventListener("click", (event) => void handleLibraryAction(event));
  }

  async function refreshLibrary() {
    try { state.library = await window.MetatuneStore.all("library"); }
    catch (error) { toast(`Could not load this browser's library: ${error.message}`, "error", 7500); return; }
    state.library.sort((a, b) => (b.updatedAt || b.date || "").localeCompare(a.updatedAt || a.date || ""));
    renderLibrary(); renderDashboard(); renderStorage();
  }

  function getArtworkSource(track, scope = "library") {
    if (track.artworkBlob instanceof Blob) {
      const url = URL.createObjectURL(track.artworkBlob); (scope === "dashboard" ? state.dashboardUrls : state.libraryUrls).push(url); return url;
    }
    if (typeof track.artworkData === "string" && track.artworkData.startsWith("data:image/")) return track.artworkData;
    if (typeof track.artSrc === "string" && track.artSrc.startsWith("data:image/")) return track.artSrc;
    if (typeof track.artSrc === "string") {
      try { const parsed = new URL(track.artSrc); if (parsed.protocol === "https:" && parsed.hostname === "image.pollinations.ai") return parsed.href; } catch (_) { /* invalid stored URL */ }
    }
    return PLACEHOLDER;
  }

  function renderLibrary() {
    const grid = $("#libraryGrid"); if (!grid) return;
    state.libraryUrls.forEach(revokeUrl); state.libraryUrls = [];
    const query = $("#libSearch")?.value.trim().toLowerCase() || "";
    const format = $("#libFormat")?.value || "all";
    let list = state.library.filter((track) => {
      const text = [track.title, track.artist, track.album, track.genre, track.filename].join(" ").toLowerCase();
      if (query && !text.includes(query)) return false;
      if (format !== "all" && (track.format || "").toLowerCase() !== format) return false;
      if (state.libraryFilter === "favorites" && !track.favorite) return false;
      if (state.libraryFilter === "recent" && !track.lastPlayed) return false;
      if (state.libraryFilter === "review" && !track.review) return false;
      return true;
    });
    const sort = $("#libSort")?.value || "recent";
    list.sort((a, b) => sort === "title" ? String(a.title).localeCompare(String(b.title)) : sort === "artist" ? String(a.artist).localeCompare(String(b.artist)) : sort === "duration" ? (a.duration || 0) - (b.duration || 0) : sort === "size" ? (a.fileSize || 0) - (b.fileSize || 0) : (b.updatedAt || b.date || "").localeCompare(a.updatedAt || a.date || ""));
    if (["albums", "artists", "genres"].includes(state.libraryFilter)) {
      const key = state.libraryFilter === "albums" ? "album" : state.libraryFilter === "artists" ? "artist" : "genre";
      const groups = new Map();
      list.forEach((track) => { const name = track[key] || `Unknown ${key}`; if (!groups.has(name)) groups.set(name, []); groups.get(name).push(track); });
      grid.innerHTML = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, tracks]) => {
        const first = tracks[0];
        return `<article class="lib-card lib-album-card"><img class="lib-art" src="${escapeHTML(getArtworkSource(first))}" alt=""><div><p class="eyebrow">${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}</p><h3>${escapeHTML(name)}</h3><p class="text-muted">${escapeHTML(first.artist || "Unknown artist")}</p><button class="btn-text" data-track-action="play" data-track-id="${first.id}">Play collection</button></div></article>`;
      }).join("");
    } else {
      grid.innerHTML = list.length ? list.map((track) => libraryCard(track)).join("") : `<div class="empty-state"><i data-lucide="music-2"></i><p>${state.library.length ? "No tracks match these filters." : "Your local library is empty. Export a track to save it here."}</p></div>`;
    }
    if (!list.length && ["albums", "artists", "genres"].includes(state.libraryFilter)) grid.innerHTML = `<div class="empty-state"><i data-lucide="library"></i><p>No ${escapeHTML(state.libraryFilter)} yet.</p></div>`;
    $("#librarySummary").textContent = `${list.length} ${list.length === 1 ? "track" : "tracks"}${state.libraryFilter !== "tracks" ? ` · ${state.libraryFilter}` : ""}`;
    grid.classList.toggle("list-view", state.libraryList);
    refreshIcons(grid);
  }

  function libraryCard(track) {
    const ready = track.blob instanceof Blob || track.sourceBlob instanceof Blob;
    const expiry = track.expiresAt && track.expiresAt < Date.now();
    return `<article class="lib-card ${state.libraryList ? "list-item" : ""}" data-track-id="${track.id}">
      <img class="lib-art" src="${escapeHTML(getArtworkSource(track))}" alt="${escapeHTML(track.title || "Album artwork")}" loading="lazy">
      <div class="lib-meta"><div class="lib-title" title="${escapeHTML(track.title || "Untitled")}">${escapeHTML(track.title || "Untitled")}</div><div class="lib-artist">${escapeHTML(track.artist || "Unknown artist")}</div></div>
      ${state.libraryList ? `<div class="lib-album">${escapeHTML(track.album || "")}</div>` : ""}
      <div class="lib-duration">${formatTime(durationSeconds(track.duration))} · ${escapeHTML((track.format || track.filename?.split(".").pop() || "").toUpperCase())}</div>
      <div class="lib-actions"><button class="btn-icon lib-play" data-track-action="play" data-track-id="${track.id}" aria-label="Play ${escapeHTML(track.title)}"><i data-lucide="play"></i></button><button class="btn-icon favorite-button ${track.favorite ? "is-favorite" : ""}" data-track-action="favorite" data-track-id="${track.id}" aria-label="${track.favorite ? "Remove from" : "Add to"} favorites"><i data-lucide="heart"></i></button><button class="btn-icon" data-track-action="edit" data-track-id="${track.id}" aria-label="Edit track"><i data-lucide="pencil"></i></button>${track.downloadUrl && !expiry ? `<a class="btn-icon" href="${escapeHTML(new URL(track.downloadUrl, location.origin).href)}" download="${escapeHTML(track.filename || "track")}" aria-label="Download"><i data-lucide="download"></i></a>` : ""}<button class="btn-icon text-danger" data-track-action="delete" data-track-id="${track.id}" aria-label="Delete track"><i data-lucide="trash-2"></i></button></div>
      ${!ready ? `<small class="text-muted">${expiry ? "Temporary download expired" : "Caching local copy…"}</small>` : ""}${track.isBackup ? "<small class='text-muted'>Original backup</small>" : ""}</article>`;
  }

  async function handleLibraryAction(event) {
    const control = event.target.closest("[data-track-action]");
    if (!control) return;
    const id = Number(control.dataset.trackId); if (!id) return;
    const action = control.dataset.trackAction;
    const track = await window.MetatuneStore.getTrack(id);
    if (!track) return;
    if (action === "play") {
      if (!(track.blob instanceof Blob) && !(track.sourceBlob instanceof Blob)) {
        if (track.downloadUrl && (!track.expiresAt || track.expiresAt > Date.now())) { window.location.href = new URL(track.downloadUrl, location.origin).href; return; }
        toast("This track is not cached on this device and its temporary download has expired.", "warning", 7500); return;
      }
      state.playerQueue = state.library.filter((item) => item.blob || item.sourceBlob).map((item) => item.id);
      setPlayer(track, { id }); void audio.play().catch(() => {});
    } else if (action === "favorite") {
      await window.MetatuneStore.updateTrack(id, { favorite: !track.favorite }); await refreshLibrary();
    } else if (action === "edit") {
      const fileBlob = track.blob || track.sourceBlob;
      if (!fileBlob) { toast("This track has not finished caching locally. Download it, then open it in the editor.", "warning", 7500); return; }
      const file = new File([fileBlob], track.filename || `${track.title || "track"}.${track.format || "mp3"}`, { type: fileBlob.type || "audio/mpeg" });
      await handleAudioFile(file, { trackId: id, record: track });
    } else if (action === "delete") {
      if (!window.confirm(`Remove “${track.title || "this track"}” and its local history from this browser?`)) return;
      await window.MetatuneStore.deleteTrack(id); await refreshLibrary(); toast("Track removed from this device.");
    }
  }

  function renderDashboard() {
    state.dashboardUrls.forEach(revokeUrl); state.dashboardUrls = [];
    const tracks = state.library;
    $("#statTracks").textContent = tracks.length.toLocaleString();
    $("#statArtworks").textContent = tracks.filter((track) => track.artworkGenerated).length.toLocaleString();
    const bytes = tracks.reduce((total, track) => total + (track.blob?.size || track.sourceBlob?.size || 0) + (track.artworkBlob?.size || 0), 0);
    $("#statStorage").textContent = formatBytes(bytes);
    $("#statReview").textContent = tracks.filter((track) => track.review).length.toLocaleString();
    $("#dashboardTrackSummary").textContent = tracks.length ? `${tracks.length} saved ${tracks.length === 1 ? "track" : "tracks"}` : "No tracks yet";
    renderChart("genreChart", countBy(tracks, "genre"));
    renderChart("formatChart", countBy(tracks, "format"));
    const recent = [...tracks].sort((a, b) => (b.updatedAt || b.date || "").localeCompare(a.updatedAt || a.date || "")).slice(0, 6);
    const container = $("#dashboardRecentList");
    container.innerHTML = recent.length ? recent.map((track) => `<article class="recent-item"><img src="${escapeHTML(getArtworkSource(track, "dashboard"))}" alt="" class="recent-art"><div class="recent-meta"><strong>${escapeHTML(track.title || "Untitled")}</strong><span>${escapeHTML(track.artist || "Unknown artist")} · ${escapeHTML(track.album || "Single")}</span><small>Edited ${escapeHTML(formatRelative(track.updatedAt || track.date))}</small></div><div class="recent-actions"><button class="btn-icon" data-track-action="play" data-track-id="${track.id}" aria-label="Play"><i data-lucide="play"></i></button><button class="btn-icon" data-track-action="edit" data-track-id="${track.id}" aria-label="Edit"><i data-lucide="pencil"></i></button></div></article>`).join("") : `<div class="empty-state"><i data-lucide="inbox"></i><p>No recent activity. Upload a track to get started.</p></div>`;
    refreshIcons(container);
  }

  function countBy(tracks, key) {
    const counts = new Map();
    tracks.forEach((track) => { const value = track[key] || `Unknown ${key}`; counts.set(value, (counts.get(value) || 0) + 1); });
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }

  function renderChart(id, entries) {
    const chart = document.getElementById(id); if (!chart) return;
    const max = Math.max(1, ...entries.map(([, count]) => count));
    chart.innerHTML = entries.length ? entries.map(([name, count]) => `<div class="chart-row"><span class="truncate" title="${escapeHTML(name)}">${escapeHTML(name)}</span><div class="chart-track"><div class="chart-fill" style="width:${Math.round(count / max * 100)}%"></div></div><span class="chart-count">${count}</span></div>`).join("") : `<p class="text-muted">Saved tracks will appear here.</p>`;
  }

  function formatRelative(value) {
    if (!value) return "just now";
    const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24); return days < 30 ? `${days}d ago` : new Date(value).toLocaleDateString();
  }

  function renderStorage() {
    const bytes = state.library.reduce((total, track) => total + (track.blob?.size || track.sourceBlob?.size || 0) + (track.artworkBlob?.size || 0), 0);
    $("#settingsStorageUsed").textContent = formatBytes(bytes);
    void navigator.storage?.estimate?.().then((info) => {
      const usage = info.quota ? Math.min(100, (bytes / info.quota) * 100) : 0;
      $("#settingsStorageBar").style.width = `${usage}%`;
    }).catch(() => {});
  }

  function downloadLibraryManifest() {
    const tracks = state.library.map((track) => ({ id: track.id, title: track.title, artist: track.artist, album: track.album, genre: track.genre, year: track.year, duration: track.duration, format: track.format, fileSize: track.fileSize, filename: track.filename, createdAt: track.createdAt, updatedAt: track.updatedAt, favorite: track.favorite, artworkGenerated: track.artworkGenerated }));
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), storage: "This browser only", tracks }, null, 2)], { type: "application/json" });
    downloadBlob(blob, "metatune-library-index.json");
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob), anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  function bindBatch() {
    $("#btnBatchChoose")?.addEventListener("click", () => $("#batchFiles").click());
    $("#batchFiles")?.addEventListener("change", (event) => { void addBatchFiles([...event.target.files]); event.target.value = ""; });
    const zone = $("#batchDropZone");
    zone?.addEventListener("click", () => $("#batchFiles").click());
    ["dragenter", "dragover"].forEach((name) => zone?.addEventListener(name, (event) => { event.preventDefault(); zone.classList.add("drag-active"); }));
    ["dragleave", "drop"].forEach((name) => zone?.addEventListener(name, (event) => { event.preventDefault(); zone.classList.remove("drag-active"); }));
    zone?.addEventListener("drop", (event) => { void addBatchFiles([...event.dataTransfer.files]); });
    $("#batchRows")?.addEventListener("input", updateBatchField);
    $("#batchRows")?.addEventListener("change", updateBatchSelection);
    $("#batchRows")?.addEventListener("click", (event) => { const remove = event.target.closest("[data-batch-remove]"); if (remove) { state.batch = state.batch.filter((item) => item.id !== remove.dataset.batchRemove); renderBatch(); } });
    $("#batchSelectAll")?.addEventListener("change", (event) => { state.batch.forEach((item) => { item.selected = event.target.checked; }); renderBatch(); });
    $("#btnBatchApply")?.addEventListener("click", applyBatchBulkValues);
    $("#btnBatchClear")?.addEventListener("click", () => { if (state.batchBusy) return; state.batch = []; renderBatch(); });
    $("#btnBatchProcess")?.addEventListener("click", () => void processBatch());
    $("#btnBatchDownloadZip")?.addEventListener("click", () => void downloadBatchZip());
    $("#batchFilenameTemplate")?.addEventListener("change", renderBatch);
  }

  async function addBatchFiles(files) {
    if (state.batchBusy) return toast("Wait for the current batch to finish.", "warning");
    const incoming = [];
    let total = state.batch.reduce((sum, item) => sum + item.file.size, 0);
    for (const file of files) {
      if (state.batch.length + incoming.length >= MAX_BATCH_FILES) { toast(`A batch can contain up to ${MAX_BATCH_FILES} files.`, "warning"); break; }
      if (!validAudio(file)) continue;
      if (state.batch.some((item) => item.file.name === file.name) || incoming.some((item) => item.file.name === file.name)) { toast(`Skipped duplicate file name: ${file.name}`, "warning"); continue; }
      total += file.size;
      if (total > MAX_BATCH_BYTES) { toast("Batch source files are limited to 250 MB total.", "warning"); break; }
      const guess = parseFilename(file.name);
      incoming.push({ id: crypto.randomUUID(), file, title: guess.title, artist: guess.artist, album: "", genre: "", year: "", track: "", selected: true, status: "Reading tags", jobId: "", downloadUrl: "", filename: "" });
    }
    if (!incoming.length) return;
    state.batch.push(...incoming); renderBatch();
    const queue = [...incoming];
    const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift(); if (!item) return;
        try {
          const body = new FormData(); body.append("audio_file", item.file, item.file.name);
          const result = await apiJSON("/api/read-metadata", { method: "POST", body });
          for (const field of ["title", "artist", "album", "genre", "year", "track"]) if (result.metadata?.[field]) item[field] = result.metadata[field];
          item.status = "Ready";
        } catch (_) { item.status = "Ready · filename only"; }
        renderBatch();
      }
    });
    await Promise.all(workers);
  }

  function renderBatch() {
    const tbody = $("#batchRows");
    const template = $("#batchFilenameTemplate")?.value || state.settings.filenameTemplate;
    tbody.innerHTML = state.batch.map((item) => {
      const values = { title: item.title, artist: item.artist, album: item.album, track: item.track || "" };
      const outputName = filenameFromTemplate(template, values, item.file.name);
      return `<tr data-batch-id="${escapeHTML(item.id)}"><td><input type="checkbox" data-batch-field="selected" ${item.selected ? "checked" : ""} aria-label="Select ${escapeHTML(item.file.name)}"></td><td><span class="batch-file-name" title="${escapeHTML(item.file.name)}">${escapeHTML(item.file.name)}</span></td>${["title", "artist", "album", "genre", "year"].map((field) => `<td><input type="${field === "year" ? "number" : "text"}" data-batch-field="${field}" value="${escapeHTML(item[field])}" aria-label="${LABELS[field]} for ${escapeHTML(item.file.name)}"></td>`).join("")}<td><span class="batch-file-name" data-batch-output title="${escapeHTML(outputName)}">${escapeHTML(outputName)}</span></td><td><span class="batch-state ${item.status === "Complete" ? "complete" : item.status.startsWith("Failed") ? "failed" : ""}">${escapeHTML(item.status)}</span></td><td><button type="button" class="btn-icon text-danger" data-batch-remove="${escapeHTML(item.id)}" aria-label="Remove ${escapeHTML(item.file.name)}"><i data-lucide="x"></i></button></td></tr>`;
    }).join("");
    $("#batchEmpty").classList.toggle("hidden", state.batch.length > 0);
    $("#batchSelectAll").checked = Boolean(state.batch.length && state.batch.every((item) => item.selected));
    const selected = state.batch.filter((item) => item.selected);
    const bytes = state.batch.reduce((sum, item) => sum + item.file.size, 0);
    $("#batchSummary").textContent = `${state.batch.length} files · ${formatBytes(bytes)} · ${selected.length} selected`;
    $("#btnBatchProcess").disabled = state.batchBusy || !selected.some((item) => item.status === "Ready" || item.status === "Ready · filename only" || item.status.startsWith("Failed"));
    const completed = state.batch.filter((item) => item.jobId).length;
    $("#btnBatchDownloadZip").disabled = state.batchBusy || completed === 0;
    refreshIcons(tbody);
  }

  function updateBatchField(event) {
    const row = event.target.closest("[data-batch-id]"); if (!row) return;
    const item = state.batch.find((entry) => entry.id === row.dataset.batchId); if (!item) return;
    const field = event.target.dataset.batchField; if (field && field !== "selected") item[field] = event.target.value;
    if (field) item.status = item.jobId ? "Complete" : "Ready";
    const output = row.querySelector("[data-batch-output]");
    if (output) {
      const template = $("#batchFilenameTemplate")?.value || state.settings.filenameTemplate;
      const name = filenameFromTemplate(template, item, item.file.name);
      output.textContent = name; output.title = name;
    }
  }

  function updateBatchSelection(event) {
    const row = event.target.closest("[data-batch-id]"); if (!row) return;
    const item = state.batch.find((entry) => entry.id === row.dataset.batchId); if (!item) return;
    if (event.target.dataset.batchField === "selected") item.selected = event.target.checked;
    renderBatch();
  }

  function applyBatchBulkValues() {
    const selected = state.batch.filter((item) => item.selected && !item.jobId);
    if (!selected.length) return toast("Select at least one unprocessed track.", "warning");
    const bulk = { artist: $("#batchArtist").value.trim(), genre: $("#batchGenre").value.trim(), album: $("#batchAlbum").value.trim(), year: $("#batchYear").value.trim() };
    selected.forEach((item) => { for (const [field, value] of Object.entries(bulk)) if (value) item[field] = value; });
    renderBatch(); toast(`Updated ${selected.length} selected ${selected.length === 1 ? "track" : "tracks"}.`);
  }

  async function processBatch() {
    if (state.batchBusy) return;
    const queue = state.batch.filter((item) => item.selected && !item.jobId);
    if (!queue.length) return toast("Select unprocessed tracks first.", "warning");
    state.batchBusy = true; $("#batchProgress").classList.remove("hidden");
    const exportTemplate = $("#batchFilenameTemplate")?.value || state.settings.filenameTemplate;
    let complete = 0;
    for (const item of queue) {
      item.status = "Processing"; renderBatch();
      $("#batchProgressText").textContent = `Processing ${item.file.name}`;
      try {
        const values = { ...EMPTY, title: item.title, artist: item.artist, album: item.album, genre: item.genre, year: item.year };
        const form = formDataForMetadata(item.file, null, values, { cleanFilename: true, outputFilename: filenameFromTemplate(exportTemplate, values, item.file.name).replace(/\.[^.]+$/, "") });
        const result = await apiJSON("/generate", { method: "POST", body: form });
        item.jobId = result.job_id; item.downloadUrl = result.download_url; item.filename = result.filename; item.status = "Complete";
        const record = { ...values, filename: result.filename, format: item.file.name.split(".").pop().toLowerCase(), fileSize: result.size, duration: 0, blob: null, sourceBlob: item.file, artworkBlob: null, artworkGenerated: false, jobId: result.job_id, downloadUrl: result.download_url, expiresAt: Date.now() + OUTPUT_TTL_MS, date: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastEdited: new Date().toISOString(), favorite: false, review: !values.title || !values.artist || !values.album || !values.genre || !values.year };
        item.localId = await window.MetatuneStore.saveTrack(record);
        void cacheGeneratedOutput(result, Promise.resolve(item.localId));
      } catch (error) { item.status = `Failed · ${error.message}`; }
      complete++; const percent = Math.round((complete / queue.length) * 100);
      $("#batchProgressText").textContent = `${complete} / ${queue.length} complete`;
      $("#batchProgressPercent").textContent = `${percent}%`; $("#batchProgressBar").style.width = `${percent}%`;
      renderBatch(); await refreshLibrary();
    }
    state.batchBusy = false; renderBatch();
    toast(`${complete} selected ${complete === 1 ? "track was" : "tracks were"} processed.`);
  }

  async function downloadBatchZip() {
    const jobIds = state.batch.filter((item) => item.jobId).map((item) => item.jobId);
    if (!jobIds.length) return toast("Process at least one track before creating a ZIP.", "warning");
    try {
      const result = await apiJSON("/api/export-zip", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job_ids: jobIds }) });
      const anchor = document.createElement("a"); anchor.href = new URL(result.download_url, location.origin).href; anchor.download = result.filename; document.body.append(anchor); anchor.click(); anchor.remove();
      toast(`ZIP is ready (${formatBytes(result.size)}).`);
    } catch (error) { toast(error.message || "Could not create ZIP export.", "error", 7500); }
  }

  async function openHistory() {
    const items = [];
    if (state.currentRecordId != null) {
      try { items.push(...await window.MetatuneStore.versionsFor(state.currentRecordId)); } catch (_) { /* keep in-session history */ }
    }
    const sessions = [...state.past].reverse().map((snapshot, index) => ({ id: `session-${index}`, createdAt: new Date(Date.now() - index * 1000).toISOString(), snapshot, session: true }));
    items.push(...sessions);
    const container = $("#historyList");
    container.innerHTML = items.length ? items.map((item, index) => {
      const snapshot = item.snapshot || {};
      const values = snapshot.values || {};
      const summary = [values.title, values.artist, values.album].filter(Boolean).join(" · ") || "Metadata snapshot";
      return `<article class="history-entry"><div><strong>${escapeHTML(summary)}</strong><small>${escapeHTML(new Date(item.createdAt).toLocaleString())}${item.session ? " · this editing session" : " · saved version"}</small><details><summary>Preview</summary><pre>${escapeHTML(FIELDS.map((field) => `${LABELS[field]}: ${values[field] || "—"}`).join("\n"))}\nArtwork: ${snapshot.artworkBlob ? "Present" : "None"}</pre></details></div><button class="btn-secondary btn-sm" data-history-restore="${escapeHTML(String(index))}">Restore</button></article>`;
    }).join("") : `<div class="empty-state"><i data-lucide="history"></i><p>No saved versions yet. Edits in this session can still be undone.</p></div>`;
    container.querySelectorAll("[data-history-restore]").forEach((button) => button.addEventListener("click", () => {
      const item = items[Number(button.dataset.historyRestore)];
      if (!item?.snapshot) return;
      if (!window.confirm("Restore this metadata version? The current edits will remain available through Undo.")) return;
      checkpointBeforeChange(); restoreSnapshot({ values: item.snapshot.values || { ...EMPTY }, artworkBlob: item.snapshot.artworkBlob || null, removeArtwork: false, artworkGenerated: item.snapshot.artworkGenerated });
      closeModal("historyModal"); toast("Metadata version restored.");
    }));
    showModal("historyModal");
  }

  function bindSettings() {
    $("#btnSaveSettings")?.addEventListener("click", async () => {
      state.settings = { filenameTemplate: $("#settingsFilenameTemplate").value, playbackRate: Number($("#settingsPlaybackRate").value) || 1, reducedMotion: $("#settingsReducedMotion").checked };
      try { await window.MetatuneStore.saveSettings(state.settings); } catch (error) { toast(`Could not save preferences: ${error.message}`, "error"); return; }
      applySettings(); toast("Preferences saved in this browser.");
    });
    $("#btnClearLibrary")?.addEventListener("click", async () => {
      if (!state.library.length) return toast("This browser's library is already empty.", "warning");
      if (!window.confirm(`Permanently remove ${state.library.length} local ${state.library.length === 1 ? "track" : "tracks"}, artwork, analysis, and version history from this browser?`)) return;
      await window.MetatuneStore.clearLibrary(); state.library = []; await refreshLibrary(); toast("This browser's library was cleared.");
    });
  }

  async function loadSettings() {
    try {
      const [filenameTemplate, playbackRate, reducedMotion] = await Promise.all([
        window.MetatuneStore.getSetting("filenameTemplate", state.settings.filenameTemplate),
        window.MetatuneStore.getSetting("playbackRate", state.settings.playbackRate),
        window.MetatuneStore.getSetting("reducedMotion", false),
      ]);
      state.settings = { filenameTemplate, playbackRate, reducedMotion };
    } catch (error) { toast(`Local preferences could not be read: ${error.message}`, "warning"); }
    $("#settingsFilenameTemplate").value = state.settings.filenameTemplate;
    $("#batchFilenameTemplate").value = state.settings.filenameTemplate;
    $("#settingsPlaybackRate").value = String(state.settings.playbackRate);
    $("#settingsReducedMotion").checked = Boolean(state.settings.reducedMotion);
    applySettings();
  }

  function applySettings() {
    document.body.classList.toggle("reduce-motion", Boolean(state.settings.reducedMotion));
    if (audio) audio.playbackRate = Number(state.settings.playbackRate) || 1;
    if ($("#playerSpeed")) $("#playerSpeed").value = String(state.settings.playbackRate);
  }

  function bindCommandPalette() {
    const modal = $("#commandPalette"), input = $("#commandSearch"), list = $("#commandResults");
    const commands = [
      ["upload", "Upload audio track", "upload-cloud", () => openEditor()],
      ["batch", "Open Batch Editor", "layers-3", () => showView("view-batch")],
      ["analyzer", "Open Audio Analyzer", "audio-waveform", () => { showView("view-analyzer"); if (state.audioFile) setAnalysisFile(state.audioFile, state.editingTrackId); }],
      ["artwork", "Open Artwork Studio", "palette", () => showView("view-studio")],
      ["library", "Open My Library", "library", () => showView("view-library")],
      ["settings", "Open Settings", "settings", () => showView("view-settings")],
      ["export", "Save and export current track", "download", () => openComparison()],
    ];
    function render() {
      const query = input.value.trim().toLowerCase();
      const cmdRows = commands.filter(([, label]) => label.toLowerCase().includes(query)).map(([id, label, icon]) => `<button class="command-item" data-command="${id}"><i data-lucide="${icon}"></i><span>${label}</span></button>`);
      const trackRows = state.library.filter((track) => `${track.title} ${track.artist} ${track.album}`.toLowerCase().includes(query) && query).slice(0, 5).map((track) => `<button class="command-item" data-command-track="${track.id}"><i data-lucide="music-2"></i><span>${escapeHTML(track.title)} · ${escapeHTML(track.artist || "Unknown artist")}</span></button>`);
      list.innerHTML = [...cmdRows, ...trackRows].join("") || `<p class="text-muted p-4">No matching commands or tracks.</p>`;
      refreshIcons(list);
    }
    document.addEventListener("keydown", (event) => {
      const editable = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); modal.classList.remove("hidden"); input.value = ""; render(); input.focus(); return; }
      if (event.key === "Escape" && !modal.classList.contains("hidden")) { modal.classList.add("hidden"); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); openComparison(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") { event.preventDefault(); openEditor(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
      if (editable) return;
      if (event.code === "Space") { event.preventDefault(); void togglePlayback(); }
      else if (event.key.toLowerCase() === "m") { audio.muted = !audio.muted; updateMuteButton(); }
      else if (event.key === "ArrowLeft" && audio.duration) { audio.currentTime = Math.max(0, audio.currentTime - 5); }
      else if (event.key === "ArrowRight" && audio.duration) { audio.currentTime = Math.min(audio.duration, audio.currentTime + 5); }
    });
    input?.addEventListener("input", render);
    list?.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-command], [data-command-track]"); if (!button) return;
      if (button.dataset.commandTrack) {
        const record = await window.MetatuneStore.getTrack(Number(button.dataset.commandTrack));
        if (record) { closeModal("commandPalette"); showView("view-library"); setPlayer(record, { id: record.id }); void audio.play().catch(() => {}); }
      } else { commands.find(([id]) => id === button.dataset.command)?.[3](); }
      closeModal("commandPalette");
    });
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const total = Math.floor(seconds), hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), remainder = total % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function durationSeconds(value) {
    if (Number.isFinite(value)) return value;
    if (typeof value !== "string" || !value.trim()) return 0;
    const parts = value.split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return 0;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"], index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
  }

  function formatDb(value, unit) { return Number.isFinite(value) ? `${value.toFixed(1)}${unit}` : "—"; }

  async function init() {
    bindNavigation(); bindAudioUpload(); bindMetadataFields(); bindArtwork(); bindAIStudio(); bindPlayer(); bindAnalyzer(); bindLibrary(); bindBatch(); bindSettings(); bindCommandPalette();
    $("#exportFilenameTemplate")?.addEventListener("change", updateFilenamePreview);
    $("#btnSuccessLibrary")?.addEventListener("click", () => { closeModal("successModal"); showView("view-library"); });
    try { await window.MetatuneStore.database(); await loadSettings(); await refreshLibrary(); }
    catch (error) { toast(`Local storage is unavailable: ${error.message}`, "error", 9000); }
    refreshIcons();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void init());
  else void init();
})();
