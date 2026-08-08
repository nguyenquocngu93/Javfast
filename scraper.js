const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://onejav.com';
const JAVTIFUL_BASE_URL = 'https://javtiful.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// Cache tạm thông tin torrent để stream handler dùng
const videoCache = new Map();
const javtifulCache = new Map();
const JAVTIFUL_CACHE_TTL = 30 * 60 * 1000;

function normalizeCode(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function absoluteUrl(url, base) {
    if (!url) return '';
    try { return new URL(url, base).href; } catch { return ''; }
}

// ===================== FETCH CÓ RETRY =====================
async function fetchWithRetry(url, retries = 2, delay = 500, extraHeaders = {}) {
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await axios.get(url, {
                headers: { 'User-Agent': USER_AGENT, ...extraHeaders },
                timeout: 15000
            });
            return res.data;
        } catch (e) {
            console.error(`[Fetch] Attempt ${i+1}/${retries+1} failed for ${url}: ${e.message}`);
            if (i === retries) return null;
            await new Promise(r => setTimeout(r, delay * (i + 1)));
        }
    }
    return null;
}

// ===================== TẠO BIẾN THỂ TÌM KIẾM =====================
function generateSearchQueries(code) {
    const queries = [code];
    const upper = code.toUpperCase();
    const lower = code.toLowerCase();
    
    // Nếu có dấu gạch ngang
    if (code.includes('-')) {
        const parts = code.split('-');
        queries.push(parts.join(''));
        queries.push(parts.join(' '));
        queries.push(parts.join(' - '));
    } else {
        // Nếu không có gạch ngang, thử thêm gạch ngang vào giữa chữ và số
        const match = code.match(/^([A-Za-z]+)(\d+)$/);
        if (match) {
            queries.push(`${match[1]}-${match[2]}`);
            queries.push(`${match[1]} ${match[2]}`);
        }
    }
    
    // Thêm biến thể FC2
    if (upper.startsWith('FC2') || upper.includes('FC2PPV')) {
        const num = code.replace(/fc2ppv/i, '').replace(/-/g, '');
        queries.push(`FC2-PPV-${num}`);
        queries.push(`FC2 PPV ${num}`);
        queries.push(`fc2ppv${num}`);
    }
    
    queries.push(upper, lower);
    return [...new Set(queries)];
}

// ===================== PARSE SIZE HELPER =====================
function parseSize(text) {
    if (!text) return 0;
    const match = text.match(/([\d.]+)\s*(gb|mb)/i);
    if (!match) return 0;
    let size = parseFloat(match[1]);
    if (match[2].toLowerCase() === 'mb') size /= 1024;
    return size;
}

// ===================== ONEJAV SCRAPE (TRANG CHỦ & TAG) =====================
async function fetchOneJavPage(url) {
    console.log('[OneJAV] Fetching: ' + url);
    const html = await fetchWithRetry(url);
    if (!html) return { results: [], hasMore: false };
    
    const $ = cheerio.load(html);
    const results = [];
    
    $('div.container').each(function(i, container) {
        const $container = $(container);
        if ($container.text().includes('Popular tags')) return;
        
        const link = $container.find('a[href^="/torrent/"]').first().attr('href');
        if (!link) return;
        
        const posterEl = $container.find('img.image').first();
        if (posterEl.length === 0) return;
        
        const code = link.split('/').pop();
        const title = $container.find('.title a, h5 a').first().text().trim() || code;
        let poster = posterEl.attr('src') || '';
        if (poster && poster.startsWith('//')) poster = 'https:' + poster;
        if (poster && !poster.startsWith('http')) poster = BASE_URL + poster;
        
        if (title) {
            results.push({
                id: 'onejav_' + code,
                title: title,
                poster: poster,
                detailUrl: link,
                info: ''
            });
        }
    });
    
    // Fallback selector
    if (results.length === 0) {
        $('a.thumbnail-link').each(function(i, el) {
            const $el = $(el);
            const detailUrl = $el.attr('href');
            const poster = $el.find('img').first().attr('src') || '';
            const title = $el.find('.thumbnail-text p').first().text().trim() || $el.find('.thumbnail-text').text().trim();
            if (title && detailUrl) {
                const id = 'onejav_' + detailUrl.split('/').pop();
                results.push({ id: id, title: title, poster: poster, detailUrl: detailUrl, info: '' });
            }
        });
    }
    
    const hasMore = $('a.pagination-next').length > 0;
    console.log('[OneJAV] Found ' + results.length + ' movies, hasMore: ' + hasMore);
    return { results, hasMore };
}

