document.addEventListener('DOMContentLoaded', () => {
    // UI Elements
    const uploadZone = document.getElementById('upload-zone');
    const fileInput = document.getElementById('file-input');
    const folderInput = document.getElementById('folder-input');
    const statusSection = document.getElementById('status-section');
    const progressBar = document.getElementById('progress-bar');
    const statusText = document.getElementById('status-text');
    const resultsBody = document.getElementById('results-body');
    const leadCount = document.getElementById('lead-count');
    const exportBtn = document.getElementById('export-btn');
    const clearBtn = document.getElementById('clear-btn');
    const ocrPreview = document.getElementById('ocr-preview');
    const ocrRawText = document.getElementById('ocr-raw-text');
    const dismissOcr = document.getElementById('dismiss-ocr');
    const showOcrToggle = document.getElementById('show-ocr-toggle');
    const engineBadge = document.getElementById('engine-badge');
    const engineDot = document.getElementById('engine-dot');
    const engineLabel = document.getElementById('engine-label');
    const settingsToggle = document.getElementById('settings-toggle');
    const apiSettings = document.getElementById('api-settings');
    const apiKeyInput = document.getElementById('api-key-input');
    const saveKeyBtn = document.getElementById('save-key-btn');
    const apiKeyStatus = document.getElementById('api-key-status');
    const pauseBtn = document.getElementById('pause-btn');
    const saveSessionBtn = document.getElementById('save-session-btn');
    const tabExtract = document.getElementById('tab-extract');
    const tabHistory = document.getElementById('tab-history');
    const viewExtract = document.getElementById('view-extract');
    const viewHistory = document.getElementById('view-history');
    const historyList = document.getElementById('history-list');
    const historyCountBadge = document.getElementById('history-count-badge');
    const clearHistoryBtn = document.getElementById('clear-history-btn');
    const historyDetail = document.getElementById('history-detail');
    const historyDetailTitle = document.getElementById('history-detail-title');
    const historyDetailBody = document.getElementById('history-detail-body');
    const historyBackBtn = document.getElementById('history-back-btn');
    const historyExportBtn = document.getElementById('history-export-btn');
    const historyRestoreBtn = document.getElementById('history-restore-btn');

    let extractedData = [];
    let worker = null; // Tesseract worker (lazy init)
    let isPaused = false;
    let pauseResolve = null;
    let isProcessing = false;
    let viewingSessionId = null;

    // ── API Key Management (shared with Channel Finder via localStorage) ──
    function getGeminiKeys() {
        try {
            return JSON.parse(localStorage.getItem('gemini_api_keys')) || [];
        } catch (e) { return []; }
    }

    function saveGeminiKey(key) {
        const keys = getGeminiKeys();
        if (!keys.includes(key)) {
            keys.push(key);
            localStorage.setItem('gemini_api_keys', JSON.stringify(keys));
        }
    }

    function hasGeminiKey() {
        return getGeminiKeys().length > 0;
    }

    function getCurrentKey() {
        const keys = getGeminiKeys();
        return keys.length > 0 ? keys[0] : null;
    }

    // ── Engine Badge UI ──
    function updateEngineBadge() {
        if (hasGeminiKey()) {
            engineDot.className = 'engine-dot gemini';
            engineLabel.textContent = 'GEMINI VISION AI';
            engineBadge.className = 'engine-badge gemini';
        } else {
            engineDot.className = 'engine-dot ocr';
            engineLabel.textContent = 'FREE OFFLINE OCR';
            engineBadge.className = 'engine-badge ocr';
        }
        updateKeyStatus();
    }

    function updateKeyStatus() {
        const keys = getGeminiKeys();
        if (keys.length > 0) {
            apiKeyStatus.innerHTML = `<span style="color: var(--success);">✓ ${keys.length} key(s) loaded — using Gemini Vision AI</span>`;
            apiKeyInput.value = keys.map(k => k.substring(0, 8) + '...').join(', ');
        } else {
            apiKeyStatus.innerHTML = `<span style="color: var(--text-secondary);">No key set — using free offline OCR (lower accuracy)</span>`;
            apiKeyInput.value = '';
        }
    }

    // ── Settings Panel ──
    settingsToggle.addEventListener('click', () => {
        apiSettings.style.display = apiSettings.style.display === 'none' ? 'block' : 'none';
    });

    saveKeyBtn.addEventListener('click', async () => {
        const raw = apiKeyInput.value.trim();
        if (!raw || raw.includes('...')) {
            alert('Please paste a valid Gemini API key.');
            return;
        }
        // Support pasting multiple keys separated by newlines or commas
        const keys = raw.split(/[\n,]+/).map(k => k.trim()).filter(k => k.length > 10);
        if (keys.length === 0) {
            alert('No valid keys found.');
            return;
        }
        // Replace all keys
        localStorage.setItem('gemini_api_keys', JSON.stringify(keys));
        
        // Sync to server DB
        try {
            await fetch('/hub/api_keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(keys)
            });
        } catch (e) {
            console.error('Failed to save api keys to DB:', e);
        }

        updateEngineBadge();
        apiSettings.style.display = 'none';
    });

    // Init keys from server DB
    async function initKeys() {
        try {
            const res = await fetch('/hub/api_keys');
            if (res.ok) {
                const keys = await res.json();
                if (keys && keys.length > 0) {
                    localStorage.setItem('gemini_api_keys', JSON.stringify(keys));
                }
            }
        } catch (e) {
            console.error('Failed to load api keys from DB:', e);
        }
        updateEngineBadge();
    }
    initKeys();

    // ── Gemini Vision API ──
    async function processWithGemini(file) {
        const keys = getGeminiKeys();
        if (keys.length === 0) throw new Error('No Gemini API key');

        const base64 = await fileToBase64(file);
        const prompt = `Analyze this YouTube channel screenshot. Extract the following information:
1. Channel Name (the main channel name visible)
2. Handle (the @handle, e.g. @channelname)
3. Subscriber Count (e.g. "1.2M subscribers")
4. Last Upload Time (e.g. "2 days ago", "3 weeks ago")

Return ONLY a JSON object with these exact keys: channelName, handle, subscribers, lastUpload
If a field is not visible, use "N/A".
Example: {"channelName":"Tech Reviews","handle":"@techreviews","subscribers":"1.2M subscribers","lastUpload":"2 days ago"}`;

        // Try each key with rotation
        let lastError = null;
        for (let i = 0; i < keys.length; i++) {
            try {
                const result = await callGeminiVision(keys[i], base64, file.type, prompt);
                return result;
            } catch (err) {
                lastError = err;
                console.warn(`Gemini key #${i + 1} failed: ${err.message}`);
                if (!err.message.includes('quota') && !err.message.includes('429')) throw err;
            }
        }
        throw lastError || new Error('All Gemini keys exhausted');
    }

    async function callGeminiVision(apiKey, base64Data, mimeType, prompt, model) {
        // Try multiple models in order
        const models = model ? [model] : ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-2.5-flash-lite'];
        let lastError = null;

        for (const modelName of models) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
                console.log(`[Gemini] Trying model: ${modelName}`);
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{
                            parts: [
                                { text: prompt },
                                { inline_data: { mime_type: mimeType || 'image/png', data: base64Data } }
                            ]
                        }],
                        generationConfig: { temperature: 0.1 }
                    })
                });

                const data = await response.json();
                if (data.error) {
                    const errMsg = data.error.message || `API Error ${data.error.code}`;
                    console.warn(`[Gemini] ${modelName} failed: ${errMsg}`);
                    // If quota error, try next model
                    if (data.error.code === 429 || errMsg.includes('quota') || errMsg.includes('RESOURCE_EXHAUSTED')) {
                        lastError = new Error(`quota_exhausted: ${errMsg}`);
                        continue;
                    }
                    // If model not found, try next model
                    if (errMsg.includes('not found') || errMsg.includes('not supported')) {
                        lastError = new Error(errMsg);
                        continue;
                    }
                    throw new Error(errMsg);
                }
                if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
                    throw new Error('Empty AI response');
                }

                console.log(`[Gemini] ✓ Success with model: ${modelName}`);
                const rawText = data.candidates[0].content.parts[0].text;
                const jsonMatch = rawText.match(/\{[\s\S]*?\}/);
                if (!jsonMatch) throw new Error('No JSON in response');

                const parsed = JSON.parse(jsonMatch[0]);
                return {
                    channelName: parsed.channelName || 'N/A',
                    handle: parsed.handle || 'N/A',
                    subscribers: parsed.subscribers || 'N/A',
                    lastUpload: parsed.lastUpload || 'N/A',
                    _raw: rawText
                };
            } catch (err) {
                lastError = err;
                console.warn(`[Gemini] Model ${modelName} error:`, err.message);
                continue;
            }
        }
        throw lastError || new Error('All Gemini models failed');
    }

    function fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    // ── Tesseract OCR (fallback) ──
    async function initTesseract() {
        if (!worker) {
            statusSection.style.display = 'block';
            statusText.textContent = '⏳ Loading OCR Engine... (one-time download, ~2MB)';
            progressBar.style.width = '10%';
            worker = await Tesseract.createWorker('eng', 1, {
                logger: m => {
                    if (m.status === 'recognizing text') {
                        progressBar.style.width = `${Math.round(m.progress * 100)}%`;
                    }
                }
            });
            await worker.setParameters({ tessedit_pageseg_mode: '6' });
        }
    }

    function preprocessImage(file) {
        return new Promise((resolve) => {
            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                const scale = Math.max(1, 1800 / Math.max(img.width, img.height));
                canvas.width = img.width * scale;
                canvas.height = img.height * scale;
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const data = imageData.data;
                for (let i = 0; i < data.length; i += 4) {
                    const gray = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
                    const contrast = 1.5;
                    const factor = (259 * (contrast * 100 + 255)) / (255 * (259 - contrast * 100));
                    const newVal = Math.min(255, Math.max(0, factor * (gray - 128) + 128));
                    data[i] = data[i+1] = data[i+2] = newVal;
                }
                ctx.putImageData(imageData, 0, 0);
                URL.revokeObjectURL(url);
                canvas.toBlob(resolve, 'image/png');
            };
            img.src = url;
        });
    }

    async function processWithTesseract(file) {
        await initTesseract();
        const enhancedBlob = await preprocessImage(file);
        const imageUrl = URL.createObjectURL(enhancedBlob);
        const { data: { text } } = await worker.recognize(imageUrl);
        URL.revokeObjectURL(imageUrl);

        let finalText = text;
        if (text.trim().length < 10) {
            const origUrl = URL.createObjectURL(file);
            const { data: { text: origText } } = await worker.recognize(origUrl);
            URL.revokeObjectURL(origUrl);
            if (origText.trim().length > text.trim().length) finalText = origText;
        }

        const result = parseOcrText(finalText);
        result._raw = finalText;
        return result;
    }

    function parseOcrText(rawText) {
        const lines = rawText.replace(/\r\n/g, '\n').split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let channelName = 'N/A', handle = 'N/A', subscribers = 'N/A', lastUpload = 'N/A';

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const handleMatch = line.match(/@[\w\d._-]{2,}/);
            if (handleMatch) {
                handle = handleMatch[0];
                if (i > 0) channelName = cleanName(lines[i - 1]);
                break;
            }
            const fuzzy = line.match(/[©@a]\s*([\w\d._-]{3,})\s/);
            if (fuzzy && !line.toLowerCase().includes('subscribe') && !line.toLowerCase().includes('video') && line.length < 40) {
                handle = '@' + fuzzy[1];
                if (i > 0) channelName = cleanName(lines[i - 1]);
                break;
            }
        }

        const fullText = lines.join(' ');
        const subPatterns = [
            /(\d[\d,.]*\s*[KkMmBb]?)\s*(?:subscriber|subcriber|subsciber|subscnber)s?/i,
            /(\d[\d,.]*\s*(?:lakh|crore|million|billion|mil|thousand))\s*(?:subscriber|sub)s?/i,
            /subscriber[s]?\s*[\-:]*\s*(\d[\d,.]*\s*[KkMmBb]?)/i,
            /(\d[\d,.]+)\s*(?:sub|subs)\b/i,
            /(\d+[.,]\d+[KkMmBb])\b/
        ];
        for (const p of subPatterns) { const m = fullText.match(p); if (m) { subscribers = m[0].trim(); break; } }

        const timePatterns = [
            /(\d+)\s*(second|minute|hour|day|week|month|year|min|hr|sec|mo|yr)s?\s*ago/i,
            /(\d+\s*(?:second|minute|hour|day|week|month|year)s?)\s*(?:ago|old)/i,
            /(streamed|premiered)\s*(\d+\s*\w+\s*ago)/i
        ];
        for (const p of timePatterns) { const m = fullText.match(p); if (m) { lastUpload = m[0].trim(); break; } }

        if (channelName === 'N/A') {
            for (let i = 0; i < Math.min(5, lines.length); i++) {
                const l = lines[i];
                if (l.match(/subscriber|video|view|join|subscri/i)) continue;
                if (l.match(/^\d/)) continue;
                if (l.match(/^[@©]/)) continue;
                if (l.length > 3 && l.length < 60) { channelName = cleanName(l); break; }
            }
        }
        return { channelName, handle, subscribers, lastUpload };
    }

    function cleanName(raw) {
        if (!raw) return 'N/A';
        let name = raw.replace(/[|\\/><]/g, '').replace(/^\W+/, '').replace(/\W+$/, '').trim();
        if (name.length < 2 || /^\d+$/.test(name)) return 'N/A';
        return name;
    }

    // ── Drag & Drop ──
    ['dragenter', 'dragover'].forEach(ev => {
        window.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); uploadZone.classList.add('dragover'); }, false);
    });
    ['dragleave', 'dragend'].forEach(ev => {
        window.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); if (!e.relatedTarget || e.clientX === 0) uploadZone.classList.remove('dragover'); }, false);
    });

    async function traverseFileEntry(entry) {
        const files = [];
        if (entry.isFile) {
            files.push(await new Promise(resolve => entry.file(resolve)));
        } else if (entry.isDirectory) {
            const dirReader = entry.createReader();
            let batch;
            do {
                batch = await new Promise(resolve => dirReader.readEntries(resolve));
                for (const child of batch) { files.push(...await traverseFileEntry(child)); }
            } while (batch.length > 0);
        }
        return files;
    }

    window.addEventListener('drop', async (e) => {
        e.preventDefault(); e.stopPropagation(); uploadZone.classList.remove('dragover');
        const entries = [], rawFiles = [];
        if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
            for (let i = 0; i < e.dataTransfer.items.length; i++) {
                const item = e.dataTransfer.items[i];
                if (item.kind === 'file') {
                    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
                    if (entry) entries.push(entry);
                    else { const f = item.getAsFile(); if (f) rawFiles.push(f); }
                }
            }
        } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            for (let i = 0; i < e.dataTransfer.files.length; i++) rawFiles.push(e.dataTransfer.files[i]);
        }
        const allFiles = [...rawFiles];
        for (const entry of entries) allFiles.push(...await traverseFileEntry(entry));
        if (allFiles.length > 0) handleFiles(allFiles);
    }, false);

    fileInput.addEventListener('change', (e) => { if (e.target.files.length > 0) handleFiles(e.target.files); });
    folderInput.addEventListener('change', (e) => { if (e.target.files.length > 0) handleFiles(e.target.files); });

    // Listen for files from parent hub
    window.addEventListener('message', (e) => {
        if (e.data?.type === 'DROPPED_FILES' && e.data.serializedFiles?.length > 0) {
            const files = e.data.serializedFiles.map(sf => new File([sf.buffer], sf.name, { type: sf.type, lastModified: sf.lastModified }));
            handleFiles(files);
        }
    });

    // ── Main Processing ──
    async function handleFiles(files) {
        const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
        if (imageFiles.length === 0) { alert('No image files found.'); return; }

        const useGemini = hasGeminiKey();
        const engineName = useGemini ? 'Gemini Vision' : 'Tesseract OCR';

        if (!useGemini) {
            try { await initTesseract(); } catch (err) { alert('Failed to load OCR: ' + err.message); return; }
        }

        statusSection.style.display = 'block';
        pauseBtn.style.display = 'inline-flex';
        isProcessing = true;
        isPaused = false;
        pauseBtn.textContent = '⏸️ Pause';
        pauseBtn.classList.remove('paused');
        let processed = 0, success = 0;

        for (const file of imageFiles) {
            // ── Pause gate ──
            if (isPaused) {
                await new Promise(r => { pauseResolve = r; });
            }
            try {
                statusText.textContent = `🔍 [${engineName}] Scanning ${processed + 1}/${imageFiles.length}: ${file.name}`;
                progressBar.style.width = `${(processed / imageFiles.length) * 100}%`;

                let result;
                if (useGemini) {
                    result = await processWithGemini(file);
                } else {
                    result = await processWithTesseract(file);
                }

                if (showOcrToggle.checked && result._raw) {
                    ocrPreview.style.display = 'block';
                    ocrRawText.textContent = `── ${file.name} (${engineName}) ──\n${result._raw}`;
                }

                result.sourceFile = file.name;
                addResultToTable(result);
                if (result.channelName !== 'N/A' || result.handle !== 'N/A') success++;

            } catch (err) {
                console.error(`Error processing ${file.name}:`, err);
                // If Gemini fails, try Tesseract as fallback
                if (useGemini) {
                    try {
                        // Show the ACTUAL error reason so user can diagnose
                        let reason = err.message || 'Unknown error';
                        if (reason.includes('quota') || reason.includes('429') || reason.includes('RESOURCE_EXHAUSTED')) {
                            reason = '❌ API QUOTA EXHAUSTED — daily free limit reached. Wait 24hrs or add billing.';
                        } else if (reason.includes('API key not valid') || reason.includes('API_KEY_INVALID')) {
                            reason = '❌ INVALID API KEY — check your key at aistudio.google.com/apikey';
                        } else if (reason.includes('not found') || reason.includes('not supported')) {
                            reason = '❌ MODEL NOT AVAILABLE — Gemini models may not be enabled for your project';
                        } else if (reason.includes('permission') || reason.includes('PERMISSION_DENIED')) {
                            reason = '❌ PERMISSION DENIED — enable Generative Language API in Google Cloud Console';
                        } else if (reason.includes('Failed to fetch') || reason.includes('NetworkError')) {
                            reason = '❌ NETWORK ERROR — check your internet connection';
                        }
                        statusText.innerHTML = `⚠️ <strong>Gemini failed:</strong> ${reason}<br>↳ Falling back to OCR for: ${file.name}`;
                        console.warn(`[Gemini Failure Reason] ${reason}`);
                        const fallback = await processWithTesseract(file);
                        fallback.sourceFile = file.name;
                        addResultToTable(fallback);
                        if (fallback.channelName !== 'N/A' || fallback.handle !== 'N/A') success++;
                        processed++;
                        progressBar.style.width = `${(processed / imageFiles.length) * 100}%`;
                        continue;
                    } catch (e2) { /* fallback also failed */ }
                }
                addResultToTable({
                    channelName: file.name, handle: '—', subscribers: '—',
                    lastUpload: `⚠️ ${err.message.substring(0, 40)}`
                });
            }
            processed++;
            progressBar.style.width = `${(processed / imageFiles.length) * 100}%`;
        }

        isProcessing = false;
        pauseBtn.style.display = 'none';
        statusText.textContent = `${success === processed ? '✅' : '⚠️'} Done! ${success}/${processed} extracted via ${engineName}.`;
        progressBar.style.width = '100%';
        progressBar.classList.remove('paused');
        fileInput.value = '';
        if (folderInput) folderInput.value = '';
        if (saveSessionBtn) saveSessionBtn.disabled = extractedData.length === 0;
        setTimeout(() => { statusSection.style.display = 'none'; }, 5000);
    }

    // ── Table ──
    function syncActiveLeads() {
        fetch('/hub/screenshot/active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(extractedData)
        }).catch(() => {});
    }

    function addResultToTable(data) {
        const handle = data.handle || 'N/A';
        const link = (handle !== 'N/A' && handle !== '—' && handle.startsWith('@')) ? `https://youtube.com/${handle}` : '';
        const channelName = data.channelName || 'N/A';
        const subs = data.subscribers || 'N/A';
        const lastUpload = data.lastUpload || 'N/A';
        const rowData = { channelName, handle, subscribers: subs, lastUpload, link };
        extractedData.push(rowData);

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td contenteditable="true" class="editable"><strong>${channelName}</strong></td>
            <td contenteditable="true" class="editable">${handle}</td>
            <td contenteditable="true" class="editable">${subs}</td>
            <td contenteditable="true" class="editable">${lastUpload}</td>
            <td>${link ? `<a href="${link}" target="_blank">${handle}</a>` : '<span style="color: var(--text-secondary)">—</span>'}</td>
        `;
        const idx = extractedData.length - 1;
        const cells = tr.querySelectorAll('.editable');
        cells[0].addEventListener('blur', () => { extractedData[idx].channelName = cells[0].textContent.trim(); syncActiveLeads(); });
        cells[1].addEventListener('blur', () => {
            const h = cells[1].textContent.trim();
            extractedData[idx].handle = h;
            const lc = tr.querySelector('td:last-child');
            if (h.startsWith('@')) { extractedData[idx].link = `https://youtube.com/${h}`; lc.innerHTML = `<a href="https://youtube.com/${h}" target="_blank">${h}</a>`; }
            syncActiveLeads();
        });
        cells[2].addEventListener('blur', () => { extractedData[idx].subscribers = cells[2].textContent.trim(); syncActiveLeads(); });
        cells[3].addEventListener('blur', () => { extractedData[idx].lastUpload = cells[3].textContent.trim(); syncActiveLeads(); });

        const emptyMsg = resultsBody.querySelector('.empty-state');
        if (emptyMsg) emptyMsg.remove();
        resultsBody.prepend(tr);
        leadCount.textContent = extractedData.length;
        exportBtn.disabled = false;
        clearBtn.disabled = false;
        if (saveSessionBtn) saveSessionBtn.disabled = false;
        
        syncActiveLeads();
    }

    // ── Controls ──
    if (dismissOcr) dismissOcr.addEventListener('click', () => { ocrPreview.style.display = 'none'; });

    clearBtn.addEventListener('click', () => {
        if (!confirm('Clear all extracted data?')) return;
        extractedData = [];
        resultsBody.innerHTML = `<tr><td colspan="5" class="empty-state">No screenshots processed yet. Upload images above to begin.</td></tr>`;
        leadCount.textContent = '0';
        exportBtn.disabled = true;
        clearBtn.disabled = true;
        ocrPreview.style.display = 'none';
        
        fetch('/hub/screenshot/active', { method: 'DELETE' }).catch(() => {});
    });

    exportBtn.addEventListener('click', () => {
        if (extractedData.length === 0) return;
        exportCSV(extractedData, `channel_leads_${new Date().toISOString().split('T')[0]}`);
    });

    resultsBody.innerHTML = `<tr><td colspan="5" class="empty-state">No screenshots processed yet. Upload images above to begin.</td></tr>`;

    // ═══════ PAUSE / RESUME ═══════
    pauseBtn.addEventListener('click', () => {
        if (!isProcessing) return;
        if (!isPaused) {
            isPaused = true;
            pauseBtn.textContent = '▶️ Resume';
            pauseBtn.classList.add('paused');
            progressBar.classList.add('paused');
            statusText.textContent = '⏸️ Paused — click Resume to continue processing.';
        } else {
            isPaused = false;
            pauseBtn.textContent = '⏸️ Pause';
            pauseBtn.classList.remove('paused');
            progressBar.classList.remove('paused');
            if (pauseResolve) { pauseResolve(); pauseResolve = null; }
        }
    });

    // ═══════ TAB SWITCHING ═══════
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const tab = btn.dataset.tab;
            viewExtract.style.display = tab === 'extract' ? 'flex' : 'none';
            viewHistory.style.display = tab === 'history' ? 'flex' : 'none';
            if (tab === 'history') renderHistoryList();
        });
    });

    // ── HISTORY SYSTEM (DB synced) ──
    const HISTORY_KEY = 'screenshot_extractor_history';
    let localHistory = [];

    async function loadHistoryFromServer() {
        try {
            const res = await fetch('/hub/screenshot/history');
            if (res.ok) {
                localHistory = await res.json();
                localStorage.setItem(HISTORY_KEY, JSON.stringify(localHistory));
            }
        } catch (e) {
            console.error('Failed to load history from server, using localStorage:', e);
            try {
                localHistory = JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
            } catch (err) {
                localHistory = [];
            }
        }
        updateHistoryBadge();
    }
    loadHistoryFromServer();

    function getHistory() {
        return localHistory;
    }

    function updateHistoryBadge() {
        const count = localHistory.length;
        historyCountBadge.textContent = count;
    }

    async function saveCurrentSession() {
        if (extractedData.length === 0) { alert('No leads to save.'); return; }
        const session = {
            id: Date.now(),
            date: new Date().toISOString(),
            leadCount: extractedData.length,
            engine: hasGeminiKey() ? 'Gemini Vision' : 'OCR',
            leads: JSON.parse(JSON.stringify(extractedData))
        };
        
        localHistory.unshift(session);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(localHistory));
        updateHistoryBadge();
        
        // Sync to server DB
        try {
            await fetch('/hub/screenshot/history', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(session)
            });
        } catch (e) {
            console.error('Failed to sync saved session to server:', e);
        }

        alert(`✅ Session saved! (${session.leadCount} leads)`);
    }

    saveSessionBtn.addEventListener('click', saveCurrentSession);

    async function renderHistoryList() {
        await loadHistoryFromServer();
        const history = getHistory();
        historyDetail.style.display = 'none';
        if (history.length === 0) {
            historyList.innerHTML = `<div class="history-empty"><div class="history-empty-icon">📋</div><p>No saved sessions yet.<br>Extract leads and click <strong>💾 Save Session</strong> to keep them here.</p></div>`;
            return;
        }
        historyList.innerHTML = history.map(s => {
            const d = new Date(s.date);
            const dateStr = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
            const timeStr = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
            return `<div class="history-card" data-id="${s.id}">
                <div class="history-card-left">
                    <div class="history-card-icon">📸</div>
                    <div class="history-card-info">
                        <h4>${dateStr} — ${timeStr}</h4>
                        <div class="history-card-meta"><span>🔧 ${s.engine || 'Unknown'}</span></div>
                    </div>
                </div>
                <div class="history-card-right">
                    <span class="history-leads-badge">${s.leadCount} leads</span>
                    <button class="history-delete-btn" data-del="${s.id}" title="Delete session">🗑️</button>
                    <span class="history-arrow">→</span>
                </div>
            </div>`;
        }).join('');

        // Click handlers
        historyList.querySelectorAll('.history-card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('.history-delete-btn')) return;
                openHistoryDetail(Number(card.dataset.id));
            });
        });
        historyList.querySelectorAll('.history-delete-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm('Delete this session?')) return;
                const sessionId = Number(btn.dataset.del);
                
                localHistory = localHistory.filter(s => s.id !== sessionId);
                localStorage.setItem(HISTORY_KEY, JSON.stringify(localHistory));
                updateHistoryBadge();

                // Sync delete to server DB
                try {
                    await fetch(`/hub/screenshot/history/${sessionId}`, { method: 'DELETE' });
                } catch (err) {
                    console.error('Failed to delete session on server:', err);
                }

                renderHistoryList();
            });
        });
    }

    function openHistoryDetail(sessionId) {
        const session = getHistory().find(s => s.id === sessionId);
        if (!session) return;
        viewingSessionId = sessionId;
        const d = new Date(session.date);
        historyDetailTitle.textContent = `📸 ${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} — ${session.leadCount} leads`;
        historyDetailBody.innerHTML = session.leads.map(row => {
            const link = (row.handle && row.handle.startsWith('@')) ? `https://youtube.com/${row.handle}` : row.link || '';
            return `<tr>
                <td><strong>${row.channelName || 'N/A'}</strong></td>
                <td>${row.handle || 'N/A'}</td>
                <td>${row.subscribers || 'N/A'}</td>
                <td>${row.lastUpload || 'N/A'}</td>
                <td>${link ? `<a href="${link}" target="_blank">${row.handle}</a>` : '<span style="color:var(--text-secondary)">—</span>'}</td>
            </tr>`;
        }).join('');
        historyDetail.style.display = 'flex';
    }

    historyBackBtn.addEventListener('click', () => {
        historyDetail.style.display = 'none';
        viewingSessionId = null;
    });

    historyExportBtn.addEventListener('click', () => {
        const session = getHistory().find(s => s.id === viewingSessionId);
        if (!session) return;
        exportCSV(session.leads, `history_leads_${new Date(session.date).toISOString().split('T')[0]}`);
    });

    historyRestoreBtn.addEventListener('click', () => {
        const session = getHistory().find(s => s.id === viewingSessionId);
        if (!session) return;
        session.leads.forEach(row => addResultToTable(row));
        document.querySelector('.tab-btn[data-tab="extract"]').click();
    });

    clearHistoryBtn.addEventListener('click', async () => {
        if (!confirm('Delete ALL saved sessions? This cannot be undone.')) return;
        
        localHistory = [];
        localStorage.setItem(HISTORY_KEY, JSON.stringify([]));
        updateHistoryBadge();

        // Sync clear to server DB
        try {
            await fetch('/hub/screenshot/history', { method: 'DELETE' });
        } catch (err) {
            console.error('Failed to clear history on server:', err);
        }

        renderHistoryList();
    });

    function exportCSV(data, filename) {
        const headers = ['Channel Name', 'Handle', 'Subscribers', 'Last Upload', 'Link'];
        const csvRows = [headers.join(',')];
        for (const row of data) {
            csvRows.push([
                `"${(row.channelName || '').replace(/"/g, '""')}"`,
                `"${(row.handle || '').replace(/"/g, '""')}"`,
                `"${(row.subscribers || '').replace(/"/g, '""')}"`,
                `"${(row.lastUpload || '').replace(/"/g, '""')}"`,
                `"${(row.link || '').replace(/"/g, '""')}"`
            ].join(','));
        }
        // Use BOM + data URI for iframe compatibility (blob URLs get UUID names in iframes)
        const BOM = '\uFEFF';
        const csvContent = BOM + csvRows.join('\r\n');
        const encodedUri = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvContent);
        const a = document.createElement('a');
        a.href = encodedUri;
        a.download = `${filename}.csv`;
        a.style.display = 'none';
        // Use top-level window if inside iframe for reliable download
        try {
            const doc = (window.top !== window.self) ? window.top.document : document;
            doc.body.appendChild(a);
            a.click();
            doc.body.removeChild(a);
        } catch (e) {
            // Cross-origin fallback: open in new window
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }
    }

    // Init history badge count
    updateHistoryBadge();

    async function initActiveLeads() {
        try {
            const res = await fetch('/hub/screenshot/active');
            if (res.ok) {
                const activeLeads = await res.json();
                if (activeLeads && activeLeads.length > 0) {
                    extractedData = [];
                    resultsBody.innerHTML = '';
                    activeLeads.forEach(row => addResultToTable(row));
                }
            }
        } catch (e) {
            console.error('Failed to load active leads from server:', e);
        }
    }
    initActiveLeads();
});
