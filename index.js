#!/usr/bin/env node

const http = require('http');
const url = require('url');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios'); // Dùng axios để gọi API TorrServer
const {
    fetchOneJavPage,
    fetchTagPage,
    searchOneJav,
    getOneJavDetail,
    searchSukebei,
    searchKnaben,
    videoCache,
    BASE_URL
} = require('./scraper');

const PORT = process.env.PORT || 7006;
const ITEMS_PER_PAGE = 10;

// ===================== CẤU HÌNH TOÀN CỤC =====================
let torrServerEnabled = false;
let torrServerAddress = '';

// ===================== MANIFEST =====================
const manifest = {
    id: 'com.jav.addon.v4',
    version: '4.2.0',
    name: '🎌 JAV Addon',
    description: 'OneJAV + Sukebei + Knaben + TorrServer (tự động thêm torrent)',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    idPrefixes: ['onejav_'],
    behaviorHints: {
        configurable: true,
        configurationRequired: false
    },
    catalogs: [
        { type: 'tv', id: 'jav-search', name: '🔍 Tìm kiếm', extra: [{ name: 'search', isRequired: true }] },
        { type: 'tv', id: 'jav-new', name: '🎌 Mới nhất (Trang chủ)', extra: [{ name: 'skip' }] },
        { type: 'tv', id: 'jav-tag-big-tits', name: '🎌 Big Tits', extra: [{ name: 'skip' }] },
        { type: 'tv', id: 'jav-tag-creampie', name: '🎌 Creampie', extra: [{ name: 'skip' }] },
        { type: 'tv', id: 'jav-tag-anal', name: '🎌 Anal', extra: [{ name: 'skip' }] },
        { type: 'tv', id: 'jav-tag-amateur', name: '🎌 Amateur', extra: [{ name: 'skip' }] },
        { type: 'tv', id: 'jav-tag-blow', name: '🎌 Blow', extra: [{ name: 'skip' }] },
        { type: 'tv', id: 'jav-tag-cosplay', name: '🎌 Cosplay', extra: [{ name: 'skip' }] },
        { type: 'tv', id: 'jav-tag-uncensored', name: '🎌 Uncensored', extra: [{ name: 'skip' }] },
        { type: 'tv', id: 'jav-tag-solowork', name: '🎌 Solowork', extra: [{ name: 'skip' }] },
        { type: 'tv', id: 'jav-tag-lesbian', name: '🎌 Lesbian', extra: [{ name: 'skip' }] },
        { type: 'tv', id: 'jav-tag-4hr', name: '🎌 4HR+', extra: [{ name: 'skip' }] },
        { type: 'tv', id: 'jav-tag-gangbang', name: '🎌 Gangbang', extra: [{ name: 'skip' }] },
        { type: 'tv', id: 'jav-tag-cowgirl', name: '🎌 Cowgirl', extra: [{ name: 'skip' }] },
        { type: 'tv', id: 'jav-tag-4k', name: '🎌 4K', extra: [{ name: 'skip' }] },
        { type: 'tv', id: 'jav-tag-breast-milk', name: '🎌 Breast Milk', extra: [{ name: 'skip' }] },
        { type: 'tv', id: 'jav-tag-huge-butt', name: '🎌 Huge Butt', extra: [{ name: 'skip' }] },
        { type: 'tv', id: 'jav-tag-piss-drinking', name: '🎌 Piss Drinking', extra: [{ name: 'skip' }] }
    ]
};

const builder = new addonBuilder(manifest);

