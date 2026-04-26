#!/bin/bash
# Fix các phần còn tiếng Việt
sed -i 's|📡 TorrServer|📡 TorrServer|' addon.js
sed -i 's|🌐 Địa chỉ TorrServer|🌐 TorrServer Address|' addon.js
sed -i 's|Multi-source streaming|Multi-source|g' addon.js
sed -i 's|Multi-source with smart filtering|⚖️ Smart filtering · No 0 seed|' addon.js
sed -i 's|Nhiều Tags|🏷️ Tags|' addon.js
sed -i 's|Đa nguồn|🧲 Sources|' addon.js
sed -i 's|Tim kiếm|🔍 Search|' addon.js
sed -i 's|⚡ OneJAV + Sukebei + iJavTorrent · Cân bằng|⚡ Multi-source JAV streaming addon|' addon.js
sed -i 's|Cấu hình|Configure|g' addon.js
