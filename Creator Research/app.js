document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const uploadZone = document.getElementById('upload-zone');
    const fileInput = document.getElementById('file-input');
    const geminiKeyInput = document.getElementById('gemini-key-input');
    const btnSaveKey = document.getElementById('btn-save-key');
    const keyStatus = document.getElementById('key-status');
    
    const statTotal = document.getElementById('stat-total');
    const statProcessed = document.getElementById('stat-processed');
    const statRemaining = document.getElementById('stat-remaining');
    const statTime = document.getElementById('stat-time');
    const progressBar = document.getElementById('progress-bar');
    
    const btnStart = document.getElementById('btn-start');
    const btnPause = document.getElementById('btn-pause');
    const btnClear = document.getElementById('btn-clear');
    const btnDownload = document.getElementById('btn-download');
    
    const tableBody = document.getElementById('table-body');
    const emptyState = document.getElementById('empty-state');
    
    // Application State
    let csvHeaders = [];
    let csvRows = []; // array of parsed row objects
    let queue = []; // indices of rows to process
    let isProcessing = false;
    let isPaused = false;
    let currentIndex = 0;
    
    let startTime = null;
    let timerInterval = null;
    
    // ── API Key Management ──
    // Load key: Creator Research's own saved key ALWAYS wins over the database key
    setTimeout(() => {
        const crKey = localStorage.getItem('creator_research_gemini_key') || '';
        const dbKey = (window.aiApi && window.aiApi.apiKey) ? window.aiApi.apiKey : '';
        const existingKey = crKey || dbKey;
        if (existingKey) {
            geminiKeyInput.value = existingKey;
            keyStatus.innerHTML = crKey ? '✅ Saved key loaded' : '⚠️ Using shared key (may be suspended)';
            keyStatus.style.color = crKey ? '#34d399' : '#fbbf24';
        } else {
            keyStatus.innerHTML = '⚠️ No key set — paste one below';
            keyStatus.style.color = '#fbbf24';
        }
    }, 500);
    
    // Save key button
    btnSaveKey.addEventListener('click', () => {
        const key = geminiKeyInput.value.trim();
        if (!key) {
            keyStatus.innerHTML = '❌ Enter a key first';
            keyStatus.style.color = '#ef4444';
            return;
        }
        // Save to localStorage
        localStorage.setItem('creator_research_gemini_key', key);
        // Also update window.aiApi so processQueue picks it up
        if (window.aiApi) {
            window.aiApi.setApiKey(key);
        }
        keyStatus.innerHTML = '✅ Key saved!';
        keyStatus.style.color = '#34d399';
        setTimeout(() => { keyStatus.innerHTML = '✅ Ready'; }, 2000);
    });

    // Test key button
    const btnTestKey = document.getElementById('btn-test-key');
    if (btnTestKey) {
        btnTestKey.addEventListener('click', async () => {
            const key = geminiKeyInput.value.trim();
            if (!key) {
                keyStatus.innerHTML = '❌ Enter a key first';
                keyStatus.style.color = '#ef4444';
                return;
            }
            keyStatus.innerHTML = '🧪 Testing key...';
            keyStatus.style.color = '#a78bfa';
            
            try {
                const res = await fetch('/api/test-gemini-key', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key })
                });
                const data = await res.json();
                if (data.success) {
                    keyStatus.innerHTML = `✅ Key Working! (Model: ${data.model})`;
                    keyStatus.style.color = '#34d399';
                } else {
                    keyStatus.innerHTML = `❌ Failed: ${data.error}`;
                    keyStatus.style.color = '#ef4444';
                }
            } catch (err) {
                keyStatus.innerHTML = `❌ Request Error: ${err.message}`;
                keyStatus.style.color = '#ef4444';
            }
        });
    }

    // ── Session Auto-Save & Recovery ──
    const restoreBanner = document.getElementById('restore-session-banner');
    const restoreText = document.getElementById('restore-session-text');
    const btnRestore = document.getElementById('btn-restore-session');
    const btnDiscard = document.getElementById('btn-discard-session');

    function saveSession() {
        if (csvRows.length === 0) {
            localStorage.removeItem('creator_research_active_session');
            fetch('/hub/creator-research/active', { method: 'DELETE' }).catch(() => {});
            return;
        }
        const sessionPayload = {
            csvHeaders,
            csvRows,
            currentIndex,
            queue,
            timestamp: new Date().toLocaleString()
        };
        localStorage.setItem('creator_research_active_session', JSON.stringify(sessionPayload));
        fetch('/hub/creator-research/active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sessionPayload)
        }).catch(() => {});
    }

    async function checkSavedSession() {
        // Try server DB first, fall back to localStorage
        let session = null;
        try {
            const res = await fetch('/hub/creator-research/active');
            if (res.ok) {
                const data = await res.json();
                if (data && data.csvRows && data.csvRows.length > 0) session = data;
            }
        } catch(e) {}
        if (!session) {
            const saved = localStorage.getItem('creator_research_active_session');
            if (saved) {
                try { session = JSON.parse(saved); } catch(e) { localStorage.removeItem('creator_research_active_session'); }
            }
        }
        if (session && session.csvRows && session.csvRows.length > 0) {
            restoreText.textContent = `Found a saved session from ${session.timestamp} with ${session.csvRows.length} channels (Processed: ${session.currentIndex}/${session.queue.length}).`;
            restoreBanner.style.display = 'flex';
        }
    }

    if (btnRestore) {
        btnRestore.addEventListener('click', async () => {
            let session = null;
            try {
                const res = await fetch('/hub/creator-research/active');
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.csvRows && data.csvRows.length > 0) session = data;
                }
            } catch(e) {}
            if (!session) {
                const saved = localStorage.getItem('creator_research_active_session');
                if (saved) try { session = JSON.parse(saved); } catch(e) {}
            }
            if (session) {
                try {
                    csvHeaders = session.csvHeaders || [];
                    csvRows = session.csvRows || [];
                    currentIndex = session.currentIndex || 0;
                    queue = session.queue || [];
                    
                    // Render UI
                    renderTable();
                    
                    // Restore stats
                    statTotal.textContent = csvRows.length;
                    statProcessed.textContent = currentIndex;
                    statRemaining.textContent = queue.length - currentIndex;
                    
                    const percentage = queue.length > 0 ? Math.round((currentIndex / queue.length) * 100) : 0;
                    progressBar.style.width = `${percentage}%`;
                    document.getElementById('progress-percentage').textContent = `${percentage}%`;
                    
                    // Toggle action button states
                    if (currentIndex < queue.length) {
                        btnStart.removeAttribute('disabled');
                        btnPause.setAttribute('disabled', 'true');
                    } else {
                        btnStart.setAttribute('disabled', 'true');
                        btnPause.setAttribute('disabled', 'true');
                    }
                    btnClear.removeAttribute('disabled');
                    if (currentIndex > 0) {
                        btnDownload.removeAttribute('disabled');
                    }
                    
                    restoreBanner.style.display = 'none';
                    alert(`✅ Loaded session successfully! Click "Start Research" to continue.`);
                } catch(e) {
                    alert('Could not restore session: ' + e.message);
                }
            }
        });
    }

    if (btnDiscard) {
        btnDiscard.addEventListener('click', () => {
            if (confirm('Are you sure you want to discard your saved session? This cannot be undone.')) {
                localStorage.removeItem('creator_research_active_session');
                fetch('/hub/creator-research/active', { method: 'DELETE' }).catch(() => {});
                restoreBanner.style.display = 'none';
            }
        });
    }

    // Trigger saved session check on bootup
    setTimeout(checkSavedSession, 600);

    // Drag & Drop
    ['dragenter', 'dragover'].forEach(eventName => {
        uploadZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            uploadZone.classList.add('dragover');
        }, false);
    });

    ['dragleave', 'dragend', 'drop'].forEach(eventName => {
        uploadZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            uploadZone.classList.remove('dragover');
        }, false);
    });

    uploadZone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const file = dt.files[0];
        if (file && file.name.endsWith('.csv')) {
            handleFile(file);
        } else {
            alert('Please drop a valid .csv file.');
        }
    });

    uploadZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
        if (e.target.files[0]) {
            handleFile(e.target.files[0]);
        }
    });

    // Parse and handle the uploaded CSV
    function handleFile(file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            const text = e.target.result;
            parseCSV(text);
        };
        reader.readAsText(file);
    }

    function parseCSV(text) {
        // Robust custom CSV parser to support double-quotes and escaped commas
        const lines = [];
        let row = [""];
        let inQuotes = false;
        
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            const nextChar = text[i+1];
            
            if (char === '"') {
                if (inQuotes && nextChar === '"') {
                    row[row.length - 1] += '"';
                    i++; // skip next char
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === ',' && !inQuotes) {
                row.push('');
            } else if ((char === '\r' || char === '\n') && !inQuotes) {
                if (char === '\r' && nextChar === '\n') {
                    i++;
                }
                lines.push(row);
                row = [''];
            } else {
                row[row.length - 1] += char;
            }
        }
        
        if (row.length > 1 || row[0] !== '') {
            lines.push(row);
        }
        
        if (lines.length < 2) {
            alert('Invalid CSV: The file must contain a header row and at least one data row.');
            return;
        }

        // Clean headers
        csvHeaders = lines[0].map(h => h.trim());
        const dataRows = lines.slice(1).filter(r => r.length > 0 && r.some(cell => cell.trim() !== ''));

        // Standardize Column Mapping
        // Look for: Channel Name, Emails, Social Links, Subscribers, Link (Channel URL)
        csvRows = dataRows.map((cols, idx) => {
            const rowObj = { _index: idx, _status: 'pending', _hostName: '' };
            csvHeaders.forEach((hdr, hIdx) => {
                rowObj[hdr] = cols[hIdx] || '';
            });
            return rowObj;
        });

        // Initialize queue
        queue = csvRows.map(r => r._index);
        currentIndex = 0;
        isProcessing = false;
        isPaused = false;
        
        resetStats();
        renderTable();
        
        btnStart.removeAttribute('disabled');
        btnClear.removeAttribute('disabled');
        
        // Visual scroll to table
        document.querySelector('.table-wrapper').scrollIntoView({ behavior: 'smooth' });
    }

    function resetStats() {
        statTotal.textContent = csvRows.length;
        statProcessed.textContent = '0';
        statRemaining.textContent = csvRows.length;
        statTime.textContent = '00:00';
        progressBar.style.width = '0%';
        
        clearInterval(timerInterval);
        btnPause.setAttribute('disabled', 'true');
        btnPause.innerHTML = '⏸️ Pause';
        btnDownload.setAttribute('disabled', 'true');
    }

    // Dynamic queue render
    function renderTable() {
        if (csvRows.length === 0) {
            tableBody.innerHTML = '';
            emptyState.style.display = 'block';
            return;
        }
        
        emptyState.style.display = 'none';
        
        // Find important column header mappings
        const nameHdr = findHeader(['channel name', 'name', 'title']);
        const linkHdr = findHeader(['link', 'channel link', 'url', 'channel url']);
        const emailHdr = findHeader(['email', 'emails', 'contact']);
        
        tableBody.innerHTML = csvRows.map(row => {
            const nameVal = nameHdr ? row[nameHdr] : 'Unknown';
            const linkVal = linkHdr ? row[linkHdr] : '';
            const emailVal = emailHdr ? row[emailHdr] : '';
            
            // Build Status Badge HTML
            let badgeHTML = '';
            if (row._status === 'pending') {
                badgeHTML = '<span class="badge badge-pending">⏳ Queued</span>';
            } else if (row._status === 'processing') {
                badgeHTML = '<span class="badge badge-processing"><span class="spinner"></span> Scraping</span>';
            } else if (row._status === 'completed') {
                badgeHTML = '<span class="badge badge-success">✅ Done</span>';
            } else {
                badgeHTML = '<span class="badge badge-error">❌ Failed</span>';
            }

            // Build Host Name output HTML
            let hostHTML = '';
            if (row._status === 'pending') {
                hostHTML = '<span class="host-name-cell loading-text">Waiting...</span>';
            } else if (row._status === 'processing') {
                hostHTML = '<span class="host-name-cell loading-text">Researching AI...</span>';
            } else if (row._status === 'completed') {
                if (row._hostName) {
                    hostHTML = `<span class="host-name-cell">${escapeHtml(row._hostName)}</span>`;
                } else {
                    hostHTML = '<span class="host-name-cell not-found">Not Found</span>';
                }
            } else {
                hostHTML = '<span class="host-name-cell not-found" style="color: var(--danger);">Research Failed</span>';
            }

            return `
                <tr id="row-${row._index}">
                    <td>${row._index + 1}</td>
                    <td>
                        <div class="channel-cell">
                            <span class="channel-name">${escapeHtml(nameVal)}</span>
                            ${linkVal ? `<a href="${escapeHtml(linkVal)}" target="_blank" class="channel-link-anchor">${escapeHtml(linkVal)}</a>` : ''}
                        </div>
                    </td>
                    <td>${escapeHtml(emailVal || 'No Email')}</td>
                    <td>${badgeHTML}</td>
                    <td id="host-cell-${row._index}">${hostHTML}</td>
                </tr>
            `;
        }).join('');
    }

    function findHeader(aliases) {
        return csvHeaders.find(h => aliases.includes(h.toLowerCase().trim()));
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // Queue Loop Controllers
    btnStart.addEventListener('click', () => {
        if (isProcessing) return;
        
        isProcessing = true;
        isPaused = false;
        
        btnStart.setAttribute('disabled', 'true');
        btnPause.removeAttribute('disabled');
        btnPause.innerHTML = '⏸️ Pause';
        
        startTime = Date.now();
        startTimer();
        
        processQueue();
    });

    btnPause.addEventListener('click', () => {
        if (!isProcessing) return;
        
        if (isPaused) {
            isPaused = false;
            btnPause.innerHTML = '⏸️ Pause';
            processQueue();
        } else {
            isPaused = true;
            btnPause.innerHTML = '▶️ Resume';
            updateRowUI(queue[currentIndex], 'pending');
        }
    });

    btnClear.addEventListener('click', () => {
        csvRows = [];
        csvHeaders = [];
        queue = [];
        isProcessing = false;
        isPaused = false;
        currentIndex = 0;
        
        resetStats();
        renderTable();
        
        btnStart.setAttribute('disabled', 'true');
        btnClear.setAttribute('disabled', 'true');
    });

    btnDownload.addEventListener('click', exportCSV);

    function startTimer() {
        clearInterval(timerInterval);
        timerInterval = setInterval(() => {
            if (isPaused) return;
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
            const secs = String(elapsed % 60).padStart(2, '0');
            statTime.textContent = `${mins}:${secs}`;
        }, 1000);
    }

    // Process row by row — delegates ALL research to the backend deep intelligence engine
    async function processQueue() {
        while (currentIndex < queue.length && isProcessing && !isPaused) {
            const rowIdx = queue[currentIndex];
            const rowObj = csvRows[rowIdx];
            
            // Mark active row as processing
            rowObj._status = 'processing';
            updateRowUI(rowIdx, 'processing');
            
            try {
                // Gather all CSV columns for this row
                const linkHdr = findHeader(['link', 'channel link', 'url', 'channel url']);
                const nameHdr = findHeader(['channel name', 'name', 'title']);
                const emailHdr = findHeader(['email', 'emails', 'contact']);
                const socialsHdr = findHeader(['social links', 'socials', 'social link']);
                
                const channelLink = linkHdr ? rowObj[linkHdr] : '';
                const channelName = nameHdr ? rowObj[nameHdr] : '';
                const emails = emailHdr ? rowObj[emailHdr] : '';
                const socialLinks = socialsHdr ? rowObj[socialsHdr] : '';
                
                // Get API keys — manually pasted key takes absolute top precedence!
                const ytApiKey = (window.ytApi && window.ytApi.apiKey) ? window.ytApi.apiKey : '';
                const geminiApiKey = geminiKeyInput.value.trim() 
                    || localStorage.getItem('creator_research_gemini_key')
                    || ((window.aiApi && window.aiApi.apiKey) ? window.aiApi.apiKey : '');
                
                console.log(`[Research] Processing #${rowIdx + 1}: ${channelName} | YT Key: ${ytApiKey ? '✓' : '✗'} | Gemini Key: ${geminiApiKey ? '✓' : '✗'}`);
                
                // Call the backend Deep Research Engine with ALL signals
                const res = await fetch('/api/research-channel', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        channelUrl: channelLink,
                        channelName,
                        email: emails,
                        socialLinks,
                        ytApiKey,
                        geminiApiKey
                    })
                });
                
                if (!res.ok) {
                    const errData = await res.json().catch(() => ({}));
                    throw new Error(errData.error || `Server error ${res.status}`);
                }
                
                const result = await res.json();
                console.log(`[Research] Result for ${channelName}:`, result);
                
                rowObj._hostName = result.hostName || '';
                rowObj._logs = result.logs || [];
                
                if (result.geminiKeyFailed) {
                    rowObj._status = 'failed';
                    updateRowUI(rowIdx, 'failed');
                    saveSession();
                    
                    isPaused = true;
                    btnPause.innerHTML = '▶️ Resume';
                    btnStart.removeAttribute('disabled');
                    
                    keyStatus.innerHTML = `❌ API key issue detected. Auto-paused.`;
                    keyStatus.style.color = '#ef4444';
                    
                    alert(`⚠️ Gemini API Key Issue!\n\nGoogle returned: "${result.geminiKeyError || 'Quota exceeded or key suspended'}"\n\nResearch has been automatically paused. Paste a working key, click Save, then click Resume.`);
                    break;
                }
                
                rowObj._status = 'completed';
                
            } catch (err) {
                console.error(`[Research] Row #${rowIdx + 1} failed:`, err);
                rowObj._status = 'failed';
                rowObj._logs = [
                    `[Phase 1] Processing active queue item`,
                    `[Error] Extraction failed with critical client exception: "${err.message}"`,
                    `[Suggestion] Please check that the server is online and running locally at http://localhost:8080`
                ];
            }
            
            updateRowUI(rowIdx, rowObj._status);
            saveSession();
            
            // Advance Queue
            currentIndex++;
            
            // Update stats
            statProcessed.textContent = currentIndex;
            statRemaining.textContent = queue.length - currentIndex;
            
            const percentage = Math.round((currentIndex / queue.length) * 100);
            progressBar.style.width = `${percentage}%`;
            document.getElementById('progress-percentage').textContent = `${percentage}%`;
            
            // Small delay between rows to be respectful of APIs
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        // Loop Complete / Paused Check
        if (currentIndex >= queue.length) {
            isProcessing = false;
            clearInterval(timerInterval);
            btnStart.setAttribute('disabled', 'true');
            btnPause.setAttribute('disabled', 'true');
            btnDownload.removeAttribute('disabled');
            localStorage.removeItem('creator_research_active_session'); // Clear finished session
            alert('Creator Research completed! Download your enriched CSV now.');
        }
    }

    // Refresh single row state in the dynamic UI table
    function updateRowUI(rowIdx, status) {
        const row = csvRows[rowIdx];
        const rowEl = document.getElementById(`row-${rowIdx}`);
        const hostCell = document.getElementById(`host-cell-${rowIdx}`);
        
        if (!rowEl || !hostCell) return;
        
        // Refresh Status Cell
        const tdStatus = rowEl.querySelector('td:nth-child(4)');
        if (tdStatus) {
            if (status === 'pending') {
                tdStatus.innerHTML = '<span class="badge badge-pending">⏳ Queued</span>';
            } else if (status === 'processing') {
                tdStatus.innerHTML = '<span class="badge badge-processing"><span class="spinner"></span> Researching</span>';
            } else if (status === 'completed') {
                tdStatus.innerHTML = '<span class="badge badge-success">✅ Done</span>';
            } else {
                tdStatus.innerHTML = '<span class="badge badge-error">❌ Failed</span>';
            }
        }
        
        // Refresh Host Cell
        if (status === 'pending') {
            hostCell.innerHTML = '<span class="host-name-cell loading-text">Waiting...</span>';
        } else if (status === 'processing') {
            hostCell.innerHTML = '<span class="host-name-cell loading-text">Deep researching...</span>';
        } else if (status === 'completed') {
            let label = row._hostName ? `<span class="host-name-cell">${escapeHtml(row._hostName)}</span>` : '<span class="host-name-cell not-found">Not Found</span>';
            hostCell.innerHTML = `
                <div style="display:flex; flex-direction:column; gap:0.25rem;">
                    ${label}
                    <a href="#" onclick="showDebugLogs(${rowIdx}); return false;" style="font-size:0.75rem; color:#8b5cf6; text-decoration:none; display:flex; align-items:center; gap:0.25rem;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">
                        🔍 Inspect Debug Logs
                    </a>
                </div>
            `;
        } else {
            hostCell.innerHTML = `
                <div style="display:flex; flex-direction:column; gap:0.25rem;">
                    <span class="host-name-cell not-found" style="color: var(--danger);">Research Failed</span>
                    <a href="#" onclick="showDebugLogs(${rowIdx}); return false;" style="font-size:0.75rem; color:#f87171; text-decoration:none; display:flex; align-items:center; gap:0.25rem;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">
                        🔍 View Error Details
                    </a>
                </div>
            `;
        }
    }

    // Modal Action Bindings
    window.showDebugLogs = (rowIdx) => {
        const row = csvRows[rowIdx];
        const modal = document.getElementById('debug-modal');
        const title = document.getElementById('debug-title');
        const content = document.getElementById('debug-content');
        
        const channelName = row['channel name'] || row['name'] || row['title'] || 'Unknown Channel';
        title.textContent = `Research Logs: ${channelName}`;
        
        if (!row._logs || row._logs.length === 0) {
            content.innerHTML = '<div style="color: #ef4444; padding: 1rem;">No logs available for this row.</div>';
        } else {
            content.innerHTML = row._logs.map(log => {
                let color = '#a1a1aa'; // default gray
                if (log.includes('✓')) color = '#34d399'; // green success
                if (log.includes('warning') || log.includes('Warning')) color = '#fbbf24'; // amber warning
                if (log.includes('Error') || log.includes('Exception') || log.includes('failed') || log.includes('suspended')) color = '#f87171'; // red error
                if (log.includes('[Complete]')) color = '#a78bfa'; // purple final
                
                return `<div style="color: ${color}; border-left: 2px solid ${color}; padding-left: 0.75rem; margin-bottom: 0.5rem; line-height: 1.4; white-space: pre-wrap; word-break: break-all;">${escapeHtml(log)}</div>`;
            }).join('');
        }
        
        modal.style.display = 'flex';
        setTimeout(() => { modal.style.opacity = '1'; }, 50);
    };

    // Close Modal listeners
    const modal = document.getElementById('debug-modal');
    const btnClose1 = document.getElementById('btn-close-debug');
    const btnClose2 = document.getElementById('btn-close-debug-ok');
    
    const closeModal = () => {
        modal.style.opacity = '0';
        setTimeout(() => { modal.style.display = 'none'; }, 250);
    };
    
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
    }
    if (btnClose1) btnClose1.addEventListener('click', closeModal);
    if (btnClose2) btnClose2.addEventListener('click', closeModal);

    // Export enriched data back into CSV format
    function exportCSV() {
        if (csvRows.length === 0) return;
        
        const headers = [...csvHeaders];
        if (!headers.includes('Host Name')) {
            headers.push('Host Name');
        }
        
        const csvLines = [headers.map(h => escapeCSVField(h)).join(',')];
        
        csvRows.forEach(row => {
            const lineParts = csvHeaders.map(hdr => escapeCSVField(row[hdr] || ''));
            lineParts.push(escapeCSVField(row._hostName || ''));
            csvLines.push(lineParts.join(','));
        });
        
        const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.setAttribute('download', 'enriched_creators_list.csv');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    function escapeCSVField(val) {
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    }
});