// ===================== CATALOG (GIỮ NGUYÊN) =====================
builder.defineCatalogHandler(async (args) => {
    const catalogId = args.id;
    const skip = parseInt(args.extra?.skip) || 0;
    const searchQuery = args.extra?.search;

    console.log(`[Catalog] ${catalogId}, skip=${skip}`);

    if (catalogId === 'jav-search' && searchQuery) {
        const results = await searchOneJav(searchQuery);
        const paged = results.slice(skip, skip + ITEMS_PER_PAGE);
        const metas = paged.map(item => ({
            id: item.id, type: 'tv', name: item.title,
            poster: item.poster || BASE_URL + '/favicon.ico', genres: ['JAV']
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
            id: item.id, type: 'tv', name: item.title,
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
        id: item.id, type: 'tv', name: item.title,
        poster: item.poster || BASE_URL + '/favicon.ico', genres: ['JAV']
    }));
    return { metas, hasMore: (data.results.length > start + ITEMS_PER_PAGE) || data.hasMore };
});

// ===================== META =====================
builder.defineMetaHandler(async (args) => {
    const javId = args.id.replace('onejav_', '');
    const detail = await getOneJavDetail('/torrent/' + javId).catch(() => null);
    if (!detail) return { meta: { id: args.id, type: 'tv', name: javId, genres: ['JAV'] } };
    return { meta: {
        id: args.id, type: 'tv', name: javId, poster: detail.poster || BASE_URL + '/favicon.ico',
        description: detail.description || '', genres: ['JAV'], cast: detail.actress
    } };
});

// ===================== HÀM THÊM TORRENT VÀO TORRSERVER =====================
async function addTorrentToTS(magnet, title) {
    const tsBase = torrServerAddress.replace(/\/$/, '');
    try {
        // Thêm torrent
        const addRes = await axios.post(`${tsBase}/torrents`, {
            link: magnet,
            title: title,
            save_to_db: false
        }, { timeout: 15000 });

        if (!addRes.data || !addRes.data.hash) {
            console.error('[TS] Add torrent failed: no hash returned');
            return null;
        }
        const hash = addRes.data.hash;
        console.log(`[TS] Added torrent, hash: ${hash}`);

        // Chờ TorrServer load metadata (tối đa 10 giây)
        let fileStats = null;
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                const statRes = await axios.post(`${tsBase}/torrents`, {
                    action: 'get',
                    hash: hash
                }, { timeout: 5000 });
                if (statRes.data && statRes.data.file_stats && statRes.data.file_stats.length > 0) {
                    fileStats = statRes.data.file_stats;
                    break;
                }
            } catch (e) {
                // Tiếp tục thử
            }
        }

        if (!fileStats) {
            console.error('[TS] Timeout waiting for file stats');
            return null;
        }

        // Tìm file video đầu tiên (thường index 0)
        const videoFile = fileStats.find(f => f.path.match(/\.(mp4|mkv|avi|mov|wmv|m4v|ts)$/i));
        const index = videoFile ? (videoFile.id !== undefined ? videoFile.id : 0) : 0;

        return { hash, index };
    } catch (e) {
        console.error('[TS] Error adding torrent:', e.message);
        return null;
    }
}

