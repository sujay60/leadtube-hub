class YouTubeAPI {
    constructor() {
        try {
            this.apiKeys = JSON.parse(localStorage.getItem('yt_api_keys')) || [];
        } catch (e) {
            this.apiKeys = [];
        }
        this.currentKeyIndex = 0;
    }

    get apiKey() {
        return this.apiKeys[this.currentKeyIndex] || '';
    }

    setApiKeys(keys) {
        this.apiKeys = keys.filter(k => k.trim());
        this.currentKeyIndex = 0;
        localStorage.setItem('yt_api_keys', JSON.stringify(this.apiKeys));
        fetch('/hub/cf/yt_keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(this.apiKeys)
        }).catch(e => console.error('Failed to sync yt_keys to server:', e));
    }

    async fetch(endpoint, params = {}) {
        if (!this.apiKey) throw new Error('API Key is missing. Add keys in Settings.');

        const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
        url.searchParams.append('key', this.apiKey);
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.append(key, value);
        }

        const response = await fetch(url);
        const data = await response.json();

        if (data.error || !response.ok) {
            const errorCode = data.error?.code || response.status;
            const errorMessage = data.error?.message || response.statusText;

            // Rotate on Quota Exceeded (403) or Rate Limit (429)
            if (errorCode === 403 || errorCode === 429) {
                console.warn(`API Error ${errorCode}: Key #${this.currentKeyIndex + 1} issue. Attempting rotation...`);
                if (this.rotateKey()) {
                    // Safety delay before retry
                    await new Promise(r => setTimeout(r, 500));
                    return this.fetch(endpoint, params);
                }
            }
            throw new Error(errorMessage || 'Unknown API Error');
        }
        return data;
    }

    rotateKey() {
        if (this.currentKeyIndex < this.apiKeys.length - 1) {
            this.currentKeyIndex++;
            console.log(`Rotating to API Key #${this.currentKeyIndex + 1}`);
            if (window.onKeyRotate) window.onKeyRotate();
            return true;
        }
        console.error('All API keys in the vault have been exhausted.');
        return false;
    }

    getVaultStatus() {
        return {
            current: this.currentKeyIndex + 1,
            total: this.apiKeys.length,
            keySnippet: this.apiKey ? `${this.apiKey.substring(0, 5)}...` : 'None'
        };
    }

    async searchChannels(query, countryCode = '', pageToken = '', searchType = 'channel', options = {}) {
        const params = {
            part: 'snippet',
            maxResults: 50,
            q: query,
            type: searchType, // 'channel' or 'video'
            order: options.order || 'relevance'
        };
        if (countryCode) params.regionCode = countryCode;
        if (pageToken) params.pageToken = pageToken;
        if (options.publishedAfter) params.publishedAfter = options.publishedAfter;
        if (options.publishedBefore) params.publishedBefore = options.publishedBefore;
        if (options.relevanceLanguage) params.relevanceLanguage = options.relevanceLanguage;

        return this.fetch('search', params);
    }

    async getChannelDetails(channelId) {
        return this.fetch('channels', {
            part: 'snippet,statistics,contentDetails,brandingSettings',
            id: channelId
        });
    }

    async getLatestVideos(uploadsPlaylistId) {
        return this.fetch('playlistItems', {
            part: 'snippet',
            playlistId: uploadsPlaylistId,
            maxResults: 10
        });
    }

    async getVideoDetails(videoId) {
        return this.fetch('videos', {
            part: 'snippet,statistics,topicDetails',
            id: videoId
        });
    }

    // Helper to scan for emails in text
    extractEmails(text) {
        if (!text) return [];
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
        const matches = text.match(emailRegex) || [];
        return [...new Set(matches.map(e => e.toLowerCase()))];
    }
}

class AIClient {
    constructor() {
        try {
            this.apiKeys = JSON.parse(localStorage.getItem('gemini_api_keys')) || [];
            // Migration for old single key
            const oldKey = localStorage.getItem('gemini_api_key');
            if (oldKey && !this.apiKeys.includes(oldKey)) {
                this.apiKeys.push(oldKey);
                localStorage.setItem('gemini_api_keys', JSON.stringify(this.apiKeys));
                localStorage.removeItem('gemini_api_key');
            }
        } catch (e) {
            this.apiKeys = [];
        }
        this.currentKeyIndex = 0;
    }

    get apiKey() {
        return this.apiKeys[this.currentKeyIndex] || '';
    }

