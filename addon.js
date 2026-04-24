#!/usr/bin/env node

const http = require('http');
const https = require('https');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const {
    fetchOneJavPage,
    fetchTagPage,
    getOneJavDetail,
    searchSukebei,
    searchIjavTorrent,
    videoCache,
    BASE_URL
} = require('./scraper');

const PORT = process.env.PORT || 7006;
const ITEMS_PER_PAGE = 10;

// ===================== CẤU HÌNH TOÀN CỤC =====================
let torrServerEnabled = false;               // Không dùng TorrServer mặc định
let torrServerAddress = '';                 // Người dùng tự điền

// ===================== HTTP REQUEST HELPER =====================
function httpRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const client = urlObj.protocol === 'https:' ? https : http;
        
        const requestOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: options.headers || {},
            timeout: options.timeout || 30000
        };
        
        const req = client.request(requestOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        resolve(data);
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}`));
                }
            });
        });
        
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
        
        if (options.body) {
            req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
        }
        
        req.end();
    });
}

// ===================== TORRSERVER - RETRY 2 LẦN, KHÔNG BỎ SÓT =====================
const torrServerCache = {};
const CACHE_TTL = 30 * 60 * 1000;

async function getTorrServerFiles(tsUrl, magnet, title) {
    try {
        console.log(`[TorrServer] Adding: ${title.substring(0, 40)}...`);
        
        const data = await httpRequest(tsUrl + '/torrents', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'add',
                link: magnet,
                title: title,
                poster: '',
                save_to_db: false
            }),
            timeout: 30000
        });
        
        if (!data || !data.hash) {
            console.log('[TorrServer] Failed to add');
            return null;
        }
        
        console.log(`[TorrServer] Hash: ${data.hash.substring(0, 8)}`);
        
        if (data.file_stats && data.file_stats.length > 0) {
            console.log(`[TorrServer] Got ${data.file_stats.length} files immediately`);
            return { hash: data.hash, files: data.file_stats };
        }
        
        // Retry tối đa 2 lần
        for (let attempt = 1; attempt <= 2; attempt++) {
            await new Promise(r => setTimeout(r, 2000));
            console.log(`[TorrServer] Retry ${attempt}/2...`);
            
            const d = await httpRequest(tsUrl + '/torrents', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'get', hash: data.hash }),
                timeout: 10000
            });
            
            if (d && d.file_stats && d.file_stats.length > 0) {
                console.log(`[TorrServer] Got ${d.file_stats.length} files after retry`);
                return { hash: data.hash, files: d.file_stats };
            }
        }
        
        console.log('[TorrServer] No files after retries, will fallback');
        return { hash: data.hash, files: [] };
    } catch (e) {
        console.error('[TorrServer] Error:', e.message);
        return null;
    }
}

async function getCachedFiles(tsUrl, magnet, title) {
    const hashMatch = magnet.match(/btih:([a-fA-F0-9]{40})/i);
    const cacheKey = hashMatch ? hashMatch[1].toLowerCase() : null;
    
    if (cacheKey) {
        const cached = torrServerCache[cacheKey];
        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
            console.log('[Cache] Hit:', cacheKey.substring(0, 8));
            return { hash: cacheKey, files: cached.files };
        }
    }
    
    const result = await getTorrServerFiles(tsUrl, magnet, title);
    if (result && result.files.length > 0 && cacheKey) {
        torrServerCache[cacheKey] = { files: result.files, timestamp: Date.now() };
    }
    return result;
}

function findMovieFile(files) {
    if (!files || files.length === 0) return null;
    
    const videoExts = ['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.ts'];
    const excludeKeywords = ['sample', 'trailer', 'opening', 'ending', 'preview', 'menu', 'extra', 'bonus'];
    
    const allFiles = files.map((f, idx) => ({
        ...f,
        _realIndex: (f.id !== undefined && f.id !== null) ? Number(f.id) : idx
    }));
    
    const videoFiles = allFiles.filter(f => 
        videoExts.some(ext => (f.path || '').toLowerCase().endsWith(ext))
    );
    
    if (videoFiles.length === 0) return null;
    
    const cleanFiles = videoFiles.filter(f => {
        const basename = (f.path || '').split('/').pop().toLowerCase();
        return !excludeKeywords.some(kw => basename.includes(kw));
    });
    
    const targetFiles = cleanFiles.length > 0 ? cleanFiles : videoFiles;
    targetFiles.sort((a, b) => (b.length || 0) - (a.length || 0));
    
    return targetFiles[0];
}

setInterval(() => {
    const now = Date.now();
    let deleted = 0;
    Object.keys(torrServerCache).forEach(k => {
        if (now - torrServerCache[k].timestamp > CACHE_TTL) {
            delete torrServerCache[k];
            deleted++;
        }
    });
    if (deleted > 0) console.log('[Cache] Cleaned', deleted, 'entries');
}, 10 * 60 * 1000);

// ===================== MANIFEST =====================
const manifest = {
    id: 'com.jav.addon.v6',
    version: '6.0.1',
    name: '🎌 JAV Addon',
    description: 'OneJAV + Sukebei + iJavTorrent + TorrServer (tự chọn)',
    resources: ['catalog', 'meta', 'stream'],
    types: ['Javfast', 'movie'],
    idPrefixes: ['onejav_'],
    behaviorHints: {
        configurable: true,
        configurationRequired: false
    },
    catalogs: [
        { type: 'Javfast', id: 'jav-search', name: '🔍 Tìm kiếm', extra: [{ name: 'search', isRequired: true }] },
        { type: 'Javfast', id: 'jav-new', name: '🎌 Mới nhất', extra: [{ name: 'skip' }] },
        { type: 'Javfast', id: 'jav-tag-big-tits', name: '🎌 Big Tits', extra: [{ name: 'skip' }] },
        { type: 'Javfast', id: 'jav-tag-creampie', name: '🎌 Creampie', extra: [{ name: 'skip' }] },
        { type: 'Javfast', id: 'jav-tag-anal', name: '🎌 Anal', extra: [{ name: 'skip' }] },
        { type: 'Javfast', id: 'jav-tag-amateur', name: '🎌 Amateur', extra: [{ name: 'skip' }] },
        { type: 'Javfast', id: 'jav-tag-blow', name: '🎌 Blow', extra: [{ name: 'skip' }] },
        { type: 'Javfast', id: 'jav-tag-cosplay', name: '🎌 Cosplay', extra: [{ name: 'skip' }] },
        { type: 'Javfast', id: 'jav-tag-uncensored', name: '🎌 Uncensored', extra: [{ name: 'skip' }] },
        { type: 'Javfast', id: 'jav-tag-solowork', name: '🎌 Solowork', extra: [{ name: 'skip' }] },
        { type: 'Javfast', id: 'jav-tag-lesbian', name: '🎌 Lesbian', extra: [{ name: 'skip' }] },
        { type: 'Javfast', id: 'jav-tag-4hr', name: '🎌 4HR+', extra: [{ name: 'skip' }] },
        { type: 'Javfast', id: 'jav-tag-gangbang', name: '🎌 Gangbang', extra: [{ name: 'skip' }] },
        { type: 'Javfast', id: 'jav-tag-cowgirl', name: '🎌 Cowgirl', extra: [{ name: 'skip' }] },
        { type: 'Javfast', id: 'jav-tag-4k', name: '🎌 4K', extra: [{ name: 'skip' }] },
        { type: 'Javfast', id: 'jav-tag-breast-milk', name: '🎌 Breast Milk', extra: [{ name: 'skip' }] },
        { type: 'Javfast', id: 'jav-tag-huge-butt', name: '🎌 Huge Butt', extra: [{ name: 'skip' }] },
        { type: 'Javfast', id: 'jav-tag-small-tits', name: '🎌 Small Tits', extra: [{ name: 'skip' }] },
        { type: 'Javfast', id: 'jav-tag-deep-throating', name: '🎌 Deep Throating', extra: [{ name: 'skip' }] },
        { type: 'Javfast', id: 'jav-tag-married-woman', name: '🎌 Married Woman', extra: [{ name: 'skip' }] },
        { type: 'Javfast', id: 'jav-tag-humiliation', name: '🎌 Humiliation', extra: [{ name: 'skip' }] },
        { type: 'Javfast', id: 'jav-tag-female-warrior', name: '🎌 Female Warrior', extra: [{ name: 'skip' }] },
        { type: 'Javfast', id: 'jav-tag-bitch', name: '🎌 Bitch', extra: [{ name: 'skip' }] },
        { type: 'Javfast', id: 'jav-tag-bukkake', name: '🎌 Bukkake', extra: [{ name: 'skip' }] },
        { type: 'Javfast', id: 'jav-tag-piss-drinking', name: '🎌 Piss Drinking', extra: [{ name: 'skip' }] }
    ]
};

const builder = new addonBuilder(manifest);

// ===================== HÀM TÌM KIẾM =====================
async function searchOneJavMultiPage(query) {
    const cleanQuery = query.split('?')[0];
    let allResults = [];
    for (let page = 1; page <= 3; page++) {
        const searchUrl = page === 1
            ? `${BASE_URL}/search/${encodeURIComponent(cleanQuery)}`
            : `${BASE_URL}/search/${encodeURIComponent(cleanQuery)}?page=${page}`;
        console.log(`[Search] Fetching page ${page}: ${searchUrl}`);
        const data = await fetchOneJavPage(searchUrl);
        if (!data || data.results.length === 0) break;
        allResults.push(...data.results);
        if (data.results.length < 20) break;
        await new Promise(r => setTimeout(r, 300));
    }
    const seen = new Set();
    const unique = allResults.filter(item => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
    });
    console.log(`[Search] Total unique results: ${unique.length}`);
    return unique;
}

// ===================== CATALOG HANDLER =====================
builder.defineCatalogHandler(async (args) => {
    const catalogId = args.id;
    const skip = parseInt(args.extra?.skip) || 0;
    const searchQuery = args.extra?.search;

    console.log(`[Catalog] ${catalogId}, skip=${skip}`);

    if (catalogId === 'jav-search' && searchQuery) {
        const results = await searchOneJavMultiPage(searchQuery);
        const paged = results.slice(skip, skip + ITEMS_PER_PAGE);
        const metas = paged.map(item => ({
            id: item.id,
            type: 'movie',
            name: item.title,
            poster: item.poster || BASE_URL + '/favicon.ico',
            genres: ['JAV']
        }));
        return { metas, hasMore: results.length > skip + ITEMS_PER_PAGE };
    }

    if (catalogId === 'jav-new') {
        const MAX_PAGES = 10;
        let all = [], page = 1, more = true;
        while (all.length < 200 && more && page <= MAX_PAGES) {
            const data = await fetchOneJavPage(page === 1 ? BASE_URL : `${BASE_URL}?page=${page}`);
            all.push(...data.results); more = data.hasMore; page++;
            if (more) await new Promise(r => setTimeout(r, 200));
        }
        const paged = all.slice(skip, skip + ITEMS_PER_PAGE);
        const metas = paged.map(item => ({
            id: item.id, type: 'movie', name: item.title,
            poster: item.poster || BASE_URL + '/favicon.ico', genres: ['JAV']
        }));
        return { metas, hasMore: all.length > skip + ITEMS_PER_PAGE };
    }

    const page = Math.floor(skip / ITEMS_PER_PAGE) + 1;
    let data;
    if (catalogId.startsWith('jav-tag-')) {
        let tag = catalogId.replace('jav-tag-', '').replace(/-/g, ' ');
        tag = tag.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        data = await fetchTagPage(tag, page);
    } else return { metas: [], hasMore: false };

    if (!data?.results?.length) return { metas: [], hasMore: false };
    const start = skip % ITEMS_PER_PAGE;
    const paged = data.results.slice(start, start + ITEMS_PER_PAGE);
    const metas = paged.map(item => ({
        id: item.id, type: 'movie', name: item.title,
        poster: item.poster || BASE_URL + '/favicon.ico', genres: ['JAV']
    }));
    return { metas, hasMore: (data.results.length > start + ITEMS_PER_PAGE) || data.hasMore };
});

// ===================== META HANDLER =====================
builder.defineMetaHandler(async (args) => {
    const id = args.id;
    console.log('[Meta] Request:', id);
    const javId = id.replace('onejav_', '');
    const detail = await getOneJavDetail('/torrent/' + javId).catch(() => null);
    if (!detail) {
        return { meta: { id, type: 'movie', name: javId, genres: ['JAV'] } };
    }
    return {
        meta: {
            id,
            type: 'movie',
            name: javId,
            poster: detail.poster || BASE_URL + '/favicon.ico',
            description: detail.description || '',
            genres: ['JAV'],
            cast: detail.actress
        }
    };
});

// ===================== STREAM HANDLER (CÂN BẰNG) =====================
builder.defineStreamHandler(async (args) => {
    console.log('[Stream] Request:', args.id);
    const javId = args.id.replace('onejav_', '');
    let detail = videoCache.get(args.id)?.detail;
    if (!detail) detail = await getOneJavDetail('/torrent/' + javId).catch(() => null);
    
    const [suke, ijav] = await Promise.all([
        searchSukebei(javId).catch(() => ({ magnets: [] })),
        searchIjavTorrent(javId).catch(() => ({ magnets: [] }))
    ]);
    
    const streams = [];

    const addStream = async (sourceName, title, magnetLink, seeders = 0, isTorrentFile = false) => {
        if (!magnetLink) return;
        
        if (seeders === 0 && !isTorrentFile) {
            console.log(`[Stream] ⏭️ Skip 0 seed: ${title.substring(0, 40)}`);
            return;
        }
        
        if (torrServerEnabled && torrServerAddress) {
            const tsBase = torrServerAddress.replace(/\/$/, '');
            
            try {
                const result = await getCachedFiles(tsBase, magnetLink, title);
                
                if (result && result.files && result.files.length > 0) {
                    const videoFile = findMovieFile(result.files);
                    
                    if (videoFile) {
                        const streamUrl = `${tsBase}/stream/${encodeURIComponent(title)}?link=${result.hash}&index=${videoFile._realIndex}&play`;
                        streams.push({
                            name: `🎌 ${sourceName}`,
                            title: `${title}\n📁 ${videoFile.path.split('/').pop()}\n💾 ${((videoFile.length || 0) / (1024*1024*1024)).toFixed(2)} GB`,
                            url: streamUrl,
                            behaviorHints: { notWebReady: true }
                        });
                        console.log(`[Stream] ✅ ${sourceName}`);
                        return;
                    }
                }
                
                // Fallback
                console.log(`[Stream] ⚠️ Fallback: ${title.substring(0, 40)}`);
                const streamUrl = `${tsBase}/stream/${encodeURIComponent(title)}?link=${encodeURIComponent(magnetLink)}&index=0&play`;
                streams.push({
                    name: `🎌 ${sourceName}`,
                    title: title,
                    url: streamUrl,
                    behaviorHints: { notWebReady: true }
                });
            } catch (e) {
                console.error(`[Stream] ❌ ${sourceName}:`, e.message);
                if (isTorrentFile) {
                    streams.push({
                        name: `🎌 ${sourceName} (Direct)`,
                        title: title,
                        externalUrl: magnetLink
                    });
                }
            }
        } else {
            streams.push({
                name: `🎌 ${sourceName}`,
                title: title,
                externalUrl: magnetLink
            });
        }
    };

    // === 1. FILE .TORRENT TỪ ONEJAV ===
    for (const t of (detail?.torrentLinks || [])) {
        if (t.url) {
            await addStream(`OneJAV Torrent`, t.title, t.url, 999, true);
        }
    }
    
    // === 2. IJAVTORRENT ===
    for (const m of (ijav.magnets || []).slice(0, 8)) {
        if (m.url && m.seeders > 0) {
            await addStream(`iJavTorrent [S:${m.seeders}]`, m.title, m.url, m.seeders);
        }
    }
    
    // === 3. SUKEBEI ===
    for (const m of (suke.magnets || []).slice(0, 5)) {
        if (m.url && m.seeders > 0) {
            await addStream(`Sukebei [S:${m.seeders}]`, m.title, m.url, m.seeders);
        }
    }
    
    // === 4. ONEJAV MAGNETS ===
    for (const m of (detail?.magnets || []).slice(0, 3)) {
        if (m.url) {
            await addStream(`OneJAV Magnet`, m.title, m.url, 1);
        }
    }

    console.log(`[Stream] Returning ${streams.length} streams`);
    return { streams };
});

// ===================== SERVER & ROUTER =====================
const addonInterface = builder.getInterface();
const router = getRouter(addonInterface);

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = reqUrl.pathname;

    if (pathname === '/manifest.json' || pathname === '/') {
        const tsEnabled = reqUrl.searchParams.get('tsEnabled');
        if (tsEnabled === 'true') {
            torrServerEnabled = true;
            const addr = reqUrl.searchParams.get('tsAddress');
            if (addr) torrServerAddress = decodeURIComponent(addr);
            console.log('[Config] TorrServer enabled:', torrServerAddress);
        } else if (tsEnabled === 'false') {
            torrServerEnabled = false;
        }
    }

    if (pathname === '/configure') {
        const baseUrl = `http://${req.headers.host}`;
        const query = reqUrl.searchParams;
        
        let formEnabled = torrServerEnabled;
        let formAddress = torrServerAddress;
        
        if (query.has('tsEnabled')) {
            formEnabled = query.get('tsEnabled') === 'true';
            const addrParam = query.get('tsAddress');
            if (addrParam) {
                let addr = decodeURIComponent(addrParam);
                if (addr.includes('%')) addr = decodeURIComponent(addr);
                formAddress = addr;
            }
        }
        
        // Avatar SVG đơn giản, nền trong suốt, phong cách hồng
        const actressSvg = (hairColor, skinColor) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <circle cx="32" cy="20" r="10" fill="${skinColor || '#FFD1DC'}"/>
  <path d="M22 24 Q32 12 42 24" fill="${hairColor || '#FF99BB'}"/>
  <path d="M20 40 L32 60 L44 40 Z" fill="#FF99BB" opacity="0.8"/>
  <circle cx="28" cy="18" r="2" fill="#333"/>
  <circle cx="36" cy="18" r="2" fill="#333"/>
  <path d="M28 24 Q32 27 36 24" stroke="#333" fill="none" stroke-width="1.5"/>