// ===================== SEARCH ONEJAV =====================
async function searchOneJav(query) {
    const cleanQuery = query.split('?')[0];
    const searchUrl = `${BASE_URL}/search/${encodeURIComponent(cleanQuery)}`;
    console.log('[Search] Fetching: ' + searchUrl);
    const html = await fetchWithRetry(searchUrl);
    if (!html) return [];
    
    const $ = cheerio.load(html);
    const results = [];
    
    $('.card.mb-3').each((i, card) => {
        const $card = $(card);
        const linkEl = $card.find('h5.title.is-4 a').first();
        const detailUrl = linkEl.attr('href');
        if (!detailUrl) return;
        
        const videoId = detailUrl.split('/').pop();
        const fullTitle = $card.find('h5.title.is-4').text().replace(videoId, '').trim();
        const title = fullTitle || videoId;
        
        let poster = $card.find('img.image').attr('src') || '';
        if (poster && poster.startsWith('//')) poster = 'https:' + poster;
        if (poster && !poster.startsWith('http')) poster = BASE_URL + poster;
        
        results.push({
            id: 'onejav_' + videoId,
            title: `${videoId} ${title}`,
            poster: poster,
            detailUrl: detailUrl,
            info: ''
        });
    });
    
    // Fallback
    if (results.length === 0) {
        $('div.container').each((i, container) => {
            const $container = $(container);
            if ($container.text().includes('Popular tags')) return;
            const link = $container.find('a[href^="/torrent/"]').first().attr('href');
            if (!link) return;
            const posterEl = $container.find('img.image').first();
            if (posterEl.length === 0) return;
            const code = link.split('/').pop();
            const title = $container.find('.title a, h5 a').first().text().trim() || code;
            let poster = posterEl.attr('src') || '';
            if (poster && poster.startsWith('//')) poster = 'https:' + poster;
            if (poster && !poster.startsWith('http')) poster = BASE_URL + poster;
            if (title) {
                results.push({
                    id: 'onejav_' + code,
                    title: title,
                    poster: poster,
                    detailUrl: link,
                    info: ''
                });
            }
        });
    }
    
    console.log('[Search] Found ' + results.length + ' results for "' + query + '"');
    return results;
}

async function fetchTagPage(tag, page = 1) {
    const encodedTag = tag.replace(/ /g, '%20');
    const url = page === 1 ? `${BASE_URL}/tag/${encodedTag}` : `${BASE_URL}/tag/${encodedTag}?page=${page}`;
    console.log('[Tag] Fetching: ' + url);
    return await fetchOneJavPage(url);
}

