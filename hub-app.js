document.addEventListener('DOMContentLoaded', () => {
    const navLinks = document.querySelectorAll('.nav-link');
    const iframes = document.querySelectorAll('iframe');
    const breadcrumb = document.getElementById('breadcrumb-text');
    const statusIndicator = document.getElementById('status-indicator');

    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            const target = link.getAttribute('data-target');
            if (!target) return;

            e.preventDefault();

            // Update UI
            navLinks.forEach(l => l.classList.remove('active'));
            link.classList.add('active');

            // Update Breadcrumb
            breadcrumb.textContent = link.querySelector('span:last-child').textContent;

            // Switch Frames
            if (target === 'settings') {
                // Find the currently active frame and send a message to switch to settings
                iframes.forEach(frame => {
                    if (frame.classList.contains('active')) {
                        frame.contentWindow.postMessage({ type: 'SWITCH_VIEW', viewId: 'settings' }, '*');
                    }
                });
                return; // Don't hide the frame, just switch its view
            }

            iframes.forEach(frame => {
                frame.classList.remove('active');
                if (frame.id === `frame-${target}`) {
                    frame.classList.add('active');
                }
            });

            // Check server status if switching to Bulk Email
            if (target === 'bulk-email') {
                checkBulkEmailServer();
            }
        });
    });

    async function checkBulkEmailServer() {
        const bulkFrame = document.getElementById('frame-bulk-email');
        const originalSrc = '/mailblast';
        
        try {
            // Use no-cors to avoid CORS issues with simple heartbeat
            const response = await fetch('/api/campaigns', { mode: 'cors' });
            updateStatus(true);
            
            // Reload frame if it was previously failed (optional)
            if (bulkFrame.src === 'about:blank') {
                bulkFrame.src = originalSrc;
            }
        } catch (err) {
            console.warn('Bulk Email Server is offline.');
            updateStatus(false);
        }
    }

    function updateStatus(isOnline) {
        if (isOnline) {
            statusIndicator.innerHTML = '<div style="width: 8px; height: 8px; background: #10b981; border-radius: 50%;"></div> System Ready';
            statusIndicator.style.color = '#10b981';
        } else {
            statusIndicator.innerHTML = '<div style="width: 8px; height: 8px; background: #ef4444; border-radius: 50%;"></div> Backend Offline';
            statusIndicator.style.color = '#ef4444';
        }
    }

    // Periodically check server status
    setInterval(checkBulkEmailServer, 5000);
    checkBulkEmailServer();

    // ── Fetch logged-in user info ──
    async function loadUserInfo() {
        try {
            const res = await fetch('/hub/me');
            if (res.ok) {
                const user = await res.json();
                const usernameEl = document.getElementById('sidebar-username');
                if (usernameEl) {
                    usernameEl.textContent = user.username.charAt(0).toUpperCase() + user.username.slice(1);
                }
            }
        } catch (err) {
            console.warn('Could not load user info:', err);
        }
    }
    loadUserInfo();

    // ── Logout handler ──
    const logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            try {
                await fetch('/hub/logout', { method: 'POST' });
            } catch (e) {}
            window.location.href = '/login.html';
        });
    }

    // ── Global Drag & Drop: Capture files at the parent level and forward to the active iframe ──

    // Prevent default on dragover so the browser allows the drop
    ['dragenter', 'dragover'].forEach(eventName => {
        window.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
        }, false);
    });

    ['dragleave', 'dragend'].forEach(eventName => {
        window.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
        }, false);
    });

    // Helper: recursively read all files from a dropped directory entry
    async function traverseEntry(entry) {
        const files = [];
        if (entry.isFile) {
            const file = await new Promise(resolve => entry.file(resolve));
            if (file.type.startsWith('image/')) {
                files.push(file);
            }
        } else if (entry.isDirectory) {
            const dirReader = entry.createReader();
            let batch;
            do {
                batch = await new Promise(resolve => dirReader.readEntries(resolve));
                for (const child of batch) {
                    const childFiles = await traverseEntry(child);
                    files.push(...childFiles);
                }
            } while (batch.length > 0);
        }
        return files;
    }

    // Helper: collect all image files from a DataTransfer (handles both files and folders)
    async function collectFilesFromDrop(dataTransfer) {
        const allFiles = [];

        // Try the items API first (supports folder traversal)
        if (dataTransfer.items && dataTransfer.items.length > 0) {
            const entries = [];
            for (const item of dataTransfer.items) {
                if (item.kind === 'file') {
                    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
                    if (entry) {
                        entries.push(entry);
                    } else {
                        // Fallback: just grab the file directly
                        const file = item.getAsFile();
                        if (file && file.type.startsWith('image/')) {
                            allFiles.push(file);
                        }
                    }
                }
            }
            for (const entry of entries) {
                const found = await traverseEntry(entry);
                allFiles.push(...found);
            }
        } else if (dataTransfer.files && dataTransfer.files.length > 0) {
            // Fallback for browsers without items API
            for (const file of dataTransfer.files) {
                if (file.type.startsWith('image/')) {
                    allFiles.push(file);
                }
            }
        }

        return allFiles;
    }

    // The actual drop handler: collect files, then forward to the active iframe
    window.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        // CRITICAL: dataTransfer gets cleared by the browser after the synchronous
        // portion of this handler returns. We MUST grab all entries and raw files
        // synchronously BEFORE any await calls.
        const entries = [];
        const rawFiles = [];

        if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
            for (let i = 0; i < e.dataTransfer.items.length; i++) {
                const item = e.dataTransfer.items[i];
                if (item.kind === 'file') {
                    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
                    if (entry) {
                        entries.push(entry);
                    } else {
                        const file = item.getAsFile();
                        if (file && file.type.startsWith('image/')) {
                            rawFiles.push(file);
                        }
                    }
                }
            }
        } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            for (let i = 0; i < e.dataTransfer.files.length; i++) {
                const file = e.dataTransfer.files[i];
                if (file.type.startsWith('image/')) {
                    rawFiles.push(file);
                }
            }
        }

        console.log(`[Hub Drop] Captured ${entries.length} entries, ${rawFiles.length} raw files`);

        // Now do async work (traverse directories)
        const allFiles = [...rawFiles];
        for (const entry of entries) {
            const found = await traverseEntry(entry);
            allFiles.push(...found);
        }

        console.log(`[Hub Drop] Total image files to forward: ${allFiles.length}`);
        if (allFiles.length === 0) return;

        // Find the currently active iframe and forward the files
        // NOTE: File objects CANNOT be sent via postMessage (structured clone fails).
        // Convert each file to ArrayBuffer + metadata, then reconstruct on the iframe side.
        const activeFrame = document.querySelector('iframe.active');
        if (activeFrame && activeFrame.contentWindow) {
            const serializedFiles = [];
            for (const file of allFiles) {
                const buffer = await file.arrayBuffer();
                serializedFiles.push({
                    buffer: buffer,
                    name: file.name,
                    type: file.type,
                    lastModified: file.lastModified
                });
            }
            const transferables = serializedFiles.map(f => f.buffer);
            console.log(`[Hub Drop] Forwarding ${serializedFiles.length} files to iframe`);
            activeFrame.contentWindow.postMessage({
                type: 'DROPPED_FILES',
                serializedFiles: serializedFiles
            }, '*', transferables);
        }
    }, false);
});
