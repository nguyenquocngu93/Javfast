const fs = require('fs');

let addon = fs.readFileSync('addon.js', 'utf8');

// Hàm getTorrServerFiles mới (đã escape đúng)
const newGetFiles = `async function getTorrServerFiles(tsUrl, magnet, title) {
    try {
        console.log(\`[TorrServer] Adding: \${title.substring(0, 40)}...\`);
        
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
        
        console.log(\`[TorrServer] Hash: \${data.hash.substring(0, 8)}\`);
        
        if (data.file_stats && data.file_stats.length > 0) {
            console.log(\`[TorrServer] Got \${data.file_stats.length} files immediately\`);
            return { hash: data.hash, files: data.file_stats };
        }
        
        console.log('[TorrServer] No files immediately, skipping');
        return { hash: data.hash, files: [] };
    } catch (e) {
        console.error('[TorrServer] Error:', e.message);
        return null;
    }
}`;

// Regex tìm chính xác hàm cũ
const oldGetRegex = /async function getTorrServerFiles\([^{]*\)\s*\{[\s\S]*?\n\}/;

// Hàm addStream mới
const newAddStream = `const addStream = async (sourceName, title, magnetLink, seeders = 0, isTorrentFile = false) => {
        if (!magnetLink) return;
        
        if (seeders === 0 && !isTorrentFile) {
            console.log(\`[Stream] ⏭️ Skip 0 seed: \${title.substring(0, 40)}\`);
            return;
        }
        
        if (torrServerEnabled && torrServerAddress) {
            const tsBase = torrServerAddress.replace(/\\/$/, '');
            
            try {
                const result = await getCachedFiles(tsBase, magnetLink, title);
                
                if (result && result.files && result.files.length > 0) {
                    const videoFile = findMovieFile(result.files);
                    
                    if (videoFile) {
                        const streamUrl = \`\${tsBase}/stream/\${encodeURIComponent(title)}?link=\${result.hash}&index=\${videoFile._realIndex}&play\`;
                        streams.push({
                            name: \`🎌 \${sourceName}\`,
                            title: \`\${title}\\n📁 \${videoFile.path.split('/').pop()}\\n💾 \${((videoFile.length || 0) / (1024*1024*1024)).toFixed(2)} GB\`,
                            url: streamUrl,
                            behaviorHints: { notWebReady: true }
                        });
                        console.log(\`[Stream] ✅ \${sourceName}\`);
                        return;
                    }
                }
                
                if (!isTorrentFile) {
                    console.log(\`[Stream] ⏭️ Skip (no immediate files): \${title.substring(0, 40)}\`);
                    return;
                }
                
                console.log(\`[Stream] ⚠️ Fallback for OneJAV Torrent: \${title.substring(0, 40)}\`);
                const streamUrl = \`\${tsBase}/stream/\${encodeURIComponent(title)}?link=\${encodeURIComponent(magnetLink)}&index=0&play\`;
                streams.push({
                    name: \`🎌 \${sourceName}\`,
                    title: title,
                    url: streamUrl,
                    behaviorHints: { notWebReady: true }
                });
            } catch (e) {
                console.error(\`[Stream] ❌ \${sourceName}:\`, e.message);
                if (isTorrentFile) {
                    streams.push({
                        name: \`🎌 \${sourceName} (Direct)\`,
                        title: title,
                        externalUrl: magnetLink
                    });
                }
            }
        } else {
            streams.push({
                name: \`🎌 \${sourceName}\`,
                title: title,
                externalUrl: magnetLink
            });
        }
    }`;

// Regex tìm addStream cũ
const oldAddRegex = /const addStream = async \([^)]*\)\s*=>\s*\{[\s\S]*?\n        \}/;

// Thay thế
addon = addon.replace(oldGetRegex, newGetFiles);
addon = addon.replace(oldAddRegex, newAddStream);

fs.writeFileSync('addon.js', addon);
console.log('✅ addon.js đã sửa lỗi và cập nhật thành công.');