// ===================== GET DETAIL =====================
async function getOneJavDetail(detailUrl) {
    const fullUrl = detailUrl.startsWith('http') ? detailUrl : BASE_URL + detailUrl;
    console.log('[OneJAV] Detail: ' + fullUrl);
    const html = await fetchWithRetry(fullUrl);
    if (!html) return null;
    
    const $ = cheerio.load(html);
    let poster = $('meta[property="og:image"]').attr('content') || $('img.card-img-bottom').attr('src') || '';
    const magnets = [];
    const magnetRegex = /(magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^"'\s<>]*)/gi;
    const matches = html.match(magnetRegex);
    if (matches) {
        [...new Set(matches)].forEach(function(url) {
            const hashMatch = url.match(/btih:([a-zA-Z0-9]+)/i);
            magnets.push({ title: 'OneJAV', url: url, infoHash: hashMatch ? hashMatch[1] : null });
        });
    }
    
    const torrentLinks = [];
    $('a[href*="/download/"]').each(function(i, el) {
        const href = $(el).attr('href');
        if (href) torrentLinks.push({ title: 'Torrent', url: href.startsWith('http') ? href : BASE_URL + href });
    });
    
    if (torrentLinks.length === 0) {
        $('a[href$=".torrent"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href) torrentLinks.push({ title: 'Torrent', url: href.startsWith('http') ? href : BASE_URL + href });
        });
    }
    
    if (torrentLinks.length === 0) {
        $('a[href*="download"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href && href.includes('.torrent')) {
                torrentLinks.push({ title: 'Torrent', url: href.startsWith('http') ? href : BASE_URL + href });
            }
        });
    }
    
    const actress = [];
    $('a[href*="/actress/"]').each(function(i, el) { actress.push($(el).text().trim()); });
    const description = $('meta[property="og:description"]').attr('content') || '';
    
    const detailData = { poster, actress, description, torrentLinks, magnets };
    
    const videoId = detailUrl.split('/').pop();
    videoCache.set('onejav_' + videoId, {
        detail: detailData,
        torrentLinks,
        magnets
    });
    
    return detailData;
}

