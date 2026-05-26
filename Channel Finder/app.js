document.addEventListener('DOMContentLoaded', () => {
    // State Management
    let savedLeads = [];
    try {
        savedLeads = JSON.parse(localStorage.getItem('saved_leads')) || [];
    } catch(e) { console.error('Corrupted leads data'); }
    
    let searchHistory = [];
    try {
        searchHistory = JSON.parse(localStorage.getItem('search_history')) || [];
    } catch(e) { console.error('Corrupted history data'); }

    let globalSeenIds = new Set();
    try {
        const storedSeen = JSON.parse(localStorage.getItem('global_seen_ids')) || [];
        globalSeenIds = new Set(storedSeen);
    } catch(e) { console.error('Corrupted global seen data'); }

    // ── Async DB sync on startup ──
    async function syncStateFromDB() {
        try {
            const [leadsRes, histRes, seenRes] = await Promise.all([
                fetch('/hub/cf/leads'),
                fetch('/hub/cf/search_history'),
                fetch('/hub/cf/global_seen')
            ]);
            if (leadsRes.ok) {
                const dbLeads = await leadsRes.json();
                if (dbLeads && dbLeads.length > 0) {
                    savedLeads = dbLeads;
                    localStorage.setItem('saved_leads', JSON.stringify(savedLeads));
                }
            }
            if (histRes.ok) {
                const dbHist = await histRes.json();
                if (dbHist && dbHist.length > 0) {
                    searchHistory = dbHist;
                    localStorage.setItem('search_history', JSON.stringify(searchHistory));
                }
            }
            if (seenRes.ok) {
                const dbSeen = await seenRes.json();
                if (dbSeen && dbSeen.length > 0) {
                    globalSeenIds = new Set(dbSeen);
                    localStorage.setItem('global_seen_ids', JSON.stringify(dbSeen));
                }
            }
            renderLeads();
            renderHistory();
        } catch (e) {
            console.error('Failed to sync state from server DB:', e);
        }
    }
    syncStateFromDB();

    let currentNextPageToken = '';
    let currentHistoryId = null;
    let seenChannelIds = new Set();
    let currentPageCount = 0;
    let scannedCount = 0;
    let emailsFoundCount = 0;
    let isFlowRunning = false;

    // UI Elements
    const navItems = document.querySelectorAll('.nav-item');
    const searchBtn = document.getElementById('btn-search');
    const stopBtn = document.getElementById('btn-stop');
    const searchInput = document.getElementById('search-query');
    const countrySelect = document.getElementById('search-country');
    const languageSelect = document.getElementById('search-language');
    const excludeCountriesInput = document.getElementById('exclude-countries');
    const searchResults = document.getElementById('search-results');
    const workflowCanvas = document.querySelector('.workflow-canvas');
    const liveFeedContainer = document.getElementById('live-intelligence-container');
    const liveFeed = document.getElementById('live-feed');
    const statScanned = document.getElementById('stat-scanned');
    const statEmails = document.getElementById('stat-emails');
    const historyList = document.getElementById('history-list');
    const savedLeadsGrid = document.getElementById('saved-leads');
    const loadMoreBtn = document.getElementById('btn-load-more');
    const loadMoreContainer = document.getElementById('load-more-container');
    const apiKeysInput = document.getElementById('api-keys-input');
    const vaultStatusDisplay = document.getElementById('vault-status-display');
    const saveSettingsBtn = document.getElementById('btn-save-settings');
    const btnGenerateGoogle = document.getElementById('btn-generate-google');
    const btnBulkImport = document.getElementById('btn-bulk-import');
    const btnBulkImportMain = document.getElementById('btn-bulk-import-main');
    const bulkImportInput = document.getElementById('bulk-import-input');
    const bulkImportMain = document.getElementById('bulk-import-main');
    const hyperDriveMode = document.getElementById('hyper-drive-mode');
    const deepDiscoveryMode = document.getElementById('deep-discovery-mode');
    const clearHistoryBtn = document.getElementById('btn-clear-history');
    
    // AI Elements
    const btnNicheNuke = document.getElementById('btn-niche-nuke');
    const lookalikeInput = document.getElementById('lookalike-input');
    const btnLookalike = document.getElementById('btn-lookalike');
    const thumbnailLookalikeInput = document.getElementById('thumbnail-lookalike-input');
    const btnThumbnailLookalike = document.getElementById('btn-thumbnail-lookalike');
    const aiIcebreakerMode = document.getElementById('ai-icebreaker-mode');
    const universeModeCheckbox = document.getElementById('universe-mode');
    const maxPagesInput = document.getElementById('max-pages');
    const geminiApiKeyInput = document.getElementById('gemini-api-key');
    const btnSaveAi = document.getElementById('btn-save-ai');

    const views = {
        search: document.getElementById('view-search'),
        leads: document.getElementById('view-leads'),
        history: document.getElementById('view-history'),
        settings: document.getElementById('view-settings')
    };

    // --- INITIALIZATION ---
    function init() {
        if (apiKeysInput && window.ytApi) apiKeysInput.value = window.ytApi.apiKeys.join('\n');
        if (geminiApiKeyInput && window.aiApi) geminiApiKeyInput.value = window.aiApi.apiKeys.join('\n');
        updateVaultStatus();
        renderLeads();
        renderHistory();
        attachListeners();
    }

    function attachListeners() {
        if (btnNicheNuke) {
            btnNicheNuke.addEventListener('click', (e) => {
                executeNicheNuke();
            });
        }

        if (navItems) navItems.forEach(item => {
            item.addEventListener('click', () => {
                navItems.forEach(i => i.classList.remove('active'));
                item.classList.add('active');
                const viewId = item.id.replace('nav-', '');
                Object.keys(views).forEach(v => { if(views[v]) views[v].style.display = 'none' });
                if(views[viewId]) views[viewId].style.display = 'block';
            });
        });

        if (searchBtn) searchBtn.addEventListener('click', () => startFlow());
        if (stopBtn) stopBtn.addEventListener('click', () => { isFlowRunning = false; stopBtn.textContent = 'Stopping...'; });
        if (saveSettingsBtn) saveSettingsBtn.addEventListener('click', () => saveVault());
        if (loadMoreBtn) loadMoreBtn.addEventListener('click', () => {
            if (!currentNextPageToken && currentHistoryId) {
                // If campaign is finished, offer refresh
                if (confirm('This campaign discovery reached the end. Would you like to REFRESH it to check for brand new channels?')) {
                    currentNextPageToken = '';
                } else {
                    return;
                }
            }
            
            const queries = searchInput.value.split('\n').map(q => q.trim()).filter(q => q);
            const query = queries[0] || '';
            const country = countrySelect.value;
            performSearch(query, country, currentNextPageToken);
        });
        
        if (btnGenerateGoogle) btnGenerateGoogle.addEventListener('click', () => generateGoogleLinks());
        if (btnBulkImport) btnBulkImport.addEventListener('click', () => bulkImportLeads(bulkImportInput.value));
        if (btnBulkImportMain) btnBulkImportMain.addEventListener('click', () => bulkImportLeads(bulkImportMain.value));
        if (clearHistoryBtn) clearHistoryBtn.addEventListener('click', async () => {
            if (confirm('Are you sure you want to delete all search history? This will also delete the cached results.')) {
                searchHistory = [];
                saveHistory();
                try { await fetch('/hub/cf/search_history', { method: 'DELETE' }); } catch(e) { console.error('DB clear history failed:', e); }
            }
        });
        
        if (btnLookalike) btnLookalike.addEventListener('click', () => executeLookalike());
        if (btnThumbnailLookalike) btnThumbnailLookalike.addEventListener('click', () => executeThumbnailDiscovery());
        if (btnSaveAi) btnSaveAi.addEventListener('click', () => saveAiVault());

        const btnClearGlobalSeen = document.getElementById('btn-clear-global-seen');
        if (btnClearGlobalSeen) btnClearGlobalSeen.addEventListener('click', async () => {
            if (confirm('Are you sure you want to clear the Discovery Cache? This will allow previously found channels to show up again in new searches.')) {
                globalSeenIds.clear();
                localStorage.removeItem('global_seen_ids');
                try { await fetch('/hub/cf/global_seen', { method: 'DELETE' }); } catch(e) { console.error('DB clear seen failed:', e); }
                alert('Discovery Cache cleared!');
            }
        });


        // Language Tag Listeners
        const langTags = document.querySelectorAll('.lang-tag');
        langTags.forEach(tag => {
            tag.addEventListener('click', () => {
                tag.classList.toggle('active');
            });
        });

        // Remote Switcher (for Hub integration)
        window.addEventListener('message', (event) => {
            if (event.data.type === 'SWITCH_VIEW') {
                const viewId = event.data.viewId;
                if (views[viewId]) {
                    navItems.forEach(i => i.classList.remove('active'));
                    const navItem = document.getElementById(`nav-${viewId}`);
                    if (navItem) navItem.classList.add('active');
                    
                    Object.keys(views).forEach(v => { if(views[v]) views[v].style.display = 'none' });
                    views[viewId].style.display = 'block';
                }
            }
        });
    }

    function saveAiVault() {
        if (!geminiApiKeyInput) return;
        const keys = geminiApiKeyInput.value.split('\n').map(k => k.trim()).filter(k => k);
        if (keys.length > 0) {
            window.aiApi.setApiKey(keys);
            alert(`Saved ${keys.length} Gemini API keys to the vault!`);
        } else {
            alert('Please enter at least one valid Gemini API key.');
        }
    }

    async function executeNicheNuke() {
        const query = searchInput.value.trim();
        if (!query) {
            alert("Please enter a broad niche in the search box first (e.g., 'Gaming')");
            return;
        }
        
        // Get selected languages
        const selectedLangs = Array.from(document.querySelectorAll('.lang-tag.active')).map(tag => tag.dataset.lang);
        if (selectedLangs.length === 0) {
            alert("Please select at least one language for AI expansion.");
            return;
        }

        if (!window.aiApi.apiKey) {
            alert("Gemini API Key is missing! Go to API Settings to add your key.");
            const settingsNav = document.getElementById('nav-settings');
            if (settingsNav) settingsNav.click();
            return;
        }

        btnNicheNuke.textContent = "Generating...";
        btnNicheNuke.disabled = true;
        
        try {
            addLog(`Niche Nuke: Expanding "${query}" for languages: ${selectedLangs.join(', ')}...`, 'warning');
            const niches = await window.aiApi.generateNiches(query, selectedLangs);
            
            if (niches.length === 0) {
                alert("AI could not generate any keywords for this niche. Try a broader term.");
                addLog(`Niche Nuke: Expansion yielded no results.`, 'error');
                return;
            }

            searchInput.value = niches.join('\n');
            addLog(`Niche Nuke: Expanded into ${niches.length} global sub-niches.`, 'success');
        } catch (e) {
            console.error("Niche Nuke Error:", e);
            alert("Error: " + e.message);
            addLog(`Niche Nuke Error: ${e.message}`, 'error');
        } finally {
            btnNicheNuke.textContent = "☢️ Niche Nuke (AI Expand)";
            btnNicheNuke.disabled = false;
        }
    }

    async function executeLookalike() {
        const input = lookalikeInput.value.trim();
        if (!input) {
            alert("Please enter a Channel ID or URL");
            return;
        }
        
        btnLookalike.textContent = "Cloning...";
        btnLookalike.disabled = true;
        
        try {
            // Extract channel ID or handle
            let channelId = '';
            let handle = '';

            const idMatch = input.match(/UC[a-zA-Z0-9_-]{22}/);
            const handleMatch = input.match(/@([a-zA-Z0-9._-]+)/);

            if (idMatch) channelId = idMatch[0];
            else if (handleMatch) handle = handleMatch[1];
            else if (input.includes('youtube.com/')) {
                // Try to see if there is a slug at the end
                const parts = input.split('/');
                const last = parts[parts.length - 1];
                if (last.startsWith('@')) handle = last.substring(1);
                else channelId = last;
            } else {
                channelId = input;
            }

            addLog(`Lookalike Engine: Fetching data for ${input}...`, 'warning');
            
            let params = { part: 'snippet,contentDetails,statistics' };
            if (handle) params.forHandle = handle;
            else params.id = channelId;

            const data = await window.ytApi.fetch('channels', params);
            if (!data.items || data.items.length === 0) throw new Error("Channel not found. Ensure the ID or @handle is correct.");
            
            const channel = data.items[0];
            const uploadsId = channel.contentDetails?.relatedPlaylists?.uploads;
            
            let tagsAndTitles = "";
            if (uploadsId) {
                const videos = await window.ytApi.getLatestVideos(uploadsId);
                videos.items.forEach(v => {
                    tagsAndTitles += v.snippet.title + "\n";
                });
            }
            
            if (!tagsAndTitles) throw new Error("No recent videos found to clone context from.");
            
            addLog(`Lookalike Engine: AI analyzing channel DNA...`, 'system');
            const cloneKeywords = await window.aiApi.extractKeywordsFromTags(tagsAndTitles);
            
            searchInput.value = cloneKeywords.join('\n');
            addLog(`Lookalike Engine: Found ${cloneKeywords.length} clone vectors. Launching flow...`, 'success');
            
            // Auto-start flow
            startFlow();
            
        } catch (e) {
            alert("Error: " + e.message);
            addLog(`Lookalike Error: ${e.message}`, 'error');
        } finally {
            btnLookalike.textContent = "Find Similar Channels";
            btnLookalike.disabled = false;
        }
    }

    async function executeThumbnailDiscovery() {
        const input = thumbnailLookalikeInput.value.trim();
        if (!input) {
            alert("Please enter a Video URL or Thumbnail URL");
            return;
        }

        // Extract video ID
        let videoId = '';
        const vMatch = input.match(/(?:v=|\/v\/|embed\/|youtu\.be\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
        if (vMatch) videoId = vMatch[1];
        else {
            if (input.length === 11) videoId = input;
        }

        if (!videoId) {
            alert("Could not extract Video ID from the URL. Please paste a standard YouTube video link.");
            return;
        }

        btnThumbnailLookalike.textContent = "Analyzing...";
        btnThumbnailLookalike.disabled = true;

        try {
            addLog(`Thumbnail DNA: Fetching video metadata for ${videoId}...`, 'warning');
            const data = await window.ytApi.getVideoDetails(videoId);
            if (!data.items || data.items.length === 0) throw new Error("Video not found");

            const video = data.items[0];
            const metadata = `Title: ${video.snippet.title}\nDescription: ${video.snippet.description}\nTags: ${video.snippet.tags?.join(', ') || 'N/A'}`;
            
            addLog(`Thumbnail DNA: AI analyzing visual context and niche...`, 'system');
            const queries = await window.aiApi.generateThumbnailSearchQueries(metadata);
            
            searchInput.value = queries.join('\n');
            addLog(`Thumbnail DNA: Found ${queries.length} visual vectors. Launching flow...`, 'success');
            
            // Set deep discovery mode for better visual results
            if (deepDiscoveryMode) deepDiscoveryMode.checked = true;
            
            // Auto-start flow
            startFlow();
        } catch (e) {
            alert("Error: " + e.message);
            addLog(`Thumbnail DNA Error: ${e.message}`, 'error');
        } finally {
            btnThumbnailLookalike.textContent = "Find Similar Thumbnails";
            btnThumbnailLookalike.disabled = false;
        }
    }

    // Run Init
    init();
    // --- CORE ENGINE ---
    function addLog(message, type = '') {
        if (!liveFeed) return;
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        entry.textContent = `[${time}] ${message}`;
        liveFeed.prepend(entry);
        if (liveFeed.childNodes.length > 50) liveFeed.lastChild.remove();
    }

    function updateVaultStatus() {
        if (!window.ytApi || !vaultStatusDisplay) return;
        const status = window.ytApi.getVaultStatus();
        vaultStatusDisplay.textContent = `Vault: ${status.current}/${status.total} Keys Active (Current: ${status.keySnippet})`;
    }

    async function startFlow(isResume = false) {
        const queries = searchInput.value.split('\n').map(q => q.trim()).filter(q => q);
        const country = countrySelect.value;
        const autoPilot = document.getElementById('autopilot-mode').checked;
        const universeMode = universeModeCheckbox ? universeModeCheckbox.checked : false;
        const maxPages = maxPagesInput ? parseInt(maxPagesInput.value) || 20 : 20;

        if (queries.length === 0) return;

        // Reset state only if NOT resuming and NOT already in a campaign context
        isFlowRunning = true;
        
        let isContextResume = isResume || (currentHistoryId && currentNextPageToken);
        
        if (currentHistoryId) {
            const entry = searchHistory.find(h => h.id === currentHistoryId);
            if (entry && entry.query !== queries.join(', ')) {
                isContextResume = false;
            }
        }

        if (!isContextResume) {
            seenChannelIds.clear();
            currentNextPageToken = '';
            currentPageCount = 0;
            searchResults.innerHTML = '';
            currentHistoryId = null; 
            addLog('Initializing new discovery flow...', 'system');
        } else {
            addLog(`Resuming campaign discovery: ${queries[0]}...`, 'warning');
        }

        loadMoreContainer.style.display = 'none';
        searchBtn.disabled = true;
        searchBtn.textContent = 'Flow Running...';
        stopBtn.style.display = 'block';
        workflowCanvas.classList.add('running');
        liveFeedContainer.style.display = 'block';

        if (!isResume && !currentHistoryId) {
            currentHistoryId = Date.now();
            searchHistory.unshift({
                id: currentHistoryId,
                query: queries.join(', '),
                country: country,
                token: '',
                found: 0,
                results: [],
                timestamp: new Date().toLocaleString()
            });
            saveHistory();
        }

        for (const query of queries) {
            if (!isFlowRunning) break;

            searchResults.innerHTML += `<div style="grid-column: 1/-1; text-align: center; padding: 1rem; color: var(--accent-solid); border-bottom: 1px solid var(--border);">🚀 Discovery Expansion: ${query}...</div>`;
            addLog(`Expanding discovery: ${query}`, 'system');

            if (universeMode) {
                // Infinite Date-Slice Crawling
                let currentDate = new Date();
                let sliceCount = 0;
                const daysPerSlice = 7; // Weekly slices

                while (isFlowRunning && sliceCount < maxPages) {
                    const endDate = new Date(currentDate);
                    currentDate.setDate(currentDate.getDate() - daysPerSlice);
                    const startDate = new Date(currentDate);

                    const publishedBefore = endDate.toISOString();
                    const publishedAfter = startDate.toISOString();

                    addLog(`Universe Mode: Slicing timeframe ${startDate.toLocaleDateString()} to ${endDate.toLocaleDateString()}...`, 'system');
                    
                    let sliceToken = '';
                    let slicePageCount = 0;
                    // Paginate WITHIN the time slice if auto-pilot is on
                    do {
                        await performSearch(query, country, sliceToken, { publishedAfter, publishedBefore, order: 'date' });
                        sliceToken = currentNextPageToken;
                        slicePageCount++;
                        if (sliceToken && isFlowRunning && autoPilot) {
                            addLog(`Universe Mode: Crawling deep page ${slicePageCount} within slice...`, 'system');
                            await new Promise(r => setTimeout(r, 800)); // Safety delay
                        }
                    } while (autoPilot && sliceToken && isFlowRunning && slicePageCount < 10); // cap at 10 pages per slice (500 limit)
                    
                    sliceCount++;
                    currentPageCount++;
                    if (isFlowRunning) await new Promise(r => setTimeout(r, 800)); // Safety delay between slices
                }
            } else {
                // Standard Search
                await performSearch(query, country);
                
                while (autoPilot && currentNextPageToken && isFlowRunning && currentPageCount < maxPages) {
                    currentPageCount++;
                    addLog(`Auto-Pilot: Crawling page ${currentPageCount}/${maxPages}...`, 'system');
                    await new Promise(r => setTimeout(r, 800)); // Safety delay
                    await performSearch(query, country, currentNextPageToken);
                }
            }
            currentPageCount = 0; // Reset for next query
        }

        isFlowRunning = false;
        searchBtn.disabled = false;
        searchBtn.textContent = 'Run Massive Flow';
        stopBtn.style.display = 'none';
        workflowCanvas.classList.remove('running');
        addLog('Flow sequence completed.', 'system');
    }

    function updateStats() {
        if (statScanned) statScanned.textContent = `${scannedCount} Scanned`;
        if (statEmails) statEmails.textContent = `${emailsFoundCount} Emails Found`;
    }

    async function performSearch(query, country, pageToken = '', additionalOptions = {}) {
        const isInitial = !pageToken && !additionalOptions.publishedAfter;
        
        const minSubs = parseInt(document.getElementById('filter-min-subs').value) || 0;
        const maxSubs = parseInt(document.getElementById('filter-max-subs').value) || Infinity;
        const recencyDays = document.getElementById('filter-recency').value;
        const excludeCountries = (excludeCountriesInput ? excludeCountriesInput.value : '').split(',').map(c => c.trim().toUpperCase()).filter(c => c);
        const language = languageSelect ? languageSelect.value : '';

        if (isInitial && searchResults.innerHTML === '') {
            searchResults.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 4rem;">⛓️ Flow Initialized: Discovering Channels...</div>';
            addLog(`Flow Started: ${query} (${country || 'Global'})`, 'system');
        }

        try {
            const searchType = deepDiscoveryMode.checked ? 'video' : 'channel';
            const options = { ...additionalOptions };
            if (language) options.relevanceLanguage = language;

            const data = await window.ytApi.searchChannels(query, country, pageToken, searchType, options);
            let items = data.items || [];
            currentNextPageToken = data.nextPageToken || '';

            // If video discovery, transform video items into channel skeletons
            if (searchType === 'video') {
                addLog(`Deep Discovery: Extracting channels from top videos...`, 'warning');
                const seenInPage = new Set();
                const uniqueItems = [];
                items.forEach(item => {
                    const cid = item.snippet.channelId;
                    if (!seenInPage.has(cid)) {
                        seenInPage.add(cid);
                        uniqueItems.push({
                            id: { channelId: cid },
                            snippet: {
                                channelId: cid,
                                title: item.snippet.channelTitle,
                                thumbnails: item.snippet.thumbnails
                            }
                        });
                    }
                });
                items = uniqueItems;
            }
            
            // Update History Token
            if (currentHistoryId) {
                const entry = searchHistory.find(h => h.id === currentHistoryId);
                if (entry) {
                    entry.token = currentNextPageToken;
                    saveHistory();
                }
            }
            
            if (items.length === 0) {
                addLog(`YouTube API returned 0 results for "${query}".`, 'warning');
            }

            const channelIds = items.map(item => item.id.channelId).join(',');
            
            if (channelIds) {
                const channelDetails = await window.ytApi.getChannelDetails(channelIds);
                
                const detailMap = {};
                if (channelDetails && channelDetails.items) {
                    channelDetails.items.forEach(c => {
                        detailMap[c.id] = {
                            country: c.snippet.country,
                            subs: parseInt(c.statistics.subscriberCount),
                            views: c.statistics.viewCount,
                            videos: c.statistics.videoCount,
                            uploadsId: c.contentDetails?.relatedPlaylists?.uploads,
                            realThumbnail: c.snippet.thumbnails
                        };
                    });
                } else {
                    addLog('Failed to fetch channel details for discovered IDs.', 'error');
                }

                const totalInitial = items.length;
                const selectedCountry = countrySelect.value;

                items = items.filter(item => {
                    const info = detailMap[item.id.channelId];
                    if (!info) return false;
                    
                    // STRICT Country Filter: If they selected a country, the channel MUST match.
                    const selectedCountry = countrySelect ? countrySelect.value : '';
                    if (selectedCountry) {
                        if (!info.country || info.country !== selectedCountry) return false;
                    }
                    
                    // Exclude specific countries
                    if (excludeCountries.length > 0 && info.country && excludeCountries.includes(info.country)) return false;
                    
                    // Subscriber Filter
                    const actualSubs = isNaN(info.subs) ? 0 : info.subs;
                    if (actualSubs < minSubs || actualSubs > maxSubs) return false;
                    
                    // Fix thumbnail if it was a video (Deep Discovery Mode)
                    if (searchType === 'video' && info.realThumbnail) {
                        item.snippet.thumbnails = info.realThumbnail;
                    }
                    
                    // Assign stats early for recency check
                    item.stats = info;
                    return true;
                });
                addLog(`Found ${totalInitial} raw channels. ${items.length} passed strict exclusion/sub filters.`, 'system');

                if (recencyDays !== 'any' && items.length > 0) {
                    const recencyFilteredItems = [];
                    const now = new Date();
                    const limitDate = new Date(now.setDate(now.getDate() - parseInt(recencyDays)));

                    for (const item of items) {
                        try {
                            const uploadsId = item.stats.uploadsId;
                            if (!uploadsId) continue;
                            const vids = await window.ytApi.getLatestVideos(uploadsId);
                            if (vids.items.length > 0) {
                                const lastDate = new Date(vids.items[0].snippet.publishedAt);
                                if (lastDate >= limitDate) {
                                    item.lastUpload = vids.items[0].snippet.publishedAt;
                                    recencyFilteredItems.push(item);
                                }
                            }
                        } catch (e) {
                            console.warn("Recency check failed for", item.snippet.title, e.message);
                        }
                    }
                    addLog(`Recency filter complete: ${recencyFilteredItems.length} channels active in last ${recencyDays} days.`, 'system');
                    items = recencyFilteredItems;
                }

                // Update history count and store results (ONCE per page)
                if (currentHistoryId) {
                    const entry = searchHistory.find(h => h.id === currentHistoryId);
                    if (entry) {
                        entry.found += items.length;
                        // Store essential info only to save space
                        const simplifiedResults = items.map(it => ({
                            id: it.id,
                            snippet: it.snippet,
                            stats: it.stats,
                            lastUpload: it.lastUpload,
                            emails: it.emails
                        }));
                        entry.results = [...(entry.results || []), ...simplifiedResults];
                        saveHistory();
                    }
                }
                
                // Stats already assigned in filter loop above
            } else {
                items = []; // Ensure items is empty if no channelIds
            }

            // Render results IMMEDIATELY so user sees progress
            renderResults(items);

            // HYPER-DRIVE: Automated Analysis (Email Extraction)
            if (hyperDriveMode.checked && items.length > 0) {
                addLog(`Processing batch of ${items.length} channels...`, 'warning');
                for (const item of items) {
                    if (!isFlowRunning) break;
                    try {
                        const analysis = await deepAnalyzeChannel(item.id.channelId);
                        item.emails = analysis.emails;
                        item.latestVideoTitle = analysis.latestVideoTitle;
                        scannedCount++;
                        
                        // Update the card in the UI if it exists
                        const existingCard = searchResults.querySelector(`[data-id="${item.id.channelId}"]`)?.closest('.card');
                        if (existingCard && item.emails.length > 0) {
                            const emailTag = document.createElement('div');
                            emailTag.className = 'email-tag';
                            emailTag.textContent = item.emails.join(', ');
                            existingCard.querySelector('.card-content').insertBefore(emailTag, existingCard.querySelector('.card-actions'));
                        }

                        if (item.emails.length > 0) {
                            emailsFoundCount += item.emails.length;
                            addLog(`SUCCESS: Found ${item.emails.length} emails for ${item.snippet.title}`, 'success');
                            
                            if (aiIcebreakerMode && aiIcebreakerMode.checked && analysis.latestVideoTitle) {
                                addLog(`AI Personalizer: Generating icebreaker...`, 'system');
                                try {
                                    item.icebreaker = await window.aiApi.generateIcebreaker(analysis.latestVideoTitle);
                                    if (existingCard) {
                                        const iceDiv = existingCard.querySelector('.icebreaker-tag');
                                        if (iceDiv) iceDiv.dataset.icebreaker = item.icebreaker.replace(/"/g, '&quot;');
                                    }
                                } catch (e) {
                                    console.error("Icebreaker error", e);
                                }
                            }
                        } else {
                            addLog(`Scanned ${item.snippet.title}: No public email.`, '');
                        }
                        updateStats();
                    } catch (e) {
                        addLog(`Error analyzing ${item.snippet.title}: ${e.message}`, 'error');
                    }
                }
            }

            if (items.length === 0) {
                if (isInitial) {
                    searchResults.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 4rem; color: var(--text-dim);">
                        📡 No channels found matching these exact filters.<br>
                        <span style="font-size: 0.8rem;">Try broadening your subscriber range or clearing the country filter.</span>
                    </div>`;
                }
                addLog(`Page ${currentPageCount || 1} complete. 0 channels matched your specific filters. Continuing crawl...`, 'warning');
            }

            
            // Show Load More button if we are in a campaign or have results
            if (currentHistoryId || currentNextPageToken) {
                loadMoreContainer.style.display = 'block';
                loadMoreBtn.textContent = currentNextPageToken ? 'Load More Channels' : 'Refresh to find New Channels';
            } else {
                loadMoreContainer.style.display = 'none';
            }

            if (!currentNextPageToken && items.length === 0 && searchResults.innerHTML !== '') {
                addLog(`End of API Limit for this keyword. YouTube maxes out at ~500 results per query. Use Niche Nuke to find more!`, 'warning');
            }

        } catch (error) {
            console.error('Search failed:', error);
            addLog(`CRITICAL ERROR: ${error.message}`, 'error');
            // We don't alert here to prevent breaking the Auto-Pilot flow
        }
    }

    // Export to CSV
    document.getElementById('btn-export-csv').addEventListener('click', () => {
        const cards = searchResults.querySelectorAll('.card');
        if (cards.length === 0) {
            alert('No data to export!');
            return;
        }

        let csvContent = "data:text/csv;charset=utf-8,Channel Name,Subscribers,Emails,Last Upload,Icebreaker,Last Video Title,Link\n";
        cards.forEach(card => {
            const name = card.querySelector('.card-title').textContent.replace(/,/g, '');
            const statsElements = card.querySelectorAll('.stats');
            const subs = statsElements[0].textContent.replace(/,/g, '').trim();
            const lastUpload = statsElements[1].textContent.replace('Last Upload: ', '').trim();
            const emailTag = card.querySelector('.email-tag');
            const emails = emailTag ? emailTag.textContent.replace('✉️ ', '').replace(/,/g, ';') : '';
            const icebreakerDiv = card.querySelector('.icebreaker-tag');
            let icebreaker = icebreakerDiv ? icebreakerDiv.dataset.icebreaker : '';
            icebreaker = icebreaker.replace(/"/g, '""'); // escape quotes for CSV
            const lastVideoDiv = card.querySelector('.lastvideo-tag');
            let lastVideo = lastVideoDiv ? lastVideoDiv.dataset.lastvideo : '';
            lastVideo = lastVideo.replace(/"/g, '""'); // escape quotes for CSV
            const id = card.querySelector('.btn-inspect').dataset.id;
            const link = `https://youtube.com/channel/${id}`;
            csvContent += `"${name}","${subs}","${emails}","${lastUpload}","${icebreaker}","${lastVideo}","${link}"\n`;
        });

        const encodedUri = encodeURI(csvContent);
        const downloadLink = document.createElement("a");
        downloadLink.setAttribute("href", encodedUri);
        downloadLink.setAttribute("download", `leadtube_export_${new Date().getTime()}.csv`);
        document.body.appendChild(downloadLink);
        downloadLink.click();
    });

    function renderResults(items, isHistory = false) {
        if (!items || items.length === 0) return;

        items.forEach(item => {
            const channel = item.snippet;
            const channelId = item.id.channelId || item.snippet.channelId;

            // Skip if already in CURRENT session view
            if (seenChannelIds.has(channelId)) return;
            
            // Skip if in GLOBAL list (Optional: could add a toggle for this)
            // if (!isHistory && globalSeenIds.has(channelId)) return;


            seenChannelIds.add(channelId);
            
            // Persist to global list if it's a NEW discovery
            if (!isHistory) {
                globalSeenIds.add(channelId);
                localStorage.setItem('global_seen_ids', JSON.stringify([...globalSeenIds]));
                // Debounced sync to server (only save every 5 seconds max)
                if (!window._seenSyncTimer) {
                    window._seenSyncTimer = setTimeout(() => {
                        fetch('/hub/cf/global_seen', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify([...globalSeenIds])
                        }).catch(e => console.error('Failed to sync global_seen:', e));
                        window._seenSyncTimer = null;
                    }, 5000);
                }
            }

            const card = document.createElement('div');
            card.className = 'card';
            card.innerHTML = `
                <div class="thumbnail-container">
                    <img class="thumbnail" src="${channel.thumbnails.high ? channel.thumbnails.high.url : channel.thumbnails.medium.url}" alt="avatar">
                </div>
                <div class="card-content">
                    <div class="country-tag">${countrySelect ? countrySelect.value || 'Global' : 'Global'} Region</div>
                    <div class="card-title">${channel.title}</div>
                    <div class="stats" style="color: var(--text-main); font-weight: 600; margin-bottom: 0.25rem;">
                        ${Number(item.stats.subs).toLocaleString()} Subscribers
                    </div>
                    <div class="stats" style="font-size: 0.7rem; margin-bottom: 0.5rem;">
                        Last Upload: ${item.lastUpload ? new Date(item.lastUpload).toLocaleDateString() : 'N/A'}
                    </div>
                    ${item.emails && item.emails.length > 0 ? `
                        <div class="email-tag">${item.emails.join(', ')}</div>
                    ` : ''}
                    ${item.latestVideoTitle ? `
                        <div class="lastvideo-tag" style="display:none;" data-lastvideo="${item.latestVideoTitle.replace(/"/g, '&quot;')}"></div>
                    ` : ''}
                    ${item.icebreaker ? `
                        <div class="icebreaker-tag" style="display:none;" data-icebreaker="${item.icebreaker.replace(/"/g, '&quot;')}"></div>
                    ` : ''}
                    <div class="card-actions">
                        <button class="btn-inspect" data-id="${channelId}">Analyze</button>
                        <button class="btn-secondary btn-save" data-id="${channelId}" data-name="${channel.title}">⭐</button>
                    </div>
                </div>
            `;
            searchResults.appendChild(card);
        });

        searchResults.querySelectorAll('.btn-inspect').forEach(btn => {
            btn.onclick = () => analyzeChannel(btn.dataset.id);
        });

        searchResults.querySelectorAll('.btn-save').forEach(btn => {
            btn.onclick = () => saveLead(btn.dataset.id, btn.dataset.name);
        });
    }

    async function deepAnalyzeChannel(channelId) {
        const channelData = await window.ytApi.getChannelDetails(channelId);
        const channel = channelData.items[0];
        const uploadsId = channel.contentDetails?.relatedPlaylists?.uploads;
        let allText = channel.snippet.description;
        let latestVideoTitle = null;
        
        if (uploadsId) {
            const videos = await window.ytApi.getLatestVideos(uploadsId);
            if (videos.items.length > 0) {
                latestVideoTitle = videos.items[0].snippet.title;
            }
            videos.items.forEach(v => allText += ' ' + v.snippet.description);
        }
        
        const emails = window.ytApi.extractEmails(allText);
        return { channel, emails, latestVideoTitle };
    }

    async function analyzeChannel(channelId) {
        const btn = document.querySelector(`[data-id="${channelId}"].btn-inspect`);
        const originalText = btn.textContent;
        btn.textContent = '...';

        try {
            const { channel, emails } = await deepAnalyzeChannel(channelId);
            const stats = channel.statistics;
            const emailDisplay = emails.length > 0 ? emails.join(', ') : 'No email found';

            alert(`CHANNEL: ${channel.snippet.title}\nSUBS: ${Number(stats.subscriberCount).toLocaleString()}\nEMAIL: ${emailDisplay}`);
            window.open(`https://www.youtube.com/channel/${channelId}/about`, '_blank');
        } catch (error) {
            alert('Error: ' + error.message);
        } finally {
            btn.textContent = originalText;
        }
    }

    function saveLead(id, name) {
        if (savedLeads.find(l => l.id === id)) return;
        const lead = { id, name, status: 'potential', date: new Date().toLocaleDateString() };
        savedLeads.push(lead);
        localStorage.setItem('saved_leads', JSON.stringify(savedLeads));
        renderLeads();
        fetch('/hub/cf/leads', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(lead)
        }).catch(e => console.error('Failed to sync lead to DB:', e));
    }

    function renderLeads() {
        if (savedLeads.length === 0) {
            savedLeadsGrid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 4rem;">No leads.</div>';
            return;
        }
        savedLeadsGrid.innerHTML = '';
        savedLeads.forEach(lead => {
            const card = document.createElement('div');
            card.className = 'card';
            card.innerHTML = `
                <div class="card-content">
                    <div class="card-title">${lead.name}</div>
                    <div class="card-actions">
                        <button onclick="window.open('https://www.youtube.com/channel/${lead.id}', '_blank')">View</button>
                        <button class="btn-secondary" onclick="removeLead('${lead.id}')">Remove</button>
                    </div>
                </div>
            `;
            savedLeadsGrid.appendChild(card);
        });
    }

    window.removeLead = (id) => {
        savedLeads = savedLeads.filter(l => l.id !== id);
        localStorage.setItem('saved_leads', JSON.stringify(savedLeads));
        renderLeads();
        fetch(`/hub/cf/leads/${id}`, { method: 'DELETE' }).catch(e => console.error('Failed to delete lead from DB:', e));
    };

    // 3D Tilt and Parallax Effect
    document.addEventListener('mousemove', (e) => {
        const workflow = document.querySelector('.workflow-canvas');
        const nodes = document.querySelectorAll('.node');
        
        // Canvas Parallax
        const moveX = (e.clientX - window.innerWidth / 2) * 0.01;
        const moveY = (e.clientY - window.innerHeight / 2) * 0.01;
        workflow.style.transform = `rotateX(${-moveY}deg) rotateY(${moveX}deg)`;

        nodes.forEach(node => {
            const rect = node.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            
            if (x > 0 && x < rect.width && y > 0 && y < rect.height) {
                const centerX = rect.width / 2;
                const centerY = rect.height / 2;
                const rotateX = (centerY - y) / 10;
                const rotateY = (x - centerX) / 10;
                node.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.1, 1.1, 1.1) translateZ(50px)`;
            } else {
                node.style.transform = `perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1) translateZ(0)`;
            }
        });
    });

    // Remove the old vertical parallax scroll as it conflicts with horizontal wave
    window.removeEventListener('scroll', () => {});

    function saveVault() {
        const keys = apiKeysInput.value.split('\n').map(k => k.trim()).filter(k => k);
        if (keys.length > 0) {
            window.ytApi.setApiKeys(keys);
            updateVaultStatus();
            alert(`Saved ${keys.length} keys to the vault!`);
        } else {
            alert('Please enter at least one valid API key.');
        }
    }

    function generateGoogleLinks() {
        const queries = searchInput.value.split('\n').map(q => q.trim()).filter(q => q);
        if (queries.length === 0) {
            alert('Enter keywords in Node 1 first!');
            return;
        }

        const country = countrySelect.value;
        const countryTerm = country ? `"${country}"` : '';
        
        queries.forEach(q => {
            const googleQuery = `site:youtube.com "${q}" ${countryTerm} "about"`;
            const url = `https://www.google.com/search?q=${encodeURIComponent(googleQuery)}`;
            window.open(url, '_blank');
        });
        
        addLog('External Recon: Shadow links opened. Copy channel IDs/URLs into Bulk Import.', 'system');
    }

    async function bulkImportLeads(input) {
        if (!input) return;
        const channelIds = [...new Set(input.match(/(UC[a-zA-Z0-9_-]{22})/g) || [])];
        if (channelIds.length === 0) {
            alert('No valid Channel IDs found. Ensure they start with "UC..."');
            return;
        }

        addLog(`Bulk Import: Hydrating ${channelIds.length} channels...`, 'warning');
        if (views.search) document.getElementById('nav-search').click();
        searchResults.innerHTML = '';
        
        isFlowRunning = true;
        searchBtn.disabled = true;
        stopBtn.style.display = 'block';
        workflowCanvas.classList.add('running');

        for (let i = 0; i < channelIds.length; i += 50) {
            if (!isFlowRunning) break;
            const batch = channelIds.slice(i, i + 50);
            await processHydrationBatch(batch);
        }

        isFlowRunning = false;
        searchBtn.disabled = false;
        stopBtn.style.display = 'none';
        workflowCanvas.classList.remove('running');
        addLog('Bulk hydration complete.', 'success');
    }

    function saveHistory() {
        localStorage.setItem('search_history', JSON.stringify(searchHistory));
        renderHistory();
        // Sync all history entries to server DB
        searchHistory.forEach(item => {
            fetch('/hub/cf/search_history', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(item)
            }).catch(e => console.error('Failed to sync history to DB:', e));
        });
    }

    function renderHistory() {
        if (!historyList) return;
        
        if (searchHistory.length === 0) {
            historyList.innerHTML = '<div style="text-align: center; padding: 4rem; color: var(--text-dim);">No search history found yet.</div>';
            return;
        }

        historyList.innerHTML = '';
        searchHistory.forEach(item => {
            const div = document.createElement('div');
            div.style.cssText = 'background: var(--bg-surface); border: 1px solid var(--border); border-radius: 16px; padding: 1.5rem; display: flex; align-items: center; justify-content: space-between; transition: var(--transition);';
            div.innerHTML = `
                <div style="flex: 1;">
                    <div style="font-weight: 800; font-size: 1.1rem; color: var(--accent-solid); margin-bottom: 0.25rem;">${item.query}</div>
                    <div style="font-size: 0.8rem; color: var(--text-dim);">Region: ${item.country || 'Global'} • Started: ${item.timestamp}</div>
                    <div style="margin-top: 0.5rem; display: flex; gap: 1rem; font-size: 0.75rem; font-weight: 600;">
                        <span>📊 ${item.found} Leads Found</span>
                        <span style="color: ${item.token ? '#fbbf24' : '#10b981'};">● ${item.token ? 'In Progress' : 'Completed'}</span>
                    </div>
                </div>
                <div style="display: flex; gap: 0.75rem;">
                    <button class="btn-view-results" style="background: rgba(99, 102, 241, 0.1); color: var(--accent-solid); border: 1px solid rgba(99, 102, 241, 0.2); padding: 0.6rem 1.2rem; font-size: 0.8rem;">View Results</button>
                    <button class="btn-resume" style="background: var(--accent); padding: 0.6rem 1.2rem; font-size: 0.8rem;">Resume Flow</button>
                    <button class="btn-delete-history" style="background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2); padding: 0.6rem 1.2rem; font-size: 0.8rem;">Delete</button>
                </div>
            `;

            div.querySelector('.btn-view-results').onclick = () => {
                const queryList = item.query.split(', ');
                searchInput.value = queryList.join('\n');
                countrySelect.value = item.country;
                currentNextPageToken = item.token;
                currentHistoryId = item.id;
                
                document.getElementById('nav-search').click();
                
                searchResults.innerHTML = '';
                seenChannelIds.clear();
                if (item.results && item.results.length > 0) {
                    renderResults(item.results, true); // true = isHistory
                }
                
                // Show load more for history
                loadMoreContainer.style.display = 'block';
                loadMoreBtn.textContent = item.token ? 'Load More Channels' : 'Refresh to find New Channels';
                
                addLog(`Viewing results for campaign: ${item.query}`, 'system');
            };

            div.querySelector('.btn-resume').onclick = () => {
                const queryList = item.query.split(', ');
                searchInput.value = queryList.join('\n');
                countrySelect.value = item.country;
                currentNextPageToken = item.token;
                currentHistoryId = item.id;
                
                // If the campaign was completed, offer to refresh it
                if (!item.token) {
                    if (confirm('This campaign discovery is complete. Would you like to REFRESH it to check for brand new channels? (Old channels will be automatically hidden)')) {
                        currentNextPageToken = '';
                    } else {
                        return;
                    }
                }
                
                document.getElementById('nav-search').click();
                
                searchResults.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 1rem; color: var(--text-dim);">Re-hydrating campaign leads...</div>';
                seenChannelIds.clear();
                
                setTimeout(() => {
                    searchResults.innerHTML = '';
                    if (item.results && item.results.length > 0) {
                        renderResults(item.results, true); // true = isHistory
                    }
                    startFlow(true);
                }, 300);
            };

            div.querySelector('.btn-delete-history').onclick = async () => {
                searchHistory = searchHistory.filter(h => h.id !== item.id);
                localStorage.setItem('search_history', JSON.stringify(searchHistory));
                renderHistory();
                try { await fetch(`/hub/cf/search_history/${item.id}`, { method: 'DELETE' }); } catch(e) { console.error('DB delete history failed:', e); }
            };

            historyList.appendChild(div);
        });
    }

    async function processHydrationBatch(ids) {
        try {
            const data = await window.ytApi.getChannelDetails(ids.join(','), {
                part: 'snippet,statistics',
                maxResults: 50
            });
            const items = data.items.map(c => ({
                id: { channelId: c.id },
                snippet: c.snippet,
                stats: {
                    subs: parseInt(c.statistics.subscriberCount),
                    views: c.statistics.viewCount,
                    videos: c.statistics.videoCount
                }
            }));

            // Auto-Analyze every imported channel
            if (hyperDriveMode.checked) {
                for (const item of items) {
                    if (!isFlowRunning) break;
                    const analysis = await deepAnalyzeChannel(item.id.channelId);
                    item.emails = analysis.emails;
                    scannedCount++;
                    if (item.emails.length > 0) {
                        emailsFoundCount += item.emails.length;
                        addLog(`SUCCESS: Found email for ${item.snippet.title}`, 'success');
                        
                        if (aiIcebreakerMode && aiIcebreakerMode.checked && analysis.latestVideoTitle) {
                             addLog(`AI Personalizer: Generating icebreaker...`, 'system');
                             try {
                                 item.icebreaker = await window.aiApi.generateIcebreaker(analysis.latestVideoTitle);
                             } catch (e) { }
                        }
                    }
                    updateStats();
                }
            }

            renderResults(items);
        } catch (e) {
            addLog(`Import Error: ${e.message}`, 'error');
        }
    }
});
