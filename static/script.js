// DOM Elements
const audioUploadCard = document.getElementById('audioUploadCard');
const audioDropZone = document.getElementById('audioDropZone');
const audioInput = document.getElementById('audioFile');
const audioPreviewCard = document.getElementById('audioPreviewCard');
const audioFileNameDisplay = document.getElementById('audioFileNameDisplay');
const audioFileSizeDisplay = document.getElementById('audioFileSizeDisplay');
const changeAudioBtn = document.getElementById('changeAudioBtn');
const metadataForm = document.getElementById('metadataForm');

// Artwork Elements
const mainArtworkPreview = document.getElementById('mainArtworkPreview');
const artworkStatusBadge = document.getElementById('artworkStatusBadge');
const coverDropZone = document.getElementById('coverDropZone');
const coverImage = document.getElementById('coverImage');

// Tabs
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

// AI Elements
const autoPromptBtn = document.getElementById('autoPromptBtn');
const aiPrompt = document.getElementById('aiPrompt');
const generateAiBtn = document.getElementById('generateAiBtn');
const aiGallery = document.getElementById('aiGallery');
const aiLoading = document.getElementById('aiLoading');

// State
let uploadedAudioFile = null;
let selectedAiCoverBlob = null;
let currentTab = 'tab-upload';
const DEFAULT_PREVIEW = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400" fill="%23141414"><rect width="400" height="400" fill="%23141414"/><path d="M200 130C161.4 130 130 161.4 130 200s31.4 70 70 70 70-31.4 70-70-31.4-70-70-70zm0 120c-27.6 0-50-22.4-50-50s22.4-50 50-50 50 22.4 50 50-22.4 50-50 50z" fill="%2327272a"/></svg>`;

// Helpers
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024, sizes = ['Bytes', 'KB', 'MB', 'GB'], i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Audio Upload Logic
function handleAudioSelection(file) {
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['mp3', 'm4a'].includes(ext)) {
        alert("Only MP3 and M4A files are supported.");
        return;
    }
    if (file.size > 50 * 1024 * 1024) {
        alert("Audio file must be under 50 MB.");
        return;
    }
    uploadedAudioFile = file;
    audioFileNameDisplay.textContent = file.name;
    audioFileSizeDisplay.textContent = formatBytes(file.size);
    
    // Auto-fill title from filename if empty
    const metaTitle = document.getElementById('metaTitle');
    if (!metaTitle.value) {
        metaTitle.value = file.name.replace(/\.[^/.]+$/, "");
    }

    // UI transitions
    audioUploadCard.classList.add('hidden');
    audioPreviewCard.classList.remove('hidden');
    metadataForm.classList.remove('hidden');
}

audioInput.addEventListener('change', (e) => handleAudioSelection(e.target.files[0]));
changeAudioBtn.addEventListener('click', () => {
    uploadedAudioFile = null;
    audioInput.value = '';
    audioPreviewCard.classList.add('hidden');
    metadataForm.classList.add('hidden');
    audioUploadCard.classList.remove('hidden');
});

// Drag & Drop
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
    audioDropZone.addEventListener(evt, e => e.preventDefault());
    coverDropZone.addEventListener(evt, e => e.preventDefault());
});
audioDropZone.addEventListener('dragover', () => audioDropZone.classList.add('is-dragging'));
audioDropZone.addEventListener('dragleave', () => audioDropZone.classList.remove('is-dragging'));
audioDropZone.addEventListener('drop', (e) => {
    audioDropZone.classList.remove('is-dragging');
    handleAudioSelection(e.dataTransfer.files[0]);
});

// Cover Image Upload Logic
coverImage.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            mainArtworkPreview.src = e.target.result;
            artworkStatusBadge.textContent = "Uploaded";
            artworkStatusBadge.style.color = "var(--primary)";
            selectedAiCoverBlob = null; // Clear AI selection
        };
        reader.readAsDataURL(file);
    }
});
coverDropZone.addEventListener('dragover', () => coverDropZone.classList.add('is-dragging'));
coverDropZone.addEventListener('dragleave', () => coverDropZone.classList.remove('is-dragging'));
coverDropZone.addEventListener('drop', (e) => {
    coverDropZone.classList.remove('is-dragging');
    const file = e.dataTransfer.files[0];
    if (file && ['image/jpeg', 'image/png'].includes(file.type)) {
        const dt = new DataTransfer();
        dt.items.add(file);
        coverImage.files = dt.files;
        coverImage.dispatchEvent(new Event('change'));
    }
});

// Tabs Logic
tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.classList.add('hidden'));
        btn.classList.add('active');
        currentTab = btn.getAttribute('data-target');
        document.getElementById(currentTab).classList.remove('hidden');
    });
});

// AI Generator Logic
autoPromptBtn.addEventListener('click', () => {
    const title = document.getElementById('metaTitle').value || 'Unknown Track';
    const artist = document.getElementById('metaArtist').value || 'Unknown Artist';
    const genre = document.getElementById('metaGenre').value || 'Music';
    const style = document.getElementById('aiStyle').value;
    const mood = document.getElementById('aiMood').value;
    const desc = document.getElementById('aiDesc').value;

    let p = `Professional square music album artwork inspired by ${genre}, representing the track ${title} by ${artist}. `;
    if (desc) p += `${desc}. `;
    if (style) p += `Visual style: ${style}. `;
    if (mood) p += `Mood: ${mood}. `;
    p += `Cinematic composition, visually striking, high detail, professional album cover design. No text, no typography, no logos, no watermark.`;
    
    aiPrompt.value = p;
});

