const fs = require('fs');

console.log('🔄 Đang cập nhật addon.js...');

// Đọc file addon.js
let addon = fs.readFileSync('addon.js', 'utf8');

// ========== 1. Thay hàm getTorrServerFiles (bỏ retry, chỉ lấy file ngay) ==========
const oldGetFiles = /async function getTorrServerFiles\(tsUrl, magnet, title\) \{[\s\S]*?^}$/m;
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
        
        // Chỉ lấy file ngay lập tức, không retry
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

// ========== 2. Sửa addStream: bỏ qua magnet không có file ngay (trừ OneJAV Torrent) ==========
const oldAddStream = /const addStream = async \(sourceName, title, magnetLink, seeders = 0, isTorrentFile = false\) => \{[\s\S]*?^        }$/m;
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
                
                // Nếu không có file ngay và KHÔNG phải OneJAV Torrent -> bỏ qua
                if (!isTorrentFile) {
                    console.log(\`[Stream] ⏭️ Skip (no immediate files): \${title.substring(0, 40)}\`);
                    return;
                }
                
                // Fallback cho OneJAV Torrent
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

// Thực hiện thay thế
addon = addon.replace(oldGetFiles, newGetFiles);
addon = addon.replace(oldAddStream, newAddStream);

// Ghi file
fs.writeFileSync('addon.js', addon);

console.log('✅ addon.js đã được cập nhật!');
console.log('📌 Thay đổi:');
console.log('   - Bỏ retry, chỉ lấy file có ngay');
console.log('   - Bỏ qua magnet không có file ngay (trừ OneJAV Torrent)');
console.log('   - OneJAV Torrent vẫn dùng fallback index=0');
console.log('\n🚀 Chạy lại addon: node addon.js');
