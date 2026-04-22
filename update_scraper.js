const fs = require('fs');
const scraper = fs.readFileSync('scraper.js', 'utf8');

const newFunction = `// ===================== IJAVTORRENT =====================
async function searchIjavTorrent(code) {
    try {
        const searchQueries = generateSearchQueries(code);
        const normalizedCode = code.toLowerCase().replace(/-/g, '');
        
        for (const query of searchQueries) {
            const url = \`https://ijavtorrent.com/?searchTerm=\${encodeURIComponent(query)}\`;
            console.log(\`[iJavTorrent] Search: \${url}\`);
            
            const html = await fetchWithRetry(url, 2, 1000);
            if (!html) continue;
            
            const $ = cheerio.load(html);
            let targetCard = null;
            
            $('.video-item').each((i, card) => {
                const $card = $(card);
                const linkEl = $card.find('.name a[href^="/movie/"]').first();
                if (!linkEl.length) return;
                
                const href = linkEl.attr('href');
                const match = href.match(/\\/movie\\/([a-z0-9]+-\\d+)/i);
                if (!match) return;
                
                const cardId = match[1].toLowerCase().replace(/-/g, '');
                if (cardId === normalizedCode) {
                    targetCard = $card;
                    console.log(\`[iJavTorrent] ✅ Found exact card for \${code}\`);
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
                    try { title = decodeURIComponent(magnetName[1]).replace(/\\+/g, ' '); }
                    catch(e) { title = magnetName[1].replace(/\\+/g, ' '); }
                }
                if (!title) title = targetCard.find('.name a').first().text().trim();
                
                const hashMatch = magnetLink.match(/btih:([a-fA-F0-9]{40})/i);
                
                if (!magnets.find(m => m.url === magnetLink)) {
                    magnets.push({
                        title: title.substring(0, 150), url: magnetLink,
                        infoHash: hashMatch ? hashMatch[1].toLowerCase() : null,
                        seeders, leechers, sizeGB, source: 'iJavTorrent'
                    });
                    console.log(\`[iJavTorrent]   ↳ \${sizeGB.toFixed(1)}GB, S:\${seeders}\`);
                }
            });
            
            if (magnets.length > 0) {
                magnets.sort((a, b) => b.seeders - a.seeders);
                const limited = magnets.slice(0, 5);
                console.log(\`[iJavTorrent] Total \${magnets.length} magnets, returning \${limited.length}\`);
                return { magnets: limited };
            }
        }
        
        console.log(\`[iJavTorrent] No magnets found for \${code}\`);
        return { magnets: [] };
        
    } catch (e) {
        console.error('[iJavTorrent] Error:', e.message);
        return { magnets: [] };
    }
}`;

const startIdx = scraper.indexOf('// ===================== IJAVTORRENT');
const endIdx = scraper.indexOf('module.exports', startIdx);

if (startIdx > -1 && endIdx > -1) {
    const newScraper = scraper.slice(0, startIdx) + newFunction + '\n\n' + scraper.slice(endIdx);
    fs.writeFileSync('scraper.js', newScraper);
    console.log('✅ Updated! Exact match using /movie/ID pattern, limit 5 magnets.');
} else {
    console.log('❌ Could not find function');
}