generateAiBtn.addEventListener('click', async () => {
    const prompt = aiPrompt.value.trim();
    if (!prompt) {
        alert("Please enter or auto-fill a prompt first.");
        return;
    }
    
    aiLoading.classList.remove('hidden');
    aiGallery.classList.add('hidden');
    aiGallery.innerHTML = '';
    generateAiBtn.disabled = true;

    try {
        const res = await fetch('/api/generate-cover', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ prompt })
        });
        
        if (!res.ok) throw new Error("Failed to generate");
        const data = await res.json();
        
        data.images.forEach((url, i) => {
            const card = document.createElement('div');
            card.className = 'ai-image-card';
            card.innerHTML = `
                <img src="${url}" crossorigin="anonymous">
                <div class="select-overlay"><i data-lucide="check"></i></div>
            `;
            card.onclick = () => selectAiImage(card, url);
            aiGallery.appendChild(card);
        });
        lucide.createIcons();
        aiGallery.classList.remove('hidden');
    } catch (e) {
        alert("Failed to generate artwork. Please try again.");
    } finally {
        aiLoading.classList.add('hidden');
        generateAiBtn.disabled = false;
    }
});

async function selectAiImage(cardEl, url) {
    document.querySelectorAll('.ai-image-card').forEach(c => c.classList.remove('selected'));
    cardEl.classList.add('selected');
    
    mainArtworkPreview.src = url;
    artworkStatusBadge.innerHTML = '<i data-lucide="sparkles" style="width:12px;height:12px"></i> AI Generated';
    artworkStatusBadge.style.color = "var(--primary)";
    lucide.createIcons();
    
    try {
        const res = await fetch(`/api/proxy-image?url=${encodeURIComponent(url)}`);
        if(res.ok) {
            selectedAiCoverBlob = await res.blob();
            // Clear manual upload
            coverImage.value = '';
        }
    } catch (e) {
        console.error("Failed to proxy image blob", e);
    }
}

// Generate Metadata Logic
const progressModal = document.getElementById('progressModal');
const progressBar = document.getElementById('progressBar');
const successModal = document.getElementById('successModal');

function setStepProgress(stepId) {
    document.querySelectorAll('.step-item').forEach(el => {
        if(el.id === stepId) {
            el.classList.add('active');
            el.querySelector('i').setAttribute('data-lucide', 'loader-2');
            el.querySelector('i').classList.add('spin');
        } else {
            el.classList.remove('active');
        }
    });
    lucide.createIcons();
}

function completeStep(stepId) {
    const el = document.getElementById(stepId);
    el.classList.remove('active');
    el.classList.add('completed');
    el.querySelector('i').setAttribute('data-lucide', 'check-circle-2');
    el.querySelector('i').classList.remove('spin');
    lucide.createIcons();
}

metadataForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!uploadedAudioFile) return;

    const fd = new FormData(metadataForm);
    fd.set("audio_file", uploadedAudioFile);
    
    if (selectedAiCoverBlob) {
        fd.set("cover_image", selectedAiCoverBlob, "ai_cover.jpg");
    } else if (!coverImage.files[0]) {
        alert("Please upload an artwork or generate one with AI.");
        return;
    }

    progressModal.classList.remove('hidden');
    progressBar.style.width = '5%';
    setStepProgress('step1');

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/generate");
    xhr.responseType = "blob";

    xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
            const pct = Math.min(40, Math.round((e.loaded / e.total) * 40));
            progressBar.style.width = pct + '%';
            if (pct === 40) {
                completeStep('step1');
                setStepProgress('step2');
                setTimeout(() => {
                    progressBar.style.width = '60%';
                    completeStep('step2');
                    setStepProgress('step3');
                }, 500);
            }
        }
    });

    xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
            progressBar.style.width = '100%';
            completeStep('step3');
            completeStep('step4');
            completeStep('step5');
            
            setTimeout(() => {
                progressModal.classList.add('hidden');
                showSuccess(xhr.response, xhr.getResponseHeader("Content-Disposition"));
            }, 600);
        } else {
            progressModal.classList.add('hidden');
            alert("Failed to generate metadata.");
        }
    };
    xhr.onerror = () => {
        progressModal.classList.add('hidden');
        alert("Network error.");
    };

    xhr.send(fd);
});

let downloadBlobUrl = null;

function showSuccess(blob, disposition) {
    successModal.classList.remove('hidden');
    document.getElementById('successTitle').textContent = document.getElementById('metaTitle').value;
    document.getElementById('successArtist').textContent = document.getElementById('metaArtist').value;
    document.getElementById('successCoverPreview').src = mainArtworkPreview.src;
    
    downloadBlobUrl = window.URL.createObjectURL(blob);
    const match = disposition ? disposition.match(/filename="?([^"]+)"?/) : null;
    const filename = match ? match[1] : "tagged_audio.mp3";
    
    const downloadBtn = document.getElementById('downloadBtn');
    downloadBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = downloadBlobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
    };
}

document.getElementById('processAnotherBtn').addEventListener('click', () => {
    successModal.classList.add('hidden');
    if(downloadBlobUrl) window.URL.revokeObjectURL(downloadBlobUrl);
    metadataForm.reset();
    uploadedAudioFile = null;
    selectedAiCoverBlob = null;
    mainArtworkPreview.src = DEFAULT_PREVIEW;
    artworkStatusBadge.textContent = "No Artwork";
    artworkStatusBadge.style.color = "var(--text-muted)";
    audioPreviewCard.classList.add('hidden');
    metadataForm.classList.add('hidden');
    audioUploadCard.classList.remove('hidden');
    
    document.querySelectorAll('.step-item').forEach(el => {
        el.classList.remove('active', 'completed');
        el.querySelector('i').setAttribute('data-lucide', 'circle');
        el.querySelector('i').classList.remove('spin');
    });
    progressBar.style.width = '0%';
    lucide.createIcons();
});