</svg>`;
const actressAvatars = [
    { name: 'Yui Hatano', img: 'https://www.javdatabase.com/idolimages/full/yui-hatano.webp' },
    { name: 'Aoi Sora', img: 'https://i.ebayimg.com/images/g/938AAOSwAfVldJTD/s-l1200.webp' },
    { name: 'Hitomi Tanaka', img: 'https://cdn.prod.website-files.com/604b55671d49be06bbe00910/624dbf80350f7d779c0cedaa_5e5fce49579a534175c1364f_Hitomi-Tanaka-2.jpeg' },
    { name: 'Maria Ozawa', img: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9c/Dasdas_Special_AV_Event_by_LonelyBob_%28Maria_Ozawa_crop%29.jpg/500px-Dasdas_Special_AV_Event_by_LonelyBob_%28Maria_Ozawa_crop%29.jpg' }
];
        
        const actressCards = actressAvatars.map(a => {
            const imgUrl = a.img;
            return `<div class="actress-card">
                <img src="${imgUrl}" alt="${a.name}" class="actress-img" loading="lazy">
                <span class="actress-name">${a.name}</span>
            </div>`;
        }).join('');
        
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🌸 JAV Addon · Cấu hình</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Inter', sans-serif;
            background: linear-gradient(135deg, #ffe4ec 0%, #ffd1e0 50%, #ffc0d5 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 20px;
            color: #4a3040;
        }
        .card {
            max-width: 600px;
            width: 100%;
            background: rgba(255, 255, 255, 0.75);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255, 105, 180, 0.2);
            border-radius: 32px;
            padding: 36px 30px;
            box-shadow: 0 30px 50px rgba(255, 105, 180, 0.15);
        }
        .header {
            display: flex;
            align-items: center;
            gap: 14px;
            margin-bottom: 18px;
        }
        .icon {
            width: 52px;
            height: 52px;
            background: linear-gradient(145deg, #ff8da1, #ff5e7e);
            border-radius: 18px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 28px;
            box-shadow: 0 10px 20px rgba(255, 94, 126, 0.3);
        }
        h1 {
            font-size: 28px;
            font-weight: 700;
            letter-spacing: -0.5px;
            color: #cc3366;
        }
        .badge {
            background: #ff8da1;
            color: white;
            font-size: 12px;
            font-weight: 700;
            padding: 3px 10px;
            border-radius: 20px;
            margin-left: 10px;
            letter-spacing: 0.5px;
        }
        .subtitle {
            font-size: 15px;
            color: #b34e6b;
            margin-bottom: 16px;
            border-left: 4px solid #ff5e7e;
            padding-left: 18px;
            font-weight: 500;
        }
        .actress-section {
            margin-bottom: 24px;
        }
        .actress-label {
            font-weight: 600;
            font-size: 14px;
            margin-bottom: 10px;
            color: #cc3366;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .actress-grid {
            display: flex;
            gap: 16px;
            justify-content: center;
            flex-wrap: wrap;
        }
        .actress-card {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 6px;
        }
        .actress-img {
            width: 64px;
            height: 64px;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.7);
            backdrop-filter: blur(4px);
            border: 2px solid #ffb6c1;
            box-shadow: 0 6px 12px rgba(255, 105, 180, 0.2);
            transition: transform 0.2s;
        }
        .actress-card:hover .actress-img {
            transform: scale(1.05);
            border-color: #ff5e7e;
        }
        .actress-name {
            font-size: 12px;
            font-weight: 500;
            color: #7a4055;
            text-align: center;
            max-width: 80px;
        }
        .feature-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            margin-bottom: 28px;
        }
        .feature-item {
            background: rgba(255, 255, 255, 0.5);
            border: 1px solid rgba(255, 105, 180, 0.15);
            border-radius: 20px;
            padding: 18px 16px;
            backdrop-filter: blur(10px);
        }
        .feature-title {
            font-weight: 600;
            font-size: 15px;
            margin-bottom: 6px;
            display: flex;
            align-items: center;
            gap: 6px;
            color: #cc3366;
        }
        .feature-desc {
            font-size: 12px;
            color: #8a6070;
            line-height: 1.5;
        }
        .config-section {
            background: rgba(255, 240, 245, 0.8);
            border-radius: 24px;
            padding: 24px 22px;
            margin-bottom: 26px;
            border: 1px solid rgba(255, 105, 180, 0.25);
        }
        .switch-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 20px;
        }
        .switch-label {
            font-weight: 600;
            font-size: 16px;
            color: #b34e6b;
        }
        .switch-label small {
            display: block;
            font-weight: 400;
            font-size: 12px;
            color: #b37085;
            margin-top: 4px;
        }
        .switch {
            position: relative;
            display: inline-block;
            width: 52px;
            height: 28px;
        }
        .switch input { opacity: 0; width: 0; height: 0; }
        .slider {
            position: absolute;
            cursor: pointer;
            top: 0; left: 0; right: 0; bottom: 0;
            background-color: #ffccd5;
            transition: .2s;
            border-radius: 34px;
        }
        .slider:before {
            position: absolute;
            content: "";
            height: 22px;
            width: 22px;
            left: 3px;
            bottom: 3px;
            background-color: white;
            transition: .2s;
            border-radius: 50%;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        input:checked + .slider {
            background: linear-gradient(145deg, #ff8da1, #ff5e7e);
        }
        input:checked + .slider:before {
            transform: translateX(24px);
        }
        .input-group {
            margin-top: 8px;
        }
        .input-group label {
            display: block;
            font-size: 13px;
            font-weight: 500;
            margin-bottom: 8px;
            color: #a34460;
        }
        .input-field {
            width: 100%;
            padding: 14px 18px;
            background: rgba(255, 255, 255, 0.8);
            border: 1.5px solid #ffb6c1;
            border-radius: 20px;
            font-size: 14px;
            color: #4a3040;
            outline: none;
            font-family: 'Inter', monospace;
            backdrop-filter: blur(10px);
            transition: border 0.2s;
        }
        .input-field:focus {
            border-color: #ff5e7e;
            box-shadow: 0 0 0 4px rgba(255, 94, 126, 0.1);
        }
        .url-box {
            background: rgba(255, 255, 255, 0.7);
            border: 1px dashed #ff8da1;
            border-radius: 20px;
            padding: 20px;
            margin: 24px 0 20px;
            word-break: break-all;
            font-family: 'SF Mono', 'Menlo', monospace;
            font-size: 13px;
            color: #cc3366;
        }
        .button-group {
            display: flex;
            gap: 12px;
        }
        .btn {
            flex: 1;
            padding: 16px 0;
            border: none;
            border-radius: 40px;
            font-weight: 600;
            font-size: 16px;
            cursor: pointer;
            background: #ffe4ec;
            color: #cc3366;
            border: 1px solid #ffb6c1;
            transition: all 0.2s;
        }
        .btn-primary {
            background: linear-gradient(145deg, #ff8da1, #ff5e7e);
            border: none;
            color: white;
            box-shadow: 0 12px 20px -8px rgba(255, 94, 126, 0.4);
        }
        .btn-primary:hover {
            box-shadow: 0 15px 25px -6px rgba(255, 94, 126, 0.5);
            transform: translateY(-2px);
        }
        .note {
            margin-top: 22px;
            font-size: 12px;
            color: #b37a8c;
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="header">
            <div class="icon">🌸</div>
            <h1>JAV Addon <span class="badge">v6.0.1</span></h1>
        </div>
        <div class="subtitle">⚡ OneJAV + Sukebei + iJavTorrent · Cân bằng</div>
        
        <div class="actress-section">
            <div class="actress-label">🌟 Diễn viên nổi bật</div>
            <div class="actress-grid">
                ${actressCards}
            </div>
        </div>
        
        <div class="feature-grid">
            <div class="feature-item"><div class="feature-title">🔍 Tìm kiếm</div><div class="feature-desc">Tìm trực tiếp trên OneJAV.</div></div>
            <div class="feature-item"><div class="feature-title">🏷️ Nhiều Tags</div><div class="feature-desc">Big Tits, Creampie, Anal...</div></div>
            <div class="feature-item"><div class="feature-title">🧲 Đa nguồn</div><div class="feature-desc">iJavTorrent, Sukebei, OneJAV.</div></div>
            <div class="feature-item"><div class="feature-title">⚖️ Cân bằng</div><div class="feature-desc">Retry 2 lần, không bỏ magnet.</div></div>
        </div>
        <div class="config-section">
            <div class="switch-row">
                <div class="switch-label">📡 TorrServer <small>Phát torrent qua HTTP streaming</small></div>
                <label class="switch"><input type="checkbox" id="ts" ${formEnabled ? 'checked' : ''}><span class="slider"></span></label>
            </div>
            <div class="input-group">
                <label>🌐 Địa chỉ TorrServer</label>
                <input type="url" id="addr" class="input-field" value="${formAddress.replace(/"/g, '&quot;')}" placeholder="http://192.168.1.10:8090" spellcheck="false">
            </div>
        </div>
        <button class="btn btn-primary" onclick="generateAndShow()">✨ Tạo link cài đặt</button>
        <div id="urlContainer" style="display: none;">
            <div class="url-box" id="urlText"></div>
            <div class="button-group">
                <button class="btn" onclick="copyUrl()">📋 Copy Link</button>
                <button class="btn btn-primary" onclick="installAddon()">💾 Cài vào Stremio</button>
            </div>
        </div>
        <div class="note">🌸 Retry 2 lần · Fallback cho mọi magnet · Bỏ qua 0 seed (trừ OneJAV Torrent)</div>
    </div>
    <script>
        const baseManifest = '${baseUrl}/manifest.json';
        let currentUrl = '';
        
        function generateManifestUrl() {
            const enabled = document.getElementById('ts').checked;
            const address = document.getElementById('addr').value.trim();
            const params = new URLSearchParams();
            if (enabled) {
                params.set('tsEnabled', 'true');
                if (address) params.set('tsAddress', encodeURIComponent(address));
            } else {
                params.set('tsEnabled', 'false');
            }
            return baseManifest + '?' + params.toString();
        }
        
        function generateAndShow() {
            currentUrl = generateManifestUrl();
            document.getElementById('urlText').textContent = currentUrl;
            document.getElementById('urlContainer').style.display = 'block';
        }
        
        function copyUrl() {
            if (!currentUrl) generateAndShow();
            navigator.clipboard?.writeText(currentUrl).then(() => alert('✅ Đã copy link!')).catch(() => prompt('📋 Copy thủ công:', currentUrl));
        }
        
        function installAddon() {
            if (!currentUrl) generateAndShow();
            location.href = 'stremio://' + currentUrl.replace(/^https?:\\/\\//, '');
        }
        
        window.onload = generateAndShow;
    </script>
</body>
</html>`);
        return;
    }

    router(req, res, (err) => {
        if (err) {
            console.error('Router error:', err);
            res.writeHead(500);
            res.end('Internal Server Error');
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ JAV Addon v6.0.1 chạy tại http://0.0.0.0:${PORT}`);
    console.log(`📋 Manifest: http://127.0.0.1:${PORT}/manifest.json`);
    console.log(`⚙️  Cấu hình: http://127.0.0.1:${PORT}/configure`);
    console.log(`📡 TorrServer: TẮT mặc định (người dùng tự điền nếu cần)`);
    console.log(`⚡ Sources: OneJAV + Sukebei + iJavTorrent`);
    console.log(`⚖️ Balanced mode: Retry 2 lần, luôn fallback`);
});
