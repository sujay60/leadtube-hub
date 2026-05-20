document.addEventListener('DOMContentLoaded', () => {
    // --- State ---
    let queue = [];
    let currentIndex = 0;
    let isRunning = false;
    let isExtensionConnected = false;
    let sessionScrapes = 0;
    let limitSettings = {
        accountLimit: 5,
        humanDelay: 3,
        concurrency: 1
    };
    let globalCache = {};
    let activeWorkers = 0;

    // --- DOM Elements ---
    const uploadZone = document.getElementById('upload-zone');
    const fileInput = document.getElementById('csv-file-input');
    const queueContainer = document.getElementById('queue-container');
    const queueBody = document.getElementById('queue-body');
    const queueCount = document.getElementById('queue-count');
    const progressBar = document.getElementById('extraction-progress');
    const btnStart = document.getElementById('btn-start-bot');
    const btnPause = document.getElementById('btn-pause-bot');
    const btnSkipCurrent = document.getElementById('btn-skip-current');
    const btnExport = document.getElementById('btn-export-csv');
    const btnResumeFlow = document.getElementById('btn-resume-flow');
    const accountAlert = document.getElementById('account-limit-alert');
    const extensionStatus = document.getElementById('extension-status');
    const statusDot = extensionStatus.querySelector('.status-dot');
    const statusText = extensionStatus.querySelector('span');

    const statTotal = document.getElementById('stat-total');
    const statEmails = document.getElementById('stat-emails');
    const statSocials = document.getElementById('stat-socials');
    const statSession = document.getElementById('stat-session');

    // Navigation
    const navItems = document.querySelectorAll('.nav-item');
    const views = {
        dashboard: document.getElementById('view-dashboard'),
        settings: document.getElementById('view-settings')
    };

    // --- Initialization ---
    function init() {
        // Load Settings
        const savedSettings = localStorage.getItem('extractor_settings');
        if (savedSettings) {
            limitSettings = JSON.parse(savedSettings);
            if (!limitSettings.concurrency) limitSettings.concurrency = 1;
            document.getElementById('setting-account-limit').value = limitSettings.accountLimit;
            document.getElementById('setting-human-delay').value = limitSettings.humanDelay;
            if (document.getElementById('setting-concurrency')) {
                document.getElementById('setting-concurrency').value = limitSettings.concurrency;
            }
        }
        
        try {
            globalCache = JSON.parse(localStorage.getItem('extractor_cache')) || {};
        } catch(e) { globalCache = {}; }
        
        updateSessionStat();
        
        // Wait for Extension Ping
        setTimeout(() => {
            if (!isExtensionConnected) {
                console.warn('Extension not detected yet. Make sure it is installed and enabled.');
            }
        }, 3000);
    }

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            navItems.forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            const viewId = item.id.replace('nav-', '');
            Object.values(views).forEach(v => v.style.display = 'none');
            if(views[viewId]) views[viewId].style.display = 'block';
        });
    });

    document.getElementById('btn-save-settings').addEventListener('click', () => {
        limitSettings.accountLimit = parseInt(document.getElementById('setting-account-limit').value) || 5;
        limitSettings.humanDelay = parseInt(document.getElementById('setting-human-delay').value) || 3;
        const concInput = document.getElementById('setting-concurrency');
        if (concInput) limitSettings.concurrency = parseInt(concInput.value) || 1;
        
        localStorage.setItem('extractor_settings', JSON.stringify(limitSettings));
        updateSessionStat();
        alert('Settings Saved!');
    });

    // --- Communication with Chrome Extension ---
    window.addEventListener('message', (event) => {
        // Security check could be added here if needed
        const data = event.data;
        if (!data || !data.type) return;

        if (data.type === 'EXT_PONG' || data.type === 'EXT_READY') {
            if (!isExtensionConnected) {
                isExtensionConnected = true;
                statusDot.classList.remove('disconnected');
                statusDot.classList.add('connected');
                statusText.textContent = 'Extension Connected';
                checkStartButton();
            }
        }

        if (data.type === 'EXT_SCRAPE_RESULT') {
            handleScrapeResult(data.payload);
        }
    });

    // Periodically ping to check if extension is alive
    setInterval(() => {
        window.postMessage({ type: 'APP_PING' }, '*');
    }, 2000);


    // --- CSV Upload ---
    uploadZone.addEventListener('click', () => fileInput.click());
    uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('dragover'); });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
            handleFile(e.dataTransfer.files[0]);
        }
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) handleFile(e.target.files[0]);
    });

    function handleFile(file) {
        if (file.type !== 'text/csv' && !file.name.endsWith('.csv')) {
            alert('Please upload a valid CSV file exported from LeadTube.');
            return;
        }

        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: function(results) {
                const data = results.data;
                // Expected headers from LeadTube: Channel Name, Subscribers, Emails, Last Upload, Link
                queue = data.map((row, index) => {
                    return {
                        id: index,
                        name: row['Channel Name'] || 'Unknown',
                        subs: row['Subscribers'] || 'N/A',
                        link: row['Link'] || '',
                        status: 'pending', // pending, scraping, done, failed
                        emailsFound: row['Emails'] || '', // Keep existing if any
                        socialsFound: ''
                    };
                }).filter(q => q.link !== ''); // Only keep those with links

                if (queue.length === 0) {
                    alert('No valid channels found in CSV. Ensure it has a "Link" column.');
                    return;
                }

                currentIndex = 0;
                uploadZone.style.display = 'none';
                queueContainer.style.display = 'block';
                btnExport.style.display = 'block';
                statTotal.textContent = queue.length;
                
                renderQueue();
                checkStartButton();
            }
        });
    }

    function checkStartButton() {
        if (isExtensionConnected && queue.length > 0 && !isRunning) {
            btnStart.disabled = false;
        } else {
            btnStart.disabled = true;
        }
    }


    // --- UI Rendering ---
    function renderQueue() {
        queueBody.innerHTML = '';
        let pendingCount = 0;
        let emailsCount = 0;
        let socialsCount = 0;

        queue.forEach((item, index) => {
            if (item.status === 'pending') pendingCount++;
            if (item.emailsFound && item.emailsFound !== 'None') emailsCount++;
            if (item.socialsFound) socialsCount++;

            // Only render window of items for performance if queue is huge
            if (index >= currentIndex - 5 && index <= currentIndex + 20) {
                const tr = document.createElement('tr');
                let statusHtml = `<span class="status-badge status-${item.status}">${item.status}</span>`;
                
                tr.innerHTML = `
                    <td>${statusHtml}</td>
                    <td style="font-weight: 600;">${item.name}</td>
                    <td>${item.subs}</td>
                    <td style="color: #10b981; font-weight: 600;">${item.emailsFound || '-'}</td>
                    <td style="color: #8b5cf6;">${item.socialsFound || '-'}</td>
                    <td>
                        ${(item.status === 'pending' || item.status === 'scraping') ? `<button class="btn-skip" data-id="${item.id}" style="font-size:0.6rem; padding: 0.3rem 0.6rem; border: 1px solid var(--danger); border-radius: 4px; color: var(--danger); background: transparent; cursor: pointer;">Skip</button>` : '-'}
                    </td>
                `;
                if (item.status === 'scraping') tr.style.backgroundColor = 'rgba(99, 102, 241, 0.05)';
                if (item.status === 'skipped') tr.style.opacity = '0.5';
                queueBody.appendChild(tr);
            }
        });

        queueBody.querySelectorAll('.btn-skip').forEach(btn => {
            btn.onclick = () => skipChannel(parseInt(btn.dataset.id));
        });

        queueCount.textContent = pendingCount;
        statEmails.textContent = emailsCount;
        statSocials.textContent = socialsCount;
        
        const progress = queue.length > 0 ? ((queue.length - pendingCount) / queue.length) * 100 : 0;
        progressBar.style.width = `${progress}%`;
    }

    function updateSessionStat() {
        statSession.textContent = `${sessionScrapes} / ${limitSettings.accountLimit}`;
        if (sessionScrapes >= limitSettings.accountLimit) {
            statSession.style.color = 'var(--danger)';
        } else {
            statSession.style.color = 'var(--text-main)';
        }
    }

    // --- Core Engine ---
    window.skipChannel = function(id) {
        const item = queue.find(q => q.id === id);
        if (item && (item.status === 'pending' || item.status === 'scraping')) {
            const wasScraping = item.status === 'scraping';
            item.status = 'skipped';
            renderQueue();
            console.log(`Skipped channel ID ${id}`);
            
            if (wasScraping) {
                activeWorkers--; // Free up the worker slot
                processNext(); // Immediately move to the next channel
            }
        }
    };

    btnStart.addEventListener('click', () => {
        isRunning = true;
        btnStart.style.display = 'none';
        btnPause.style.display = 'block';
        if (btnSkipCurrent) btnSkipCurrent.style.display = 'block';
        processNext();
    });

    btnPause.addEventListener('click', () => {
        pauseBot();
    });
    
    if (btnSkipCurrent) {
        btnSkipCurrent.addEventListener('click', () => {
            const scrapingItems = queue.filter(q => q.status === 'scraping');
            if (scrapingItems.length > 0) {
                scrapingItems.forEach(item => {
                    skipChannel(item.id);
                });
            } else {
                alert('No channel is currently being scraped. The bot might be waiting or paused.');
            }
        });
    }

    btnResumeFlow.addEventListener('click', () => {
        sessionScrapes = 0;
        updateSessionStat();
        accountAlert.style.display = 'none';
        isRunning = true;
        btnStart.style.display = 'none';
        btnPause.style.display = 'block';
        if (btnSkipCurrent) btnSkipCurrent.style.display = 'block';
        processNext();
    });

    function pauseBot() {
        isRunning = false;
        btnStart.style.display = 'block';
        btnPause.style.display = 'none';
        if (btnSkipCurrent) btnSkipCurrent.style.display = 'none';
        checkStartButton();
    }

    function processNext() {
        if (!isRunning) return;

        // Check limits
        if (sessionScrapes >= limitSettings.accountLimit) {
            pauseBot();
            accountAlert.style.display = 'flex';
            return;
        }

        // Spawn workers up to concurrency limit
        while (activeWorkers < limitSettings.concurrency && currentIndex < queue.length) {
            // Find next pending
            let nextIndex = currentIndex;
            while (nextIndex < queue.length && queue[nextIndex].status !== 'pending') {
                nextIndex++;
            }

            if (nextIndex >= queue.length) {
                // Done or waiting for active workers
                if (activeWorkers === 0) {
                    pauseBot();
                    alert('Queue Complete! Download your final CSV.');
                }
                return;
            }

            // Update current index to prevent other workers grabbing the same
            currentIndex = nextIndex + 1;
            
            const currentItem = queue[nextIndex];
            currentItem.status = 'scraping';
            activeWorkers++;
            renderQueue();

            // Extract Channel ID from link to use as Cache Key
            let channelId = currentItem.link.split('/channel/')[1];
            if (!channelId) channelId = currentItem.link; 

            // CHECK GLOBAL CACHE FIRST
            if (globalCache[channelId]) {
                console.log('Cache hit for', channelId);
                const cachedData = globalCache[channelId];
                // Resolve instantly
                handleScrapeResult({
                    id: currentItem.id,
                    emails: cachedData.emails,
                    socials: cachedData.socials,
                    usedCaptcha: false, // Cached, so no limits used
                    error: null
                });
                continue; // Spawn another worker immediately
            }

            // Calculate Stealth Jitter (random variance to delay)
            // Example: if base delay is 3000ms, actual delay might be between 2500ms and 4500ms
            const jitterMs = Math.floor(Math.random() * 2000) - 500; 
            const actualDelay = Math.max(1000, (limitSettings.humanDelay * 1000) + jitterMs);

            // Send to extension
            window.postMessage({
                type: 'APP_COMMAND_SCRAPE',
                payload: {
                    id: currentItem.id,
                    url: currentItem.link,
                    cacheKey: channelId,
                    delayMs: actualDelay
                }
            }, '*');
        }
    }

    function handleScrapeResult(payload) {
        const { id, emails, socials, usedCaptcha, error } = payload;
        
        const item = queue.find(q => q.id === id);
        if (!item) return;
        
        // If the user already skipped this channel while it was scraping, ignore the delayed result
        if (item.status === 'skipped') return;

        if (error) {
            item.status = 'failed';
        } else {
            item.status = 'done';
            
            // Append new emails if existing ones are there, else replace
            if (emails && emails.length > 0) {
                const uniqueEmails = [...new Set([...(item.emailsFound ? item.emailsFound.split(', ') : []), ...emails])];
                item.emailsFound = uniqueEmails.join(', ');
            } else if (!item.emailsFound) {
                item.emailsFound = 'None';
            }

            if (socials && socials.length > 0) {
                item.socialsFound = socials.join(' | ');
            }
            
            // Save to Global Cache
            if (item.emailsFound && item.emailsFound !== 'None' || item.socialsFound) {
                let channelId = item.link.split('/channel/')[1] || item.link;
                globalCache[channelId] = {
                    emails: item.emailsFound ? item.emailsFound.split(', ') : [],
                    socials: socials || []
                };
                localStorage.setItem('extractor_cache', JSON.stringify(globalCache));
            }
            
            if (usedCaptcha) {
                sessionScrapes++;
                updateSessionStat();
            }
        }

        renderQueue();
        activeWorkers--;
        
        // Wait human delay with jitter, then spawn next worker
        const jitterMs = Math.floor(Math.random() * 2000) - 500; 
        const actualDelay = Math.max(500, (limitSettings.humanDelay * 1000) + jitterMs);

        setTimeout(() => {
            processNext();
        }, actualDelay);
    }


    // --- CSV Export ---
    btnExport.addEventListener('click', () => {
        if (queue.length === 0) return;
        
        let csvContent = "data:text/csv;charset=utf-8,Channel Name,Subscribers,Emails,Social Links,Link\n";
        queue.forEach(row => {
            const name = `"${(row.name || '').replace(/"/g, '""')}"`;
            const subs = `"${(row.subs || '').replace(/"/g, '""')}"`;
            const emails = `"${(row.emailsFound || '').replace(/"/g, '""')}"`;
            const socials = `"${(row.socialsFound || '').replace(/"/g, '""')}"`;
            const link = `"${(row.link || '').replace(/"/g, '""')}"`;
            
            csvContent += `${name},${subs},${emails},${socials},${link}\n`;
        });

        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `extracted_leads_${new Date().getTime()}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });

    init();
});