// ===================== JAVTIFUL DIRECT MP4 =====================
function extractJavtifulVideo(html, pageUrl, fallbackTitle = '') {
    const $ = cheerio.load(html);
    const title = $('h1').first().text().trim() ||
        $('meta[property="og:title"]').attr('content') || fallbackTitle;
    const poster = absoluteUrl(
        $('meta[property="og:image"]').attr('content') ||
        $('video[poster]').attr('poster'),
        JAVTIFUL_BASE_URL
    );
    const candidates = [];

    $('video source').each((i, el) => {
        const src = $(el).attr('src');
        const type = ($(el).attr('type') || '').toLowerCase();
        const quality = parseInt($(el).attr('size'), 10) || 0;
        if (src && (type === 'video/mp4' || /\.mp4(?:$|[?#])/i.test(src))) {
            candidates.push({
                url: absoluteUrl(src, pageUrl),
                quality
            });
        }
    });

    // Javtiful also exposes player data in inline scripts.
    const scriptText = $('script').map((i, el) => $(el).html() || '').get().join('\n');
    const sourceRegex =
        /["'](?:src|url)["']\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/gi;
    let match;
    while ((match = sourceRegex.exec(scriptText))) {
        candidates.push({
            url: match[1].replace(/\\u0026/g, '&'),
            quality: 0
        });
    }

    const rawMp4Regex = /https?:\/\/[^\s"'<>]+\.mp4(?:\?[^\s"'<>]+)?/gi;
    while ((match = rawMp4Regex.exec(html))) {
        candidates.push({
            url: match[0].replace(/&amp;/g, '&'),
            quality: 0
        });
    }

    const unique = [...new Map(
        candidates.filter(x => x.url).map(x => [x.url, x])
    ).values()];
    unique.sort((a, b) => (b.quality || 0) - (a.quality || 0));

    const selected = unique[0];
    if (!selected) return null;

    return {
        title,
        poster,
        url: selected.url,
        quality: selected.quality || null,
        pageUrl
    };
}

function generateJavtifulQueries(code) {
    const raw = String(code || '').split('?')[0].trim();
    if (!raw) return [];

    const out = new Set();
    const add = v => {
        if (!v) return;
        const q = String(v).trim();
        if (q) out.add(q);
    };

    const lower = raw.toLowerCase();
    const upper = raw.toUpperCase();
    const compact = lower.replace(/[^a-z0-9]/g, '');

    // Original spelling/case first.
    add(raw);
    add(lower);
    add(upper);

    // Existing separators normalized in common ways.
    add(lower.replace(/[\s_]+/g, '-'));
    add(lower.replace(/[-_]+/g, ' '));
    add(lower.replace(/[\s_-]+/g, ''));

    // General "letters + digits" forms:
    // siro5700 -> siro-5700 / siro 5700
    // fc2ppv4955543 -> fc2ppv-4955543 / fc2ppv 4955543
    const alphaNum = compact.match(/^([a-z]+)(\d+)$/);
    if (alphaNum) {
        const [, letters, digits] = alphaNum;
        add(`${letters}${digits}`);
        add(`${letters}-${digits}`);
        add(`${letters} ${digits}`);
        add(`${letters}_${digits}`);
        add(`${letters.toUpperCase()}-${digits}`);
        add(`${letters.toUpperCase()} ${digits}`);
    }

    // Known JAV catalog patterns. These cover common FC2/PPV and
    // studio-code layouts without assuming one exact site convention.
    const fc2 = compact.match(/^fc2(?:ppv)?(\d+)$/i);
    if (fc2) {
        const digits = fc2[1];
        const forms = [
            `fc2ppv${digits}`,
            `fc2ppv-${digits}`,
            `fc2ppv ${digits}`,
            `fc2-ppv-${digits}`,
            `fc2-ppv ${digits}`,
            `fc2 ppv ${digits}`,
            `fc2_ppv_${digits}`,
            `FC2PPV${digits}`,
            `FC2PPV-${digits}`,
            `FC2-PPV-${digits}`,
            `FC2 PPV ${digits}`
        ];
        forms.forEach(add);
    }

    // If the original code has multiple alphanumeric chunks, add
    // progressively separated forms:
    // ABC123XYZ456 -> ABC-123-XYZ-456, etc.
    const tokens = compact.match(/[a-z]+|\d+/gi);
    if (tokens && tokens.length > 1) {
        add(tokens.join(''));
        add(tokens.join('-'));
        add(tokens.join(' '));
        add(tokens.map((x, i) => i === 0 ? x : x).join('_'));
        add(tokens.map(x => x.toUpperCase()).join('-'));
        add(tokens.map(x => x.toUpperCase()).join(' '));
    }

    // Also try the project's existing search-query generator when
    // available; this keeps Javtiful in sync with other providers.
    try {
        if (typeof generateSearchQueries === 'function') {
            for (const q of generateSearchQueries(raw)) add(q);
        }
    } catch (_) {}

    return [...out];
}

function javtifulScore(slug, text, normalized) {
    const slugNorm = normalizeCode(slug);
    const hayNorm = normalizeCode(`${slug} ${text}`);

    if (slugNorm === normalized) return 1000;
    if (hayNorm === normalized) return 900;
    if (slugNorm.includes(normalized)) return 700;
    if (hayNorm.includes(normalized)) return 600;

    // Token-aware comparison prevents "fc2ppv4955543" from being
    // confused with a nearby number while still accepting separators.
    const targetParts = normalized.match(/[a-z]+|\d+/g) || [];
    const slugParts = slugNorm.match(/[a-z]+|\d+/g) || [];
    if (targetParts.length && targetParts.join('') === slugParts.join('')) return 850;

    return 0;
}

async function searchJavtiful(code) {
    const cleanCode = String(code || '').split('?')[0].trim();
    const normalized = normalizeCode(cleanCode);
    if (!normalized) return null;

    const cached = javtifulCache.get(normalized);
    if (cached && Date.now() - cached.timestamp < JAVTIFUL_CACHE_TTL) {
        return cached.data;
    }

    try {
        const queries = generateJavtifulQueries(cleanCode);
        console.log(`[Javtiful] Queries: ${queries.join(' | ')}`);

        const candidates = new Map();

        for (const query of queries) {
            const searchUrl =
                `${JAVTIFUL_BASE_URL}/search?q=${encodeURIComponent(query)}`;
            console.log(`[Javtiful] Search: ${searchUrl}`);

            const html = await fetchWithRetry(searchUrl, 2, 700, {
                'Accept-Language': 'en-US,en;q=0.9'
            });
            if (!html) continue;

            const $ = cheerio.load(html);

            $('a[href*="/video/"]').each((i, el) => {
                const href = $(el).attr('href');
                if (!href) return;

                const url = absoluteUrl(href, JAVTIFUL_BASE_URL);
                let parsed;
                try { parsed = new URL(url); } catch { return; }

                const parts = parsed.pathname.split('/').filter(Boolean);
                const videoIndex = parts.findIndex(
                    x => x.toLowerCase() === 'video'
                );
                const slug = videoIndex >= 0
                    ? parts[videoIndex + 2] || parts[parts.length - 1] || ''
                    : parts[parts.length - 1] || '';

                const text =
                    $(el).text().trim() ||
                    $(el).find('img').attr('alt') ||
                    $('meta[property="og:title"]').attr('content') ||
                    '';

                const score = javtifulScore(slug, text, normalized);
                if (score <= 0) return;

                const previous = candidates.get(url);
                if (!previous || score > previous.score) {
                    candidates.set(url, { url, slug, text, score, query });
                }
            });
        }

        const sorted = [...candidates.values()]
            .sort((a, b) => b.score - a.score);

        for (const candidate of sorted) {
            const detailHtml = await fetchWithRetry(
                candidate.url,
                2,
                700,
                {
                    'Accept-Language': 'en-US,en;q=0.9',
                    Referer: JAVTIFUL_BASE_URL + '/'
                }
            );
            if (!detailHtml) continue;

            const stream = extractJavtifulVideo(
                detailHtml,
                candidate.url,
                cleanCode
            );
            if (!stream) continue;

            const result = {
                ...stream,
                source: 'Javtiful'
            };

            javtifulCache.set(normalized, {
                timestamp: Date.now(),
                data: result
            });

            console.log(
                `[Javtiful] Found ${cleanCode} via "${candidate.query}" -> ` +
                `${candidate.url} -> ${result.quality || 'unknown'}p`
            );
            return result;
        }
    } catch (e) {
        console.error('[Javtiful] Error:', e.message);
    }

    javtifulCache.set(normalized, {
        timestamp: Date.now(),
        data: null
    });
    return null;
}

// ===================== SUKEBEI =====================
async function searchSukebei(code) {
    try {
        const uniqueQueries = generateSearchQueries(code);
        let allMagnets = [];
        
        for (const query of uniqueQueries) {
            const url = 'https://sukebei.nyaa.si/?q=' + encodeURIComponent(query) + '&f=0&c=0_0';
            console.log('[Sukebei] Search: ' + url);
            const html = await fetchWithRetry(url, 1);
            if (!html || html.includes('No results found')) continue;
            const $ = cheerio.load(html);
            let found = false;
            $('tbody tr').each(function(i, row) {
                const magnetLink = $(row).find('a[href^="magnet:"]').attr('href');
                if (magnetLink) {
                    const title = $(row).find('td:nth-child(2) a').last().text().trim();
                    const seeders = parseInt($(row).find('td:nth-child(6)').text().trim()) || 0;
                    const leechers = parseInt($(row).find('td:nth-child(7)').text().trim()) || 0;
                    const hashMatch = magnetLink.match(/btih:([a-zA-Z0-9]+)/i);
                    allMagnets.push({
                        title: title,
                        url: magnetLink,
                        infoHash: hashMatch ? hashMatch[1] : null,
                        seeders: seeders,
                        leechers: leechers,
                        source: 'Sukebei'
                    });
                    found = true;
                }
            });
            if (found) break;
        }
        console.log('[Sukebei] Found ' + allMagnets.length + ' magnets');
        return { magnets: allMagnets };
    } catch (e) {
        console.error('[Sukebei] Error: ' + e.message);
        return { magnets: [] };
    }
}

// ===================== IJAVTORRENT =====================
async function searchIjavTorrent(code) {
    try {
        const searchQueries = generateSearchQueries(code);
        const normalizedCode = code.toLowerCase().replace(/-/g, '');
        
        for (const query of searchQueries) {
            const url = `https://ijavtorrent.com/?searchTerm=${encodeURIComponent(query)}`;
            console.log(`[iJavTorrent] Search: ${url}`);
            
            const html = await fetchWithRetry(url, 2, 1000);
            if (!html) continue;
            
            const $ = cheerio.load(html);
            let targetCard = null;
            
            $('.video-item').each((i, card) => {
                const $card = $(card);
                const linkEl = $card.find('.name a[href^="/movie/"]').first();
                if (!linkEl.length) return;
                
                const href = linkEl.attr('href');
                const match = href.match(/\/movie\/([a-z0-9]+-\d+)/i);
                if (!match) return;
                
                const cardId = match[1].toLowerCase().replace(/-/g, '');
                if (cardId === normalizedCode) {
                    targetCard = $card;
                    console.log(`[iJavTorrent] ✅ Found exact card for ${code}`);
                    return false;
                }
            });
            
            if (!targetCard) continue;
            
            const magnets = [];
            
            targetCard.find('a[href^="magnet:"]').each((j, el) => {
                const magnetLink = $(el).attr('href');
                if (!magnetLink) return;
                
                const $row = $(el).closest('tr');
                
                let sizeGB = 0;
                const sizeCol = $row.find('td').eq(1);
                if (sizeCol.length) sizeGB = parseSize(sizeCol.text().trim());
                
                let seeders = 0, leechers = 0;
                const seedCol = $row.find('td').eq(2);
                if (seedCol.length) seeders = parseInt(seedCol.text().replace('S:', '').trim()) || 0;
                const leechCol = $row.find('td').eq(3);
                if (leechCol.length) leechers = parseInt(leechCol.text().replace('L:', '').trim()) || 0;
                
                let title = '';
                const magnetName = magnetLink.match(/dn=([^&]+)/i);
                if (magnetName) {
                    try { title = decodeURIComponent(magnetName[1]).replace(/\+/g, ' '); }
                    catch(e) { title = magnetName[1].replace(/\+/g, ' '); }
                }
                if (!title) title = targetCard.find('.name a').first().text().trim();
                
                const hashMatch = magnetLink.match(/btih:([a-fA-F0-9]{40})/i);
                
                if (!magnets.find(m => m.url === magnetLink)) {
                    magnets.push({
                        title: title.substring(0, 150), url: magnetLink,
                        infoHash: hashMatch ? hashMatch[1].toLowerCase() : null,
                        seeders, leechers, sizeGB, source: 'iJavTorrent'
                    });
                    console.log(`[iJavTorrent]   ↳ ${sizeGB.toFixed(1)}GB, S:${seeders}`);
                }
            });
            
            if (magnets.length > 0) {
                magnets.sort((a, b) => b.seeders - a.seeders);
                const limited = magnets.slice(0, 5);
                console.log(`[iJavTorrent] Total ${magnets.length} magnets, returning ${limited.length}`);
                return { magnets: limited };
            }
        }
        
        console.log(`[iJavTorrent] No magnets found for ${code}`);
        return { magnets: [] };
        
    } catch (e) {
        console.error('[iJavTorrent] Error:', e.message);
        return { magnets: [] };
    }
}

module.exports = {
    fetchOneJavPage,
    fetchTagPage,
    searchOneJav,
    getOneJavDetail,
    searchSukebei,
    searchIjavTorrent,  // Thay thế searchKnaben
    searchJavtiful,
    videoCache,
    javtifulCache,
    BASE_URL,
    JAVTIFUL_BASE_URL
};
