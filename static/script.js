// ==========================================
// METATUNE PRO - SPA Logic
// ==========================================

const DEFAULT_COVER = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400" fill="%23141414"><rect width="400" height="400" fill="%230B0B0B"/><path d="M200 130C161.4 130 130 161.4 130 200s31.4 70 70 70 70-31.4 70-70-31.4-70-70-70zm0 120c-27.6 0-50-22.4-50-50s22.4-50 50-50 50 22.4 50 50-22.4 50-50 50z" fill="%23181818"/></svg>`;

const app = {
    state: {
        audioFile: null,
        audioBlobUrl: null,
        aiCoverBlob: null, // ai generated
        history: { past: [], future: [] },
        objectUrls: []
    },
    
    init() {
        this.setupRouting();
        this.setupTabs();
        this.setupDropzones();
        this.setupPlayer();
        this.setupTracking();
        this.setupUndoRedo();
        this.setupAI();
        this.setupExport();
        this.initDB().then(() => this.loadDashboard()).catch((error) => {
            console.warn('Local library is unavailable in this browser.', error);
        });
        
        // Refresh icons
        lucide.createIcons();
    },

    // --- VIEW ROUTING ---
    switchView(viewId) {
        document.querySelectorAll('.view').forEach(el => el.classList.add('hidden'));
        const target = document.getElementById(viewId);
        if(target) target.classList.remove('hidden');
        
        document.querySelectorAll('.sidebar-nav .nav-item').forEach(el => {
            el.classList.toggle('active', el.getAttribute('data-target') === viewId);
        });

        if (viewId === 'view-library') this.loadLibrary();
        if (viewId === 'view-dashboard') this.loadDashboard();
    },

    setupRouting() {
        document.querySelectorAll('.nav-item[data-target]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.switchView(e.currentTarget.getAttribute('data-target'));
            });
        });
        document.getElementById('globalUploadBtn').addEventListener('click', () => {
            this.switchView('view-editor');
            if(!this.state.audioFile) document.getElementById('audioFile').click();
        });
    },

    // --- TABS ---
    setupTabs() {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
                
                e.target.classList.add('active');
                document.getElementById(e.target.getAttribute('data-tab')).classList.remove('hidden');
            });
        });
    },

    // --- FILE DROPS & UPLOADS ---
    setupDropzones() {
        const audioInput = document.getElementById('audioFile');
        const dropZone = document.getElementById('editorDropZone');
        const form = document.getElementById('metadataForm');

        const handleAudio = (file) => {
            if (!file) return;
            const ext = file.name.split('.').pop().toLowerCase();
            if (!['mp3', 'm4a'].includes(ext)) { alert("Only MP3/M4A supported."); return; }
            
            this.state.audioFile = file;
            if(this.state.audioBlobUrl) URL.revokeObjectURL(this.state.audioBlobUrl);
            this.state.audioBlobUrl = URL.createObjectURL(file);
            
            dropZone.classList.add('hidden');
            form.classList.remove('hidden');
            
            // Populate basic info
            document.getElementById('infoFormat').textContent = ext.toUpperCase();
            document.getElementById('infoSize').textContent = (file.size / (1024*1024)).toFixed(2) + ' MB';
            
            // Load audio into player
            const audioEl = document.getElementById('realAudio');
            audioEl.src = this.state.audioBlobUrl;
            audioEl.onloadedmetadata = () => {
                document.getElementById('infoDuration').textContent = this.formatTime(audioEl.duration);
                document.getElementById('playerDuration').textContent = this.formatTime(audioEl.duration);
            };

            // Setup suggestion base
            document.getElementById('metaTitle').value = file.name.replace(/\.[^/.]+$/, "");
            this.saveHistoryState();
            this.updateCompleteness();

            // Enable Actions
            document.getElementById('btnAutoDetect').disabled = false;
            document.getElementById('btnSaveExport').disabled = false;
            document.getElementById('completenessWidget').classList.remove('hidden');

            // Player UI
            document.getElementById('playerTitle').textContent = file.name;
        };

        audioInput.addEventListener('change', (e) => handleAudio(e.target.files[0]));
        
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
            dropZone.addEventListener(evt, e => e.preventDefault());
        });
        dropZone.addEventListener('drop', e => handleAudio(e.dataTransfer.files[0]));

        // Cover Upload
        document.getElementById('coverImage').addEventListener('change', (e) => {
            const f = e.target.files[0];
            if(f) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    this.updateArtworkPreview(e.target.result);
                    this.state.aiCoverBlob = null; // reset AI
                };
                reader.readAsDataURL(f);
                this.updateCompleteness();
            }
        });

        // Remove Cover
        document.getElementById('btnRemoveArtwork').addEventListener('click', () => {
            document.getElementById('coverImage').value = '';
            this.state.aiCoverBlob = null;
            this.updateArtworkPreview(DEFAULT_COVER);
            this.updateCompleteness();
        });
    },

    updateArtworkPreview(src) {
        document.getElementById('mainArtworkPreview').src = src;
        document.getElementById('playerArt').src = src;
    },

    // --- TRACKING & COMPLETENESS ---
    setupTracking() {
        document.querySelectorAll('[data-track="true"]').forEach(el => {
            el.addEventListener('change', () => {
                this.saveHistoryState();
                this.updateCompleteness();
                this.updatePlayerMeta();
            });
            el.addEventListener('input', () => this.updatePlayerMeta());
        });

        document.getElementById('btnAutoDetect').addEventListener('click', () => this.runAutoDetect());
    },

    updateCompleteness() {
        const fields = ['metaTitle', 'metaArtist', 'metaAlbum', 'metaGenre', 'metaYear'];
        let filled = 0;
        fields.forEach(id => { if(document.getElementById(id).value.trim() !== '') filled++; });
        if (document.getElementById('mainArtworkPreview').src !== DEFAULT_COVER) filled++;
        
        const pct = Math.round((filled / 6) * 100);
        document.getElementById('compPercentage').textContent = pct + '%';
        document.getElementById('compBar').style.width = pct + '%';

        const missing = [];
        if(!document.getElementById('metaTitle').value) missing.push("Title");
        if(!document.getElementById('metaArtist').value) missing.push("Artist");
        if(!document.getElementById('metaAlbum').value) missing.push("Album");
        if(!document.getElementById('metaGenre').value) missing.push("Genre");
        if(!document.getElementById('metaYear').value) missing.push("Year");
        if(document.getElementById('mainArtworkPreview').src === DEFAULT_COVER) missing.push("Artwork");

        const list = document.getElementById('missingDataList');
        if (missing.length === 0) {
            list.innerHTML = '<li class="text-primary"><i data-lucide="check-circle" style="width:14px;height:14px"></i> Perfect metadata</li>';
            list.classList.remove('text-danger');
        } else {
            list.innerHTML = missing.map(m => `<li>Missing ${m}</li>`).join('');
            list.classList.add('text-danger');
        }
        lucide.createIcons();
    },

    updatePlayerMeta() {
        const title = document.getElementById('metaTitle').value || 'Unknown Title';
        const artist = document.getElementById('metaArtist').value || 'Unknown Artist';
        document.getElementById('playerTitle').textContent = title;
        document.getElementById('playerArtist').textContent = artist;
    },

    runAutoDetect() {
        if(!this.state.audioFile) return;
        const name = this.state.audioFile.name;
        
        // Simple client-side parsing
        let clean = name.replace(/\.[^/.]+$/, ""); // remove ext
        clean = clean.replace(/official|video|lyric|audio|hd|hq|1080p|tagged/gi, '');
        clean = clean.replace(/\[.*?\]|\(.*?\)/g, ''); // remove brackets
        
        let artist = '';
        let title = clean.trim();
        
        if (clean.includes('-')) {
            const parts = clean.split('-');
            artist = parts[0].trim();
            title = parts.slice(1).join('-').trim();
        }

        const diffEl = document.getElementById('suggestDiff');
        diffEl.replaceChildren();
        this.appendSuggestion(diffEl, 'Song Title', document.getElementById('metaTitle').value, title);
        if (artist) this.appendSuggestion(diffEl, 'Artist', document.getElementById('metaArtist').value || 'None', artist);
        this.openModal('suggestModal');

        document.getElementById('btnAcceptSuggest').onclick = () => {
            document.getElementById('metaTitle').value = title;
            if(artist) document.getElementById('metaArtist').value = artist;
            this.saveHistoryState();
            this.updateCompleteness();
            this.updatePlayerMeta();
            this.closeModal('suggestModal');
        };
    },

    appendSuggestion(container, label, current, suggested) {
        const row = document.createElement('div');
        row.className = 'compare-item mt-2';
        const heading = document.createElement('span');
        heading.className = 'compare-label';
        heading.textContent = label;
        const values = document.createElement('div');
        values.className = 'flex-between';
        const oldValue = document.createElement('del');
        oldValue.className = 'text-danger';
        oldValue.textContent = current || 'None';
        const arrow = document.createElement('span');
        arrow.className = 'text-muted';
        arrow.textContent = '→';
        const newValue = document.createElement('span');
        newValue.className = 'text-primary';
        newValue.textContent = suggested;
        values.append(oldValue, arrow, newValue);
        row.append(heading, values);
        container.append(row);
    },

    // --- UNDO / REDO ---
    setupUndoRedo() {
        document.getElementById('btnUndo').addEventListener('click', () => this.undo());
        document.getElementById('btnRedo').addEventListener('click', () => this.redo());

        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'z') {
                if (e.shiftKey) this.redo();
                else this.undo();
            }
        });
    },

    getCurrentState() {
        const state = {};
        document.querySelectorAll('[data-track="true"]').forEach(el => {
            state[el.id] = el.value;
        });
        return state;
    },

    saveHistoryState() {
        const current = this.getCurrentState();
        this.state.history.past.push(JSON.stringify(current));
        this.state.history.future = []; // Clear redo
        this.updateUndoRedoUI();
    },

    undo() {
        if (this.state.history.past.length <= 1) return; // Keep base state
        const current = this.getCurrentState();
        this.state.history.future.push(JSON.stringify(current));
        const previous = JSON.parse(this.state.history.past.pop());
        this.restoreState(previous);
    },

    redo() {
        if (this.state.history.future.length === 0) return;
        const current = this.getCurrentState();
        this.state.history.past.push(JSON.stringify(current));
        const next = JSON.parse(this.state.history.future.pop());
        this.restoreState(next);
    },

    restoreState(stateObj) {
        Object.keys(stateObj).forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = stateObj[id];
        });
        this.updateCompleteness();
        this.updatePlayerMeta();
        this.updateUndoRedoUI();
    },

    updateUndoRedoUI() {
        document.getElementById('btnUndo').disabled = this.state.history.past.length <= 1;
        document.getElementById('btnRedo').disabled = this.state.history.future.length === 0;
    },

    // --- AUDIO PLAYER ---
    setupPlayer() {
        const audio = document.getElementById('realAudio');
        const playBtn = document.getElementById('playerPlayBtn');
        const seek = document.getElementById('playerSeek');
        const vol = document.getElementById('playerVolume');

        playBtn.addEventListener('click', () => {
            if(!audio.src) return;
            if(audio.paused) audio.play();
            else audio.pause();
        });

        audio.addEventListener('play', () => {
            playBtn.innerHTML = '<i data-lucide="pause"></i>';
            lucide.createIcons();
        });
        audio.addEventListener('pause', () => {
            playBtn.innerHTML = '<i data-lucide="play"></i>';
            lucide.createIcons();
        });

        audio.addEventListener('timeupdate', () => {
            if(!audio.duration) return;
            seek.value = (audio.currentTime / audio.duration) * 100;
            document.getElementById('playerTime').textContent = this.formatTime(audio.currentTime);
        });

        seek.addEventListener('input', () => {
            if(audio.duration) audio.currentTime = (seek.value / 100) * audio.duration;
        });

        vol.addEventListener('input', () => { audio.volume = vol.value / 100; });
    },

    formatTime(sec) {
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    },

    // --- AI STUDIO ---
    setupAI() {
        document.getElementById('generateAiBtn').addEventListener('click', async () => {
            const prompt = document.getElementById('aiPrompt').value.trim();
            const style = document.getElementById('aiStyle').value;
            const mood = document.getElementById('aiMood').value;
            
            let finalPrompt = "High quality album cover artwork. ";
            if(prompt) finalPrompt += prompt + ". ";
            if(style) finalPrompt += "Style: " + style + ". ";
            if(mood) finalPrompt += "Mood: " + mood + ". ";
            finalPrompt += "No text, no typography.";

            const loading = document.getElementById('aiLoading');
            const gallery = document.getElementById('aiGallery');
            const applyBtn = document.getElementById('btnApplyArtwork');

            loading.classList.remove('hidden');
            gallery.classList.add('hidden');
            applyBtn.classList.add('hidden');

            try {
                const res = await fetch('/api/generate-cover', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ prompt: finalPrompt })
                });
                if (!res.ok) throw new Error("API Error");
                const data = await res.json();
                
                gallery.innerHTML = '';
                data.images.forEach(url => {
                    const card = document.createElement('div');
                    card.className = 'ai-image-card';
                    const image = document.createElement('img');
                    image.src = url;
                    image.crossOrigin = 'anonymous';
                    image.alt = 'Generated artwork variation';
                    card.append(image);
                    card.onclick = () => {
                        gallery.querySelectorAll('.ai-image-card').forEach(c => c.classList.remove('selected'));
                        card.classList.add('selected');
                        applyBtn.classList.remove('hidden');
                        applyBtn.onclick = () => this.applyAIImage(url);
                    };
                    gallery.appendChild(card);
                });
                gallery.classList.remove('hidden');
            } catch (e) {
                alert("Failed to generate AI artwork.");
            } finally {
                loading.classList.add('hidden');
            }
        });
    },

    async applyAIImage(url) {
        try {
            const res = await fetch(`/api/proxy-image?url=${encodeURIComponent(url)}`);
            if(res.ok) {
                this.state.aiCoverBlob = await res.blob();
                document.getElementById('coverImage').value = '';
                this.updateArtworkPreview(url);
                this.updateCompleteness();
                this.switchView('view-editor');
                // Switch back to artwork tab
                document.querySelector('.tab-btn[data-tab="tab-artwork"]').click();
            }
        } catch (e) {
            console.error("Proxy error", e);
            alert("Failed to fetch image.");
        }
    },

    // --- MODALS & EXPORT FLOW ---
    openModal(id) { document.getElementById(id).classList.remove('hidden'); },
    closeModal(id) { document.getElementById(id).classList.add('hidden'); },

    setupExport() {
        document.getElementById('btnSaveExport').addEventListener('click', () => {
            // Populate Before/After
            const fields = ['Title', 'Artist', 'Album', 'Genre', 'Year'];
            const ids = ['metaTitle', 'metaArtist', 'metaAlbum', 'metaGenre', 'metaYear'];
            
            const before = document.getElementById('compareBefore');
            const after = document.getElementById('compareAfter');
            before.replaceChildren();
            after.replaceChildren();
            ids.forEach((id, i) => {
                const val = document.getElementById(id).value || '--';
                let old = '--';
                if(id === 'metaTitle') old = this.state.audioFile.name;
                before.append(this.createCompareItem(fields[i], old));
                after.append(this.createCompareItem(fields[i], val, 'text-primary'));
            });
            this.openModal('compareModal');
        });

        document.getElementById('btnConfirmExport').addEventListener('click', () => {
            this.closeModal('compareModal');
            this.submitForm();
        });
    },

    createCompareItem(label, value, valueClass = '') {
        const row = document.createElement('div');
        row.className = 'compare-item';
        const name = document.createElement('span');
        name.className = 'compare-label';
        name.textContent = label;
        const text = document.createElement('span');
        text.className = valueClass;
        text.textContent = value;
        row.append(name, text);
        return row;
    },

    submitForm() {
        const form = document.getElementById('metadataForm');
        const fd = new FormData();

        // Essential fields for backend
        fd.set("audio_file", this.state.audioFile);
        fd.set("title", document.getElementById('metaTitle').value);
        fd.set("artist", document.getElementById('metaArtist').value);
        fd.set("album", document.getElementById('metaAlbum').value);
        fd.set("genre", document.getElementById('metaGenre').value);
        fd.set("year", document.getElementById('metaYear').value);

        if (this.state.aiCoverBlob) {
            fd.set("cover_image", this.state.aiCoverBlob, "ai_cover.jpg");
        } else {
            const inputCover = document.getElementById('coverImage').files[0];
            if (inputCover) fd.set("cover_image", inputCover);
            else {
                alert("Please add artwork before saving.");
                return;
            }
        }

        this.openModal('progressModal');
        this.updateIcon(document.getElementById('step1'), 'loader-2', true);

        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/generate");
        // The server now returns a small JSON handle; the file is downloaded
        // separately from /download/{job_id} so it works on every browser.
        xhr.responseType = "json";
        xhr.timeout = 180000;

        xhr.upload.addEventListener("progress", (e) => {
            if (e.lengthComputable) {
                const pct = Math.min(55, Math.round((e.loaded / e.total) * 55));
                document.getElementById('progressBar').style.width = pct + '%';
                if (pct >= 55 && !document.getElementById('step1').classList.contains('completed')) {
                    this.completeStep('step1');
                    this.updateIcon(document.getElementById('step2'), 'loader-2', true);
                }
            }
        });

        xhr.onerror = () => {
            this.closeModal('progressModal');
            alert("Network error. Please check your connection and try again.");
        };
        xhr.ontimeout = () => {
            this.closeModal('progressModal');
            alert("Processing took too long. Please try again with a smaller audio file.");
        };
        xhr.onabort = () => this.closeModal('progressModal');

        xhr.onload = async () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                const data = xhr.response || {};
                const filename = data.filename || "tagged_audio.mp3";
                const downloadUrl = data.download_url || (data.job_id ? "/download/" + data.job_id : null);
                if (!downloadUrl) {
                    this.closeModal('progressModal');
                    alert("The server finished processing but returned no download link. Please try again.");
                    return;
                }

                // Server finished tagging + embedding artwork.
                this.completeStep('step1');
                this.completeStep('step2');
                this.updateIcon(document.getElementById('step3'), 'loader-2', true);
                document.getElementById('progressBar').style.width = '70%';

                // Best effort: keep an offline copy of the finished file in the
                // library. The download itself never depends on this succeeding.
                let blob = null;
                try {
                    const dlRes = await fetch(downloadUrl);
                    if (dlRes.ok) blob = await dlRes.blob();
                } catch (err) {
                    console.warn("Library copy failed", err);
                }

                this.completeStep('step3');
                this.updateIcon(document.getElementById('step4'), 'loader-2', true);
                document.getElementById('progressBar').style.width = '100%';

                await this.saveToLibrary({
                    title: fd.get('title'),
                    artist: fd.get('artist'),
                    album: fd.get('album'),
                    duration: document.getElementById('infoDuration').textContent,
                    blob: blob,
                    filename: filename,
                    downloadUrl: downloadUrl,
                    artSrc: document.getElementById('mainArtworkPreview').src,
                    date: new Date().toISOString()
                });
                this.completeStep('step4');

                setTimeout(() => {
                    this.closeModal('progressModal');
                    this.showSuccess(downloadUrl, blob, filename);
                }, 150);
            } else {
                this.closeModal('progressModal');
                let msg = "Failed to process the track. Please try again.";
                try {
                    if (xhr.response && xhr.response.detail) msg = xhr.response.detail;
                } catch (err) { /* keep default message */ }
                alert(msg);
            }
        };
        xhr.send(fd);
    },

    updateIcon(el, iconName, spin) {
        if(!el) return;
        const icon = el.querySelector('i, svg');
        if (icon) icon.remove();
        const i = document.createElement('i');
        i.setAttribute('data-lucide', iconName);
        if (spin) i.classList.add('spin');
        el.insertBefore(i, el.firstChild);
    },

    completeStep(stepId) {
        const el = document.getElementById(stepId);
        if (!el) return;
        el.classList.remove('active');
        el.classList.add('completed');
        this.updateIcon(el, 'check-circle-2', false);
        lucide.createIcons();
    },

    showSuccess(downloadUrl, blob, filename) {
        this.openModal('successModal');
        document.getElementById('successTitle').textContent = document.getElementById('metaTitle').value;
        document.getElementById('successArtist').textContent = document.getElementById('metaArtist').value;
        document.getElementById('successCoverPreview').src = document.getElementById('mainArtworkPreview').src;

        const a = document.getElementById('downloadBtn');
        // Prefer the direct server URL: it responds with Content-Disposition:
        // attachment, so the browser downloads it reliably everywhere (including
        // iOS Safari). Fall back to a blob URL only if no URL is available.
        if (downloadUrl) {
            a.href = downloadUrl;
        } else if (blob) {
            a.href = window.URL.createObjectURL(blob);
        }
        a.setAttribute('download', filename);

        // reset steps
        document.querySelectorAll('.step-item').forEach(el => {
            el.classList.remove('active', 'completed');
            this.updateIcon(el, 'circle', false);
        });
        document.getElementById('progressBar').style.width = '0%';
        lucide.createIcons();
    },

    // --- INDEXED DB (LIBRARY) ---
    initDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open("MetatuneDB", 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if(!db.objectStoreNames.contains('library')) {
                    db.createObjectStore('library', { keyPath: 'id', autoIncrement: true });
                }
            };
            req.onsuccess = (e) => { this.db = e.target.result; resolve(); };
            req.onerror = () => reject();
        });
    },

    saveToLibrary(item) {
        return new Promise((resolve) => {
            if(!this.db) return resolve();
            try {
                const tx = this.db.transaction('library', 'readwrite');
                tx.objectStore('library').add(item);
                tx.oncomplete = () => resolve(true);
                tx.onerror = tx.onabort = () => resolve(false);
            } catch (error) {
                console.warn('Could not save the track to the local library.', error);
                resolve(false);
            }
        });
    },

    async getLibrary() {
        return new Promise((resolve) => {
            if(!this.db) return resolve([]);
            const tx = this.db.transaction('library', 'readonly');
            const store = tx.objectStore('library');
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result.reverse()); // newest first
            req.onerror = () => resolve([]);
        });
    },

    async loadLibrary() {
        const items = await this.getLibrary();
        const grid = document.getElementById('libraryGrid');
        this.revokeLibraryObjectUrls();
        
        if (items.length === 0) {
            grid.innerHTML = '<div class="empty-state w-full text-center" style="grid-column: 1/-1"><i data-lucide="music-4" class="lg-icon"></i><h3 class="mt-4">Library Empty</h3></div>';
            lucide.createIcons();
            return;
        }

        grid.replaceChildren(...items.map(item => this.createLibraryCard(item)));
        lucide.createIcons();
    },

    revokeLibraryObjectUrls() {
        this.state.objectUrls.forEach(url => URL.revokeObjectURL(url));
        this.state.objectUrls = [];
    },

    createLibraryCard(item) {
        const card = document.createElement('article');
        card.className = 'lib-card';
        const image = document.createElement('img');
        image.src = item.artSrc || DEFAULT_COVER;
        image.alt = `${item.title || 'Untitled track'} artwork`;
        image.className = 'lib-art';
        const title = document.createElement('div');
        title.className = 'lib-title';
        title.textContent = item.title || 'Untitled track';
        const artist = document.createElement('div');
        artist.className = 'lib-artist';
        artist.textContent = item.artist || 'Unknown artist';
        const details = document.createElement('div');
        details.className = 'text-muted mt-2 flex-between';
        details.style.fontSize = '0.75rem';
        const duration = document.createElement('span');
        duration.textContent = item.duration || '--:--';
        const link = this.createDownloadLink(item, 'btn-text');
        link.style.color = 'var(--primary)';
        details.append(duration, link);
        card.append(image, title, artist, details);
        return card;
    },

    createDownloadLink(item, className) {
        const link = document.createElement('a');
        link.href = this.libraryHref(item);
        link.setAttribute('download', item.filename || 'audio.mp3');
        link.className = className;
        link.title = 'Download';
        const icon = document.createElement('i');
        icon.setAttribute('data-lucide', 'download');
        link.append(icon);
        return link;
    },

    // Build a usable download href for a saved library item. Prefer the stored
    // offline blob; fall back to the server URL if the blob was not captured.
    libraryHref(item) {
        if (item.blob) {
            try {
                const url = URL.createObjectURL(item.blob);
                this.state.objectUrls.push(url);
                return url;
            } catch (e) { /* fall through */ }
        }
        return item.downloadUrl || '#';
    },

    async loadDashboard() {
        const items = await this.getLibrary();
        this.revokeLibraryObjectUrls();
        document.getElementById('statTracks').textContent = items.length;
        
        // Just mock some AI art stat logic
        const aiArtworks = items.filter(i => i.artSrc.includes('pollinations')).length;
        document.getElementById('statArtworks').textContent = aiArtworks;

        let totalSize = items.reduce((acc, val) => acc + (val.blob ? val.blob.size : 0), 0);
        document.getElementById('statStorage').textContent = (totalSize / (1024*1024)).toFixed(1) + ' MB';

        const recList = document.getElementById('dashboardRecentList');
        if (items.length === 0) return;
        recList.replaceChildren(...items.slice(0, 5).map(item => {
            const row = document.createElement('div');
            row.className = 'recent-item';
            const info = document.createElement('div');
            info.className = 'ri-info';
            const image = document.createElement('img');
            image.src = item.artSrc || DEFAULT_COVER;
            image.alt = `${item.title || 'Untitled track'} artwork`;
            const text = document.createElement('div');
            const title = document.createElement('div');
            title.className = 'font-bold';
            title.textContent = item.title || 'Untitled track';
            const artist = document.createElement('div');
            artist.className = 'text-muted';
            artist.style.fontSize = '0.8rem';
            const date = new Date(item.date);
            artist.textContent = `${item.artist || 'Unknown artist'} • ${Number.isNaN(date.valueOf()) ? '' : date.toLocaleDateString()}`;
            text.append(title, artist);
            info.append(image, text);
            row.append(info, this.createDownloadLink(item, 'btn-icon'));
            return row;
        }));
        lucide.createIcons();
    }
};

document.addEventListener('DOMContentLoaded', () => app.init());