    setApiKey(keys) {
        if (typeof keys === 'string') {
            this.apiKeys = keys.split('\n').map(k => k.trim()).filter(k => k);
        } else {
            this.apiKeys = keys;
        }
        this.currentKeyIndex = 0;
        localStorage.setItem('gemini_api_keys', JSON.stringify(this.apiKeys));
        fetch('/hub/api_keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(this.apiKeys)
        }).catch(e => console.error('Failed to sync gemini_keys to server:', e));
    }

    rotateKey() {
        if (this.currentKeyIndex < this.apiKeys.length - 1) {
            this.currentKeyIndex++;
            console.log(`Rotating to Gemini Key #${this.currentKeyIndex + 1}`);
            return true;
        }
        return false;
    }

    async generateContent(prompt, model = 'gemini-2.0-flash') {
        if (!this.apiKey) {
            throw new Error('Gemini API Key is missing. Add it in Settings.');
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;
        
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [{ text: prompt }]
                    }],
                    generationConfig: {
                        temperature: 0.7
                    }
                })
            });

            const data = await response.json();
            
            if (data.error || !response.ok) {
                const errorCode = data.error?.code || response.status;
                const errorMessage = data.error?.message || 'Unknown API Error';

                // Fallback for "Model Not Found"
                if (errorMessage.toLowerCase().includes('not found') || errorMessage.toLowerCase().includes('not supported')) {
                    if (model === 'gemini-2.0-flash') {
                        console.warn("Gemini 2.0 Flash not available, falling back to 1.5 Flash...");
                        return this.generateContent(prompt, 'gemini-1.5-flash');
                    }
                }

                // Handle quota exceeded with rotation
                if (errorCode === 429 || errorMessage.toLowerCase().includes('quota')) {
                    console.warn(`Gemini Quota Exceeded for Key #${this.currentKeyIndex + 1}. Attempting rotation...`);
                    if (this.rotateKey()) {
                        await new Promise(r => setTimeout(r, 800));
                        return this.generateContent(prompt, model);
                    }
                }
                throw new Error(errorMessage);
            }

            if (!data.candidates || data.candidates.length === 0 || !data.candidates[0].content) {
                if (data.promptFeedback?.blockReason) {
                    throw new Error(`AI Blocked: ${data.promptFeedback.blockReason}. Try a different niche.`);
                }
                throw new Error('AI returned an empty response. Please try again.');
            }

            return data.candidates[0].content.parts[0].text;
        } catch (e) {
            throw e;
        }
    }

    async generateNiches(broadNiche, languages = ['English']) {
        const prompt = `Act as a YouTube SEO Expert. Generate a list of 25 highly specific, long-tail search keywords related to the niche: "${broadNiche}".
        
        TARGET LANGUAGES: ${languages.join(', ')}
        
        REQUIREMENTS:
        1. Provide a mix of keywords for ALL requested languages.
        2. For non-English languages, provide the actual native search terms (e.g., for Spanish, use "Canales de tecnología").
        3. The keywords should be optimized to find established YouTube channels in these regions.
        4. Return ONLY the keywords, one per line. No introduction, no numbers, no extra symbols.`;
        
        const result = await this.generateContent(prompt);
        return result.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    }

    async extractKeywordsFromTags(tagsAndTitles) {
         const prompt = `Extract 5 core YouTube search phrases based on the following tags and titles from a channel. 
         Return ONLY the phrases, one per line, with no numbering or bullet points. Make them broad enough to find similar channels, but specific enough to be relevant.
         
         Data:
         ${tagsAndTitles}`;
         
         const result = await this.generateContent(prompt);
         return result.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    }

    async generateIcebreaker(videoTitle) {
        const prompt = `Write a casual, friendly, 1-sentence cold email opening line complementing a YouTube creator on their recent video titled: "${videoTitle}". 
        Keep it short, natural, not salesy, and don't include quotes around the sentence. Do not include greetings like "Hey Name". Just the opening line.`;
        
        const result = await this.generateContent(prompt);
        return result.trim();
    }

    async generateThumbnailSearchQueries(videoMetadata) {
        const prompt = `Act as a YouTube Visual Strategist. Based on the following video metadata, generate 10 search phrases that would help find videos with a SIMILAR THUMBNAIL STYLE and NICHE.
        
        Focus on:
        1. Visual style (e.g., minimalist, high-contrast, face-driven)
        2. Content niche (e.g., tech, storytelling, educational)
        3. Search intent.
        
        Metadata:
        ${videoMetadata}
        
        Return ONLY the search phrases, one per line. No introduction, no numbers.`;
        
        const result = await this.generateContent(prompt);
        return result.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    }
}

window.ytApi = new YouTubeAPI();
window.aiApi = new AIClient();

// ── Auto-load keys from server DB on startup ──
(async function initKeysFromDB() {
    try {
        const [ytRes, geminiRes] = await Promise.all([
            fetch('/hub/cf/yt_keys'),
            fetch('/hub/api_keys')
        ]);
        if (ytRes.ok) {
            const ytKeys = await ytRes.json();
            if (ytKeys && ytKeys.length > 0) {
                window.ytApi.apiKeys = ytKeys;
                window.ytApi.currentKeyIndex = 0;
                localStorage.setItem('yt_api_keys', JSON.stringify(ytKeys));
            }
        }
        if (geminiRes.ok) {
            const geminiKeys = await geminiRes.json();
            if (geminiKeys && geminiKeys.length > 0) {
                window.aiApi.apiKeys = geminiKeys;
                window.aiApi.currentKeyIndex = 0;
                localStorage.setItem('gemini_api_keys', JSON.stringify(geminiKeys));
            }
        }
    } catch (e) {
        console.error('Failed to load keys from server DB:', e);
    }
})();
