#!/bin/bash
sed -i 's/let torrServerAddress = .*/let torrServerAddress = "";/' addon.js
sed -i '/let formAddress = torrServerAddress;/c\        let formAddress = "";' addon.js
sed -i "/query.has('tsEnabled')/i\        if (!query.has('tsEnabled') \&\& !query.has('tsAddress')) {\n            formEnabled = false;\n            formAddress = '';\n        }" addon.js
sed -i 's|<title>🌸 JAV Addon · Cấu hình</title>|<title>🌸 JAV Addon · Configure</title>|' addon.js
sed -i 's|Cân bằng|Multi-source streaming|g' addon.js
sed -i 's|Retry 2 lần · Fallback cho mọi magnet · Bỏ qua 0 seed (trừ OneJAV Torrent)|Multi-source: OneJAV + Sukebei + iJavTorrent|' addon.js
sed -i 's|Retry 2 lần, không bỏ magnet|Multi-source with smart filtering|' addon.js
sed -i 's|Tìm trực tiếp trên OneJAV.|Search across OneJAV database.|' addon.js
sed -i 's|Big Tits, Creampie, Anal...|20+ curated categories.|' addon.js
sed -i 's|iJavTorrent, Sukebei, OneJAV.|Torrents + magnets from 3 sources.|' addon.js
sed -i 's|🌟 Diễn viên nổi bật|🌟 Featured Actresses|' addon.js
sed -i 's|Phát torrent qua HTTP streaming|Stream torrents via HTTP|' addon.js
sed -i 's|Tạo link cài đặt|Generate Install Link|' addon.js
sed -i 's|Cài vào Stremio|Install in Stremio|' addon.js
sed -i 's|🌸 Retry 2 lần · Fallback cho mọi magnet · Bỏ qua 0 seed (trừ OneJAV Torrent)|🌸 Multi-source streaming from OneJAV, Sukebei & iJavTorrent|' addon.js
sed -i 's/alert(.✅ Đã copy link!.)/alert("✅ Link copied!")/' addon.js
sed -i 's/prompt(.📋 Copy thủ công:., currentUrl)/prompt("📋 Copy manually:", currentUrl)/' addon.js