// ===================== STREAM (TÍCH HỢP TORRSERVER TỰ ĐỘNG) =====================
builder.defineStreamHandler(async (args) => {
    const javId = args.id.replace('onejav_', '');
    let detail = videoCache.get(args.id)?.detail;
    if (!detail) detail = await getOneJavDetail('/torrent/' + javId).catch(() => null);
    const [suke, knaben] = await Promise.all([searchSukebei(javId), searchKnaben(javId)]);
    const streams = [];

    const addStream = async (sourceName, title, link, infoHash = null) => {
        const streamObj = { name: sourceName, title: title };

        if (torrServerEnabled && torrServerAddress) {
            // Tự động thêm vào TorrServer và lấy hash/index
            const tsInfo = await addTorrentToTS(link, title);
            if (tsInfo) {
                const tsBase = torrServerAddress.replace(/\/$/, '');
                const streamUrl = `${tsBase}/stream/${encodeURIComponent(title)}?link=${tsInfo.hash}&index=${tsInfo.index}&play`;
                streamObj.url = streamUrl;
                streamObj.behaviorHints = { notWebReady: true };
            } else {
                // Fallback: dùng magnet trực tiếp (ít khi xảy ra)
                streamObj.infoHash = infoHash;
            }
        } else {
            if (infoHash) streamObj.infoHash = infoHash;
            else streamObj.externalUrl = link;
        }
        streams.push(streamObj);
    };

    // Duyệt các nguồn và thêm stream (dùng for...of để đợi tuần tự, tránh quá tải TS)
    for (const m of (knaben.magnets||[])) {
        await addStream(`🎌 Knaben [S:${m.seeders}]`, m.title, m.url, m.infoHash);
    }
    for (const m of (suke.magnets||[])) {
        await addStream(`🎌 Sukebei [S:${m.seeders}]`, m.title, m.url, m.infoHash);
    }
    for (const m of (detail?.magnets||[])) {
        await addStream(`🎌 OneJAV Magnet`, m.title, m.url, m.infoHash);
    }
    for (const t of (detail?.torrentLinks||[])) {
        await addStream(`🎌 OneJAV Torrent`, t.title, t.url, null);
    }

    console.log(`[Stream] Returning ${streams.length} streams. TS: ${torrServerEnabled}`);
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

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // Cập nhật cấu hình từ query khi gọi manifest
    if (pathname === '/manifest.json' || pathname === '/') {
        const query = parsedUrl.query;
        if (query.tsEnabled === 'true') {
            torrServerEnabled = true;
            torrServerAddress = query.tsAddress ? decodeURIComponent(query.tsAddress) : '';
            console.log('[Config] TorrServer enabled:', torrServerAddress);
        } else if (query.tsEnabled === 'false') {
            torrServerEnabled = false;
        }
    }

    // Route /configure
    if (pathname === '/configure') {
        const baseUrl = `http://${req.headers.host}`;
        const currentEnabled = torrServerEnabled;
        const currentAddress = torrServerAddress || 'http://192.168.1.10:8090';
        
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Cấu hình JAV Addon</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { font-family: Arial; background: #1a1a2e; color: #eee; padding: 20px; }
        .container { max-width: 500px; margin: 0 auto; background: #16213e; padding: 25px; border-radius: 12px; }
        h2 { color: #e94560; }
        label { display: block; margin: 15px 0 5px; }
        input { width: 100%; padding: 10px; border-radius: 6px; border: none; background: #0f3460; color: white; }
        input[type="checkbox"] { transform: scale(1.3); margin-right: 10px; width: auto; }
        button { background: #e94560; color: white; border: none; padding: 12px; border-radius: 6px; font-size: 16px; cursor: pointer; width: 100%; margin-bottom: 10px; }
        .url-box { background: #0a0a15; padding: 16px; border-radius: 8px; margin: 20px 0; word-break: break-all; font-family: monospace; color: #60a5fa; }
        .flex-row { display: flex; gap: 10px; }
        .btn-secondary { background: #2a2a4a; }
    </style>
</head>
<body>
    <div class="container">
        <h2>⚙️ Cấu hình TorrServer</h2>
        <form onsubmit="return false;">
            <label><input type="checkbox" id="ts" ${currentEnabled ? 'checked' : ''}> Bật TorrServer</label>
            <label>Địa chỉ:</label>
            <input type="url" id="addr" value="${currentAddress}" placeholder="http://192.168.1.10:8090">
            <button type="button" onclick="gen()" style="background:#0f3460">🔄 Tạo link cài đặt</button>
            <div class="url-box" id="url" style="display:none"></div>
            <div class="flex-row">
                <button class="btn-secondary" onclick="copy()">📋 Copy</button>
                <button onclick="install()">💾 Cài đặt</button>
            </div>
        </form>
    </div>
    <script>
        const base = '${baseUrl}/manifest.json';
        let u = '';
        function gen() {
            const enabled = ts.checked;
            const address = addr.value.trim();
            const params = new URLSearchParams();
            if (enabled) {
                params.set('tsEnabled', 'true');
                params.set('tsAddress', encodeURIComponent(address));
            } else {
                params.set('tsEnabled', 'false');
            }
            u = base + '?' + params.toString();
            url.textContent = u;
            url.style.display = 'block';
        }
        function copy() {
            if (!u) gen();
            navigator.clipboard.writeText(u).then(() => alert('✅ Đã copy!'));
        }
        function install() {
            if (!u) gen();
            location.href = 'stremio://' + u.replace(/^https?:\\/\\//, '');
        }
        gen();
    </script>
</body>
</html>
        `);
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
    console.log(`✅ JAV Addon v4.2.0 chạy tại http://0.0.0.0:${PORT}`);
    console.log(`📋 Manifest: http://127.0.0.1:${PORT}/manifest.json`);
    console.log(`⚙️  Cấu hình: http://127.0.0.1:${PORT}/configure`);
});
