var http = require('http');
var fetch = require('node-fetch');
var cheerio = require('cheerio');
var fs = require('fs');

// ===================== LANGUAGE =====================
var LANGS = {
  vi: require('./lang/vi'),
  en: require('./lang/en')
};
function getLang(cfg) {
  return LANGS[(cfg && cfg.uiLang) || 'vi'] || LANGS['vi'];
}

// ===================== PERSISTENT CACHE =====================
var CACHE_FILE = './tmdb_cache.json';
var TMDB_CACHE = {};
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      TMDB_CACHE = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      console.log('[Cache] Loaded', Object.keys(TMDB_CACHE).length, 'entries from disk');
    }
  } catch(e) {
    console.error('[Cache] Load error:', e.message);
    TMDB_CACHE = {};
  }
}
function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(TMDB_CACHE));
    console.log('[Cache] Saved', Object.keys(TMDB_CACHE).length, 'entries to disk');
  } catch(e) {
    console.error('[Cache] Save error:', e.message);
  }
}
loadCache();
setInterval(saveCache, 5 * 60 * 1000);
process.on('SIGINT', function() {
  console.log('\n[Cache] Saving before exit...');
  saveCache();
  process.exit(0);
});
process.on('SIGTERM', function() {
  saveCache();
  process.exit(0);
});

// ===================== CONSTANTS =====================
var JAC_RED_DOMAINS = {
  'jac.red':        'https://jac.red/api/v1.0/torrents',
  'jac-red.ru':     'https://jac-red.ru/api/v1.0/torrents',
  'jr.maxvol.pro':  'https://jr.maxvol.pro/api/v1.0/torrents',
  'ru.jacred.pro':  'https://ru.jacred.pro/api/v1.0/torrents',
  'jacred.stream':  'https://jacred.stream/api/v1.0/torrents'
};
var DEFAULT_JACRED_DOMAIN = 'jac.red';
var TMDB_API_KEY = '6979c8ec101ed849f44d197c86582644';
var PORT = 7000;
var KNABEN_BASE_URL = 'https://knaben.org/search/';

// ===================== JACRED DOMAIN STATUS =====================
// Theo dõi trạng thái từng domain: { url: { ok: bool, lastCheck: timestamp, latency: ms } }
var JACRED_DOMAIN_STATUS = {};
// Khởi tạo trạng thái mặc định
Object.keys(JAC_RED_DOMAINS).forEach(function(key) {
  JACRED_DOMAIN_STATUS[key] = { ok: null, lastCheck: 0, latency: null, errors: 0 };
});

// Kiểm tra 1 domain JacRed
function checkJacredDomain(domainKey) {
  var url = JAC_RED_DOMAINS[domainKey];
  if (!url) return Promise.resolve(false);
  var start = Date.now();
  return fetch(url + '?search=test', { timeout: 8000 })
    .then(function(r) {
      var latency = Date.now() - start;
      var ok = r.ok || r.status === 200;
      JACRED_DOMAIN_STATUS[domainKey] = {
        ok: ok,
        lastCheck: Date.now(),
        latency: latency,
        errors: ok ? 0 : (JACRED_DOMAIN_STATUS[domainKey].errors || 0) + 1
      };
      console.log('[JacRed Check]', domainKey, ok ? '✅' : '❌', latency + 'ms');
      return ok;
    })
    .catch(function(e) {
      var latency = Date.now() - start;
      JACRED_DOMAIN_STATUS[domainKey] = {
        ok: false,
        lastCheck: Date.now(),
        latency: latency,
        errors: (JACRED_DOMAIN_STATUS[domainKey].errors || 0) + 1
      };
      console.log('[JacRed Check]', domainKey, '❌ Error:', e.message);
      return false;
    });
}

// Kiểm tra tất cả domain
function checkAllJacredDomains() {
  console.log('[JacRed] Checking all domains...');
  return Promise.all(
    Object.keys(JAC_RED_DOMAINS).map(function(key) {
      return checkJacredDomain(key);
    })
  );
}

// Tự động kiểm tra mỗi 10 phút
checkAllJacredDomains();
setInterval(checkAllJacredDomains, 10 * 60 * 1000);

// Lấy domain hoạt động tốt nhất (latency thấp nhất, ưu tiên domain được chọn)
function getBestJacredDomain(preferredDomain) {
  var preferred = preferredDomain || DEFAULT_JACRED_DOMAIN;

  // Nếu domain ưa thích đang OK → dùng luôn
  var preferredStatus = JACRED_DOMAIN_STATUS[preferred];
  if (preferredStatus && preferredStatus.ok === true) {
    return preferred;
  }

  // Nếu domain ưa thích chưa kiểm tra (null) → dùng luôn (chưa biết)
  if (preferredStatus && preferredStatus.ok === null) {
    return preferred;
  }

  // Domain ưa thích lỗi → tìm domain tốt nhất còn lại
  var bestDomain = null;
  var bestLatency = Infinity;

  Object.keys(JAC_RED_DOMAINS).forEach(function(key) {
    if (key === preferred) return;
    var st = JACRED_DOMAIN_STATUS[key];
    if (st && st.ok === true) {
      var lat = st.latency || 9999;
      if (lat < bestLatency) {
        bestLatency = lat;
        bestDomain = key;
      }
    }
  });

  if (bestDomain) {
    console.log('[JacRed Fallback] Domain "' + preferred + '" lỗi → dùng "' + bestDomain + '"');
    return bestDomain;
  }

  // Không có domain nào tốt → trả về domain ưa thích (thử lại)
  console.log('[JacRed Fallback] Không tìm được domain hoạt động, thử lại với "' + preferred + '"');
  return preferred;
}

// Fetch JacRed với fallback tự động
function fetchJacredWithFallback(preferredDomain, queryParam) {
  var domainOrder = [];
  var best = getBestJacredDomain(preferredDomain);
  domainOrder.push(best);

  // Thêm các domain còn lại theo thứ tự latency
  var others = Object.keys(JAC_RED_DOMAINS)
    .filter(function(k) { return k !== best; })
    .sort(function(a, b) {
      var la = (JACRED_DOMAIN_STATUS[a] && JACRED_DOMAIN_STATUS[a].latency) || 9999;
      var lb = (JACRED_DOMAIN_STATUS[b] && JACRED_DOMAIN_STATUS[b].latency) || 9999;
      return la - lb;
    });
  domainOrder = domainOrder.concat(others);

  // Thử lần lượt
  function tryNext(idx) {
    if (idx >= domainOrder.length) {
      return Promise.resolve([]);
    }
    var domainKey = domainOrder[idx];
    var apiUrl = JAC_RED_DOMAINS[domainKey];
    var fullUrl = apiUrl + '?' + queryParam;
    var start = Date.now();

    console.log('[JacRed] Trying domain [' + (idx+1) + '/' + domainOrder.length + ']: ' + domainKey);

    return fetch(fullUrl, { timeout: 15000 })
      .then(function(r) {
        var latency = Date.now() - start;
        if (r.ok) {
          // Cập nhật status
          JACRED_DOMAIN_STATUS[domainKey] = {
            ok: true,
            lastCheck: Date.now(),
            latency: latency,
            errors: 0
          };
          return r.json();
        }
        throw new Error('HTTP ' + r.status);
      })
      .then(function(data) {
        if (Array.isArray(data)) return { data: data, usedDomain: domainKey };
        throw new Error('Invalid response');
      })
      .catch(function(e) {
        var latency = Date.now() - start;
        console.log('[JacRed] Domain "' + domainKey + '" failed:', e.message, '→ trying next...');
        // Đánh dấu domain lỗi
        JACRED_DOMAIN_STATUS[domainKey] = {
          ok: false,
          lastCheck: Date.now(),
          latency: latency,
          errors: (JACRED_DOMAIN_STATUS[domainKey].errors || 0) + 1
        };
        return tryNext(idx + 1);
      });
  }

  return tryNext(0).then(function(result) {
    if (result && result.data) return result;
    return { data: [], usedDomain: null };
  });
}

var DEFAULT_TORRENTIO_CONFIG = {
  providers: ['yts','eztv','rarbg','1337x','thepiratebay','kickasstorrents','torrentgalaxy',
    'magnetdl','horribles ubs','nyaasi','tokyotosho','anidex','nekobt','rutor','rutracker',
    'torrent9','ilcorsaronero','mejortorrent','wolfmax4k','cinecalidad','besttorrents'],
  sortBy: 'size',
  language: 'russian,ukrainian',
  qualityfilter: ['480p']
};

var DEFAULT_CONFIG = Object.assign({
  torrServerUrl: '',
  jacredEnabled: true,
  torrentioEnabled: true,
  knabenEnabled: true,
  maxResults: 30,
  jacredDomain: DEFAULT_JACRED_DOMAIN,
  jacredFallback: true,   // <-- MỚI: bật/tắt fallback domain
  animeMode: false,
  preferPack: true,
  commonSortBy: 'size',
  commonQualityFilter: [],
  sizeMinGB: 0,
  sizeMaxGB: 100,
  uiLang: 'vi'
}, DEFAULT_TORRENTIO_CONFIG);

// ===================== STATS =====================
var SERVER_STATS = {
  startTime: Date.now(),
  totalRequests: 0,
  streamRequests: 0,
  jacredRequests: 0,
  jacredFallbacks: 0,     // <-- MỚI: đếm số lần fallback
  jacredErrors: 0,        // <-- MỚI: đếm lỗi
  knabenRequests: 0,
  torrentioRequests: 0,
  cacheHits: 0,
};

// ===================== CONFIG =====================
function decodeConfig(str) {
  try {
    var cleanStr = str.replace(/^https?:\/\/[^\/]+\//, '')
      .replace(/\/manifest\.json$/, '')
      .replace(/\/configure$/, '');
    var configPart = cleanStr.split('/')[0];
    if (!configPart) return null;
    var b64 = configPart.replace(/-/g,'+').replace(/_/g,'/');
    while (b64.length % 4) b64 += '=';
    var decoded = JSON.parse(Buffer.from(b64,'base64').toString('utf8'));
    return Object.assign({}, DEFAULT_CONFIG, decoded);
  } catch(e) { return null; }
}

var KEYWORDS = ['manifest.json','stream','configure','api','play','test-ts','status'];

function parseUrl(reqUrl, host) {
  try {
    var url = new URL(reqUrl, 'http://' + host);
    var pathname = url.pathname;
    var parts = pathname.split('/').filter(Boolean);
    if (parts.length > 0 && KEYWORDS.indexOf(parts[0]) === -1) {
      var cfg = decodeConfig(parts[0]);
      if (cfg) return { userConfig: cfg, configStr: parts[0], rest: '/' + parts.slice(1).join('/') };
    }
    return { userConfig: null, configStr: null, rest: pathname };
  } catch (e) {
    return { userConfig: null, configStr: null, rest: reqUrl };
  }
}

function parseQuery(reqUrl, host) {
  try {
    var url = new URL(reqUrl, 'http://' + host);
    return Object.fromEntries(url.searchParams.entries());
  } catch (e) { return {}; }
}

function decodeUnicode(str) {
  try {
    return str.replace(/\\u[\dA-F]{4}/gi, function(m) {
      return String.fromCharCode(parseInt(m.replace(/\\u/,''), 16));
    });
  } catch(e) { return str; }
}

function parseSize(sn) {
  if (!sn) return 0;
  var s = parseFloat(sn) || 0;
  var up = String(sn).toUpperCase();
  if (up.includes('GB') || up.includes('ГБ')) return s;
  if (up.includes('MB') || up.includes('МБ')) return s / 1024;
  if (s > 100) return s / 1024;
  return s;
}

function getPublicUrlFromReq(req) {
  var host = req.headers['x-forwarded-host'] || req.headers['host'] || ('localhost:' + PORT);
  var proto = req.headers['x-forwarded-proto'] || 'http';
  if (host.indexOf('lhr.life') !== -1 || host.indexOf('localhost.run') !== -1) proto = 'https';
  if (host.indexOf('://') !== -1) return host.replace(/\/$/,'');
  return (proto + '://' + host).replace(/\/$/,'');
}

function buildTorrentioBase(cfg) {
  var opts = [];
  if (cfg.providers && cfg.providers.length) opts.push('providers=' + cfg.providers.join(','));
  opts.push('sort=' + (cfg.sortBy || 'size'));
  if (cfg.language) opts.push('language=' + cfg.language);
  if (cfg.qualityfilter && cfg.qualityfilter.length)
    opts.push('qualityfilter=' + cfg.qualityfilter.join(','));
  return 'https://torrentio.strem.fun/' + opts.join('|');
}

function buildManifest(cfg, configStr, pub) {
  var t = getLang(cfg);
  return {
    id: 'com.hybrid.addon',
    version: '6.7.0',
    name: t.addonName,
    description: t.addonDesc,
    resources: ['stream'],
    types: ['movie','series'],
    idPrefixes: ['tt'],
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
      configurationURL: pub + (configStr ? '/'+configStr : '') + '/configure'
    }
  };
}

// ===================== TMDB =====================
function getRuTitleFromTMDb(imdbId, type) {
  var cacheKey = imdbId + '_ru';
  if (TMDB_CACHE[cacheKey]) {
    SERVER_STATS.cacheHits++;
    return Promise.resolve(TMDB_CACHE[cacheKey]);
  }
  var metaType = (type === 'series') ? 'tv' : 'movie';
  return fetch('https://api.themoviedb.org/3/find/' + imdbId +
    '?api_key=' + TMDB_API_KEY + '&external_source=imdb_id', { timeout: 120000 })
    .then(function(r) { return r.ok ? r.json() : {}; })
    .then(function(data) {
      var results = data[metaType + '_results'] || [];
      if (results.length === 0) return null;
      var tmdbId = results[0].id;
      var releaseDate = results[0].release_date || results[0].first_air_date || '';
      var year = releaseDate ? releaseDate.substring(0, 4) : '';
      TMDB_CACHE[cacheKey + '_full'] = { year: year };
      return fetch('https://api.themoviedb.org/3/' + metaType + '/' + tmdbId +
        '?api_key=' + TMDB_API_KEY + '&language=ru', { timeout: 120000 })
        .then(function(r) { return r.ok ? r.json() : {}; })
        .then(function(d) {
          var ruTitle = (d.title || d.name || '').replace(/\s*\(\d{4}\)\s*$/, '').trim();
          console.log('[TMDb] ' + imdbId + ' → RU:"' + ruTitle + '" (' + year + ')');
          TMDB_CACHE[cacheKey] = ruTitle || null;
          return ruTitle || null;
        });
    })
    .catch(function() { return null; });
}

function getOriginalTitleFromTMDb(imdbId, type) {
  var cacheKey = imdbId + '_orig';
  if (TMDB_CACHE[cacheKey]) {
    SERVER_STATS.cacheHits++;
    return Promise.resolve(TMDB_CACHE[cacheKey]);
  }
  var metaType = (type === 'series') ? 'tv' : 'movie';
  return fetch('https://api.themoviedb.org/3/find/' + imdbId +
    '?api_key=' + TMDB_API_KEY + '&external_source=imdb_id', { timeout: 120000 })
    .then(function(r) { return r.ok ? r.json() : {}; })
    .then(function(data) {
      var results = data[metaType + '_results'] || [];
      if (results.length === 0) return null;
      var title = results[0].title || results[0].name || imdbId;
      TMDB_CACHE[cacheKey] = title;
      return title;
    })
    .catch(function() { return imdbId; });
}

// ===================== TORRSERVER =====================
var torrServerCache = {}, CACHE_TTL = 30 * 60 * 1000;

function getTorrServerFiles(tsUrl, magnet, title) {
  return fetch(tsUrl + '/torrents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'add', link: magnet, title: title, poster: '', save_to_db: false }),
    timeout: 120000
  })
  .then(function(r) { return r.ok ? r.json() : null; })
  .then(function(data) {
    if (!data || !data.hash) return null;
    if (data.file_stats && data.file_stats.length > 0)
      return { hash: data.hash, files: data.file_stats };
    return new Promise(function(resolve) {
      var attempts = 0, maxAttempts = 12;
      function tryGet() {
        attempts++;
        setTimeout(function() {
          fetch(tsUrl + '/torrents', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'get', hash: data.hash }),
            timeout: 120000
          })
          .then(function(r) { return r.ok ? r.json() : null; })
          .then(function(d) {
            if (d && d.file_stats && d.file_stats.length > 0)
              resolve({ hash: data.hash, files: d.file_stats });
            else if (attempts < maxAttempts) tryGet();
            else resolve({ hash: data.hash, files: [] });
          })
          .catch(function() {
            if (attempts < maxAttempts) tryGet();
            else resolve({ hash: data.hash, files: [] });
          });
        }, 3000);
      }
      tryGet();
    });
  })
  .catch(function() { return null; });
}

function getCachedFiles(ts, magnet, title) {
  var hashMatch = magnet.match(/btih:([a-fA-F0-9]{40})/i);
  var cacheKey = hashMatch ? hashMatch[1].toLowerCase() : null;
  if (cacheKey) {
    var cached = torrServerCache[cacheKey];
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      SERVER_STATS.cacheHits++;
      return Promise.resolve({ hash: cacheKey, files: cached.files });
    }
  }
  return getTorrServerFiles(ts, magnet, title).then(function(result) {
    if (result && result.files.length > 0 && cacheKey)
      torrServerCache[cacheKey] = { files: result.files, timestamp: Date.now() };
    return result;
  });
}

// ===================== AUTO CLEANUP CACHE =====================
setInterval(function() {
  var now = Date.now();
  var deleted = 0;
  Object.keys(torrServerCache).forEach(function(k) {
    if (now - torrServerCache[k].timestamp > CACHE_TTL) {
      delete torrServerCache[k];
      deleted++;
    }
  });
  if (deleted > 0) console.log('[Cache] Cleaned', deleted, 'expired TorrServer entries');
}, 10 * 60 * 1000);

// ===================== FILE FINDING =====================
function findAnimeEpisodeFile(files, season, episode) {
  if (!files || files.length === 0) return null;
  var videoExts = ['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.ts'];
  var allFiles = files.map(function(f, idx) {
    return Object.assign({}, f, {
      _realIndex: (f.id !== undefined && f.id !== null) ? Number(f.id) : idx
    });
  });
  var videoFiles = allFiles.filter(function(f) {
    return videoExts.some(function(ex) { return (f.path || '').toLowerCase().endsWith(ex); });
  });
  var episodeFiles = videoFiles.filter(function(f) {
    var basename = (f.path || '').split('/').pop().toLowerCase();
    var path = (f.path || '').toLowerCase();
    var sizeMB = (f.length || 0) / (1024 * 1024);
    if (sizeMB < 500) return false;
    var excludeKeywords = ['sample','trailer','opening','ending','preview','ncop','nced',
      'creditless','menu','extra','bonus','sp','ova','special','ed ',' op ',' opening',' ending','credit'];
    for (var i = 0; i < excludeKeywords.length; i++) {
      if (basename.indexOf(excludeKeywords[i]) !== -1 ||
          path.indexOf(excludeKeywords[i]) !== -1) return false;
    }
    return true;
  });
  if (episodeFiles.length === 0) return null;
  episodeFiles.sort(function(a, b) { return (a.path || '').localeCompare(b.path || ''); });
  if (episode > 0 && episode <= episodeFiles.length) return episodeFiles[episode - 1];
  return null;
}

function findEpisodeFile(files, season, episode) {
  if (!files || files.length === 0) return null;
  var s = String(season).padStart(2, '0'), sNum = String(season);
  var e = String(episode).padStart(2, '0'), eNum = String(episode);
  var videoExts = ['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.ts'];
  var allFiles = files.map(function(f, idx) {
    return Object.assign({}, f, {
      _realIndex: (f.id !== undefined && f.id !== null) ? Number(f.id) : idx
    });
  });
  var videoFiles = allFiles.filter(function(f) {
    return videoExts.some(function(ex) { return (f.path || '').toLowerCase().endsWith(ex); });
  });
  var hasCorrectSeason = videoFiles.some(function(f) {
    return f.season === season || f.season === String(season) ||
           f.season === sNum || f.season === s;
  });
  var episodeFiles = videoFiles.filter(function(f) {
    var basename = (f.path || '').split('/').pop().toLowerCase();
    var path = (f.path || '').toLowerCase();
    var excludeKeywords = ['sample','trailer','opening','ending','preview','ncop','nced',
      'creditless','menu','extra','bonus','sp','ova','special','ed ',' op '];
    for (var i = 0; i < excludeKeywords.length; i++) {
      if (basename.indexOf(excludeKeywords[i]) !== -1 ||
          path.indexOf(excludeKeywords[i]) !== -1) return false;
    }
    return true;
  });
  if (episodeFiles.length === 0) return null;
  for (var i = 0; i < episodeFiles.length; i++) {
    var f = episodeFiles[i];
    var fS = String(f.season !== undefined ? f.season : '');
    var fE = String(f.episode !== undefined ? f.episode : '');
    if (hasCorrectSeason) {
      if (fS !== '' && fE !== '' && (fS === sNum || fS === s) && (fE === eNum || fE === e)) return f;
    } else {
      if (fE !== '' && (fE === eNum || fE === e)) return f;
    }
  }
  for (var i = 0; i < episodeFiles.length; i++) {
    var basename = (episodeFiles[i].path || '').split('/').pop().toLowerCase();
    if (new RegExp('s0*' + season + 'e0*' + episode + '(?:\\D|$)').test(basename))
      return episodeFiles[i];
    if (new RegExp('^0*' + episode + '[\\s\\.\\-_]').test(basename))
      return episodeFiles[i];
    if (new RegExp('ep\\s*0*' + episode + '(?:\\D|$)', 'i').test(basename))
      return episodeFiles[i];
  }
  var seasonPatterns = [
    'season_' + s, 'season_' + sNum, 'season ' + sNum,
    '/s' + s + '/', '/s' + sNum + '/', 'сезон_' + sNum, 'сезон ' + sNum
  ];
  var seasonFiles = episodeFiles.filter(function(f) {
    var fp = (f.path || '').toLowerCase();
    for (var i = 0; i < seasonPatterns.length; i++) {
      if (fp.indexOf(seasonPatterns[i]) !== -1) return true;
    }
    return new RegExp('s0*' + season + 'e').test(fp);
  });
  var targetFiles = seasonFiles.length > 0 ? seasonFiles : episodeFiles;
  targetFiles.sort(function(a, b) { return (a.path || '').localeCompare(b.path || ''); });
  if (episode > 0 && episode <= targetFiles.length) return targetFiles[episode - 1];
  return null;
}

// ===================== PLAY =====================
function handlePlay(query, cfg, res) {
  var t = getLang(cfg);
  var magnet = query.magnet || '';
  var season = parseInt(query.s) || 0;
  var episode = parseInt(query.e) || 0;
  var title = query.title || 'video';
  var ts = query.ts || cfg.torrServerUrl || '';
  if (ts && !ts.match(/^https?:\/\//)) ts = 'http://' + ts;
  if (!magnet || !ts) { res.writeHead(400); res.end(t.errMissingMagnet); return; }
  if (!season || !episode) {
    res.writeHead(302, {
      'Location': ts + '/stream/' + encodeURIComponent(title) +
        '?link=' + encodeURIComponent(magnet) + '&index=0&play'
    });
    res.end();
    return;
  }
  getCachedFiles(ts, magnet, title).then(function(result) {
    if (!result || !result.files) { res.writeHead(404); res.end(t.errNotFound); return; }
    var found = cfg.animeMode
      ? findAnimeEpisodeFile(result.files, season, episode)
      : findEpisodeFile(result.files, season, episode);
    if (found) {
      res.writeHead(302, {
        'Location': ts + '/stream/' + encodeURIComponent(title) +
          '?link=' + result.hash + '&index=' + found._realIndex + '&play'
      });
      res.end();
    } else {
      res.writeHead(404);
      res.end(t.errEpisodeNotFound + ' S' + season + 'E' + episode);
    }
  }).catch(function() { res.writeHead(500); res.end(t.errGeneric); });
}

// ===================== KNABEN =====================
function classifyKnabenTorrent(title) {
  var rangePattern = /\bS(\d{1,2})E(\d{1,3})\s*[-–]\s*E?(\d{1,3})\b/i;
  var seasonPackPattern = /\bS(\d{1,2})\b(?!\s*E\d)/i;
  var completePattern = /\b(complete|full.?series|all.?season|season.?\d+.?\d+)\b/i;
  var singleEpPattern = /\bS(\d{1,2})E(\d{1,3})\b(?!\s*[-–]\s*E?\d)/i;
  if (rangePattern.test(title)) return 'pack';
  if (completePattern.test(title)) return 'pack';
  if (singleEpPattern.test(title)) return 'episode';
  if (seasonPackPattern.test(title)) return 'pack';
  return 'pack';
}

function extractSeasonsFromTitle(title) {
  var seasons = [];
  var rangeMatch = title.match(/\bS(\d{1,2})E\d/gi);
  if (rangeMatch) {
    rangeMatch.forEach(function(m) {
      var sm = m.match(/S(\d{1,2})/i);
      if (sm) { var sn = parseInt(sm[1]); if (seasons.indexOf(sn) === -1) seasons.push(sn); }
    });
  }
  var seasonWordMatch = title.match(/Season\s*(\d{1,2})/gi);
  if (seasonWordMatch) {
    seasonWordMatch.forEach(function(m) {
      var sm = m.match(/(\d{1,2})/);
      if (sm) { var sn = parseInt(sm[1]); if (seasons.indexOf(sn) === -1) seasons.push(sn); }
    });
  }
  var sStandalone = title.match(/\bS(\d{1,2})\b(?!\s*E\d)/gi);
  if (sStandalone) {
    sStandalone.forEach(function(m) {
      var sm = m.match(/(\d{1,2})/);
      if (sm) { var sn = parseInt(sm[1]); if (seasons.indexOf(sn) === -1) seasons.push(sn); }
    });
  }
  return seasons;
}

function searchKnaben(query, maxResults, type, preferPack, season, episode) {
  var filterSegment = '0/1/bytes';
  if (type === 'movie') filterSegment = '3000000/1/bytes';
  else if (type === 'series') filterSegment = '2000000/1/bytes';
  var finalQuery = query;
  if (type === 'series' && !preferPack && season && episode) {
    var s = String(season).padStart(2, '0');
    var e = String(episode).padStart(2, '0');
    finalQuery = query + ' S' + s + 'E' + e;
  }
  var url = KNABEN_BASE_URL + encodeURIComponent(finalQuery) + '/' + filterSegment;
  console.log('[Knaben] URL:', url);
  return fetch(url, { timeout: 120000 })
    .then(function(r) { return r.text(); })
    .then(function(html) {
      var $ = cheerio.load(html);
      var results = [];
      var seen = new Map();
      $('table tbody tr').each(function(i, row) {
        if (results.length >= maxResults) return false;
        var cols = $(row).find('td');
        if (cols.length < 4) return;
        var magnet = null;
        $(row).find('a').each(function(j, a) {
          var href = $(a).attr('href');
          if (href && href.indexOf('magnet:') === 0) { magnet = href; return false; }
        });
        if (!magnet) return;
        var title = $(cols[1]).text().trim();
        var sizeStr = $(cols[2]).text().trim();
        var seeds = parseInt($(cols[4]).text().trim()) || 0;
        var hashMatch = magnet.match(/btih:([a-fA-F0-9]{40})/i);
        var key = hashMatch ? hashMatch[1].toLowerCase() : magnet;
        if (seen.has(key)) return;
        seen.set(key, true);
        results.push({
          title: title, magnet: magnet,
          sizeGB: parseSize(sizeStr), seeds: seeds,
          tracker: 'Knaben', source: 'knaben'
        });
      });
      console.log('[Knaben] Found', results.length, 'results for "' + finalQuery + '"');
      return results;
    })
    .catch(function(e) { console.error('[Knaben] Error:', e.message); return []; });
}

// ===================== JAC.RED =====================
function searchJacred(imdbId, type, maxResults, sortBy, preferredDomain, useFallback) {
  return getRuTitleFromTMDb(imdbId, type).then(function(ruTitle) {
    var cacheKey = imdbId + '_ru';
    var tmdbData = TMDB_CACHE[cacheKey + '_full'] || {};
    var expectedYear = tmdbData.year || '';
    var seen = new Map(), unique = [];

    function addResults(arr, sourceName) {
      if (!arr || !arr.length) return 0;
      var newCount = 0;
      for (var i = 0; i < arr.length; i++) {
        var t = arr[i];
        if (!t.magnet) continue;
        var hashMatch = t.magnet.match(/btih:([a-fA-F0-9]{40})/i);
        var key = hashMatch ? hashMatch[1].toLowerCase() : t.magnet;
        if (!seen.has(key)) {
          var types = t.types || [], seasons = t.seasons || [];
          var yearNum = parseInt(t.relased || t.released || t.related || '0') || 0;
          if (type === 'movie' && (types.includes('series') || seasons.length > 0)) continue;
          if (type === 'series' && types.includes('movie') && seasons.length === 0) continue;
          if (expectedYear && yearNum > 1900) {
            var diff = Math.abs(yearNum - parseInt(expectedYear));
            if (diff > 2) {
              console.log('[jac.red] ⏭️ Skip year mismatch ' + yearNum + ' vs ' + expectedYear);
              continue;
            }
          }
          seen.set(key, true);
          var qualityText = '';
          if (t.quality === 2160) qualityText = '4K';
          else if (t.quality === 1080) qualityText = '1080p';
          else if (t.quality === 720) qualityText = '720p';
          else if (t.quality === 480) qualityText = '480p';
          else if (t.quality) qualityText = t.quality + 'p';
          var videoType = '';
          if (t.videotype) {
            var vt = t.videotype.toLowerCase();
            if (vt.includes('hdr') || vt.includes('dolby')) videoType = 'HDR';
            else if (vt.includes('sdr')) videoType = 'SDR';
          }
          var audio = '';
          if (t.voice && Array.isArray(t.voice) && t.voice.length > 0)
            audio = t.voice.filter(function(v){return v;}).join('/');
          unique.push({
            original: t,
            title: decodeUnicode(t.title || ''),
            sizeGB: parseSize(t.sizeName || t.size),
            date: t.createdTime ? new Date(t.createdTime).getTime() : 0,
            sid: t.sid || t.seeds || t.seeders || 0,
            tracker: t.tracker || 'Unknown',
            magnet: t.magnet,
            quality: qualityText,
            videoType: videoType,
            audio: audio,
            year: yearNum
          });
          newCount++;
        }
      }
      console.log('[jac.red] ' + sourceName + ' → ' + arr.length + ' results, +' + newCount + ' unique');
      return newCount;
    }

    SERVER_STATS.jacredRequests++;

    // Hàm fetch 1 query với fallback
    function fetchQuery(queryParam) {
      if (useFallback !== false) {
        // Dùng fallback domain
        return fetchJacredWithFallback(preferredDomain, queryParam).then(function(result) {
          if (result.usedDomain && result.usedDomain !== preferredDomain) {
            SERVER_STATS.jacredFallbacks++;
          }
          return result.data || [];
        });
      } else {
        // Dùng đúng domain được chọn
        var apiUrl = JAC_RED_DOMAINS[preferredDomain] || JAC_RED_DOMAINS[DEFAULT_JACRED_DOMAIN];
        return fetch(apiUrl + '?' + queryParam, { timeout: 120000 })
          .then(function(r) { return r.ok ? r.json() : []; })
          .catch(function() {
            SERVER_STATS.jacredErrors++;
            return [];
          });
      }
    }

    var promises = [];
    if (ruTitle) {
      promises.push(
        fetchQuery('search=' + encodeURIComponent(ruTitle))
          .then(function(arr) { addResults(arr, 'RU "' + ruTitle + '"'); })
      );
    }
    promises.push(
      fetchQuery('search=' + encodeURIComponent(imdbId))
        .then(function(arr) { addResults(arr, 'IMDb "' + imdbId + '"'); })
    );

    return Promise.all(promises).then(function() {
      if (unique.length === 0) return [];
      unique.sort(function(a, b) {
        if (sortBy === 'seeds') return b.sid - a.sid;
        if (sortBy === 'date') return b.date - a.date;
        return b.sizeGB - a.sizeGB;
      });
      return unique.slice(0, maxResults || 30);
    });
  });
}

// ===================== STREAM =====================
function handleStream(type, id, cfg, res, pub) {
  SERVER_STATS.streamRequests++;
  var t = getLang(cfg);
  var ts = cfg.torrServerUrl || '';
  if (ts && !ts.match(/^https?:\/\//)) ts = 'http://' + ts;
  var idClean = decodeURIComponent(id);
  var parts = idClean.split(':');
  var imdbId = parts[0];
  var season = parseInt(parts[1]) || 0;
  var episode = parseInt(parts[2]) || 0;
  var streams = [];
  var completed = 0;
  var total = (cfg.jacredEnabled ? 1 : 0) +
               (cfg.torrentioEnabled ? 1 : 0) +
               (cfg.knabenEnabled ? 1 : 0);
  if (!total) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ streams: [] }));
    return;
  }

  function sendResponse() {
    if (++completed >= total) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ streams: streams }));
    }
  }

  var commonSort = cfg.commonSortBy || 'size';
  var minSize = parseFloat(cfg.sizeMinGB) || 0;
  var maxSize = parseFloat(cfg.sizeMaxGB) || 100;

  // ── KNABEN ──
  if (cfg.knabenEnabled) {
    SERVER_STATS.knabenRequests++;
    Promise.all([
      getRuTitleFromTMDb(imdbId, type),
      getOriginalTitleFromTMDb(imdbId, type)
    ]).then(function(titles) {
      var originalTitle = titles[1];
      var query = originalTitle || imdbId;
      console.log('[Knaben] Search query: "' + query + '"');
      return searchKnaben(query, cfg.maxResults || 30, type, cfg.preferPack, season, episode);
    }).catch(function() {
      return searchKnaben(imdbId, cfg.maxResults || 30, type, cfg.preferPack, season, episode);
    })
    .then(function(results) {
      if (commonSort === 'seeds')
        results.sort(function(a, b) { return b.seeds - a.seeds; });
      else if (commonSort === 'date')
        results.sort(function(a, b) { return (b.date || 0) - (a.date || 0); });
      else
        results.sort(function(a, b) { return b.sizeGB - a.sizeGB; });

      results.forEach(function(item) {
        if (!item.magnet) return;
        if (item.sizeGB < minSize) return;
        if (maxSize < 100 && item.sizeGB > maxSize) return;

        var torrentType = classifyKnabenTorrent(item.title);
        var isPack = (torrentType === 'pack');
        var isSingleEpisode = (torrentType === 'episode');

        if (type === 'series') {
          if (season > 0) {
            var titleSeasons = extractSeasonsFromTitle(item.title);
            if (titleSeasons.length > 0 && titleSeasons.indexOf(season) === -1) {
              console.log('[Knaben] ⏭️ Skip "' + item.title + '" - season ' +
                titleSeasons.join(',') + ' ≠ ' + season);
              return;
            }
            if (isSingleEpisode) {
              var epMatch = item.title.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
              if (epMatch) {
                var epSeason = parseInt(epMatch[1]);
                var epEpisode = parseInt(epMatch[2]);
                if (epSeason !== season) {
                  console.log('[Knaben] ⏭️ Skip wrong season: S' + epSeason);
                  return;
                }
                if (!cfg.preferPack && epEpisode !== episode) {
                  console.log('[Knaben] ⏭️ Skip wrong episode: E' + epEpisode);
                  return;
                }
              }
            }
            if (cfg.preferPack && isSingleEpisode) return;
            if (!cfg.preferPack && isPack) return;
          }
        }

        var sizeGB = item.sizeGB.toFixed(2);
        var badge = '';
        if (type === 'series') badge = isPack ? t.streamPack : t.streamSingleEp;
        var displayTitle = badge + item.title + '\n' + sizeGB + ' GB | 🌱 ' +
          item.seeds + ' seeds\n📡 Knaben';
        var url;
        if (type === 'movie') {
          url = ts + '/stream/' + encodeURIComponent(item.title) +
            '?link=' + encodeURIComponent(item.magnet) + '&index=0&play';
        } else {
          if (isPack) {
            url = pub + '/play?magnet=' + encodeURIComponent(item.magnet) +
              '&s=' + season + '&e=' + episode +
              '&title=' + encodeURIComponent(item.title) +
              '&ts=' + encodeURIComponent(ts);
          } else {
            url = ts + '/stream/' + encodeURIComponent(item.title) +
              '?link=' + encodeURIComponent(item.magnet) + '&index=0&play';
          }
        }
        streams.push({
          name: t.streamKnaben,
          title: displayTitle,
          url: url,
          behaviorHints: { notWebReady: true, bingeGroup: 'knaben-' + idClean }
        });
      });
      sendResponse();
    }).catch(function(e) {
      console.error('[Knaben] handleStream error:', e.message);
      sendResponse();
    });
  }

  // ── JAC.RED ──
  if (cfg.jacredEnabled) {
    var useFallback = cfg.jacredFallback !== false; // mặc định true
    searchJacred(imdbId, type, cfg.maxResults || 30, commonSort, cfg.jacredDomain, useFallback)
      .then(function(results) {
        results.forEach(function(item) {
          if (!item.magnet) return;
          if (item.sizeGB < minSize) return;
          if (maxSize < 100 && item.sizeGB > maxSize) return;

          var title = item.title;
          if (type === 'series' && season > 0) {
            var sPad = String(season).padStart(2, '0');
            var completePackPattern =
              /S\d{1,2}[-~]S?\d{1,2}|Season\s*\d+\s*[-~]\s*\d+|сезон[ы]?\s*\d+\s*[-~]\s*\d+|Complete|Полный|Все\s*сезон[ы]?|1-\d+\s*сезон/i;
            var isCompletePack = completePackPattern.test(title);
            if (!isCompletePack) {
              var singleSeasonPattern = new RegExp(
                'S' + sPad + '(?:[^\\d]|$)|Season\\s*' + season +
                '(?:[^\\d]|$)|сезон\\s*' + season + '(?:[^\\d]|$)|' + season + '\\s*сезон', 'i'
              );
              var otherSeasonPattern = /S\d{1,2}(?:[^\d]|$)|Season\s*\d|сезон\s*\d|\d+\s*сезон/gi;
              var hasOtherSeason = false;
              var matches = title.match(otherSeasonPattern);
              if (matches) {
                for (var i = 0; i < matches.length; i++) {
                  if (!singleSeasonPattern.test(matches[i])) {
                    var otherSeasonMatch = matches[i].match(/\d+/);
                    if (otherSeasonMatch && parseInt(otherSeasonMatch[0]) !== season) {
                      hasOtherSeason = true; break;
                    }
                  }
                }
              }
              if (hasOtherSeason) return;
              if (!singleSeasonPattern.test(title) &&
                  /S\d{1,2}|Season\s*\d|сезон\s*\d/.test(title)) return;
            }
          }

          var trackerDisplay = item.tracker.charAt(0).toUpperCase() + item.tracker.slice(1);
          var sizeGB = item.sizeGB.toFixed(2);
          var seeds = item.sid;
          var quality = item.quality || '';
          var videoType = item.videoType || '';
          var audio = item.audio || '';
          var streamName = t.streamJacred + trackerDisplay;
          var streamTitle = item.title + '\n' + sizeGB + ' GB | 🌱 ' + seeds + ' seeds';
          if (quality) {
            streamTitle += ' | 🎬 ' + quality;
            if (videoType) streamTitle += ' ' + videoType;
          }
          if (audio) streamTitle += ' | 🔊 ' + audio;
          streamTitle += '\n📡 ' + trackerDisplay;

          if (type === 'movie') {
            streams.push({
              name: streamName, title: streamTitle,
              url: ts + '/stream/' + encodeURIComponent(item.title) +
                '?link=' + encodeURIComponent(item.magnet) + '&index=0&play',
              behaviorHints: { notWebReady: true, bingeGroup: 'jacred-' + idClean }
            });
          } else {
            streams.push({
              name: streamName, title: streamTitle,
              url: pub + '/play?magnet=' + encodeURIComponent(item.magnet) +
                '&s=' + season + '&e=' + episode +
                '&title=' + encodeURIComponent(item.title) +
                '&ts=' + encodeURIComponent(ts),
              behaviorHints: { notWebReady: true, bingeGroup: 'jacred-' + idClean }
            });
          }
        });
        sendResponse();
      }).catch(function(e) {
        console.error('[jac.red]', e.message);
        SERVER_STATS.jacredErrors++;
        sendResponse();
      });
  }

  // ── TORRENTIO ──
  if (cfg.torrentioEnabled) {
    SERVER_STATS.torrentioRequests++;
    var tioUrl = buildTorrentioBase(cfg) + '/stream/' + type + '/' + idClean + '.json';
    fetch(tioUrl, { timeout: 120000 })
      .then(function(r) { return r.ok ? r.json() : { streams: [] }; })
      .then(function(data) {
        if (data.streams) {
          data.streams.filter(function(s) { return s.infoHash; }).forEach(function(s) {
            streams.push({
              name: t.streamTorrentio,
              title: '🎬 ' + s.title,
              url: ts + '/stream/' + encodeURIComponent(s.title || 'video') +
                '?link=' + s.infoHash + '&index=' + (s.fileIdx || 0) + '&play',
              behaviorHints: { notWebReady: true, bingeGroup: 'torrentio-' + s.infoHash }
            });
          });
        }
        sendResponse();
      }).catch(function(e) { console.error('[Torrentio]', e.message); sendResponse(); });
  }
}

// ===================== STATUS PAGE =====================
function handleStatus(cfg, res) {
  var t = getLang(cfg);
  var uptimeSec = Math.floor((Date.now() - SERVER_STATS.startTime) / 1000);
  var h = Math.floor(uptimeSec / 3600);
  var m = Math.floor((uptimeSec % 3600) / 60);
  var s = uptimeSec % 60;
  var mem = process.memoryUsage();

  // Build JacRed domain status rows
  var domainRows = '';
  Object.keys(JAC_RED_DOMAINS).forEach(function(key) {
    var st = JACRED_DOMAIN_STATUS[key] || {};
    var statusIcon, statusClass, statusText;
    if (st.ok === true) {
      statusIcon = '✅'; statusClass = 'ok';
      statusText = (st.latency != null ? st.latency + 'ms' : 'OK');
    } else if (st.ok === false) {
      statusIcon = '❌'; statusClass = 'err';
      statusText = 'Error' + (st.errors ? ' ×' + st.errors : '');
    } else {
      statusIcon = '⏳'; statusClass = 'warn';
      statusText = 'Checking...';
    }
    var lastCheck = st.lastCheck
      ? new Date(st.lastCheck).toLocaleTimeString()
      : 'Never';
    domainRows += '<div class="row">'
      + '<span class="label">' + statusIcon + ' ' + key + '</span>'
      + '<span class="value ' + statusClass + '">' + statusText
      + ' <small style="color:#5a5a80;font-weight:400">(' + lastCheck + ')</small>'
      + '</span></div>';
  });

  var html = '<!DOCTYPE html><html><head>'
    + '<meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta http-equiv="refresh" content="30">'
    + '<title>Status — Hybrid Addon</title>'
    + '<style>'
    + '*{margin:0;padding:0;box-sizing:border-box}'
    + 'body{font-family:Inter,sans-serif;background:#080812;color:#e8e8f0;padding:24px}'
    + 'h1{font-size:22px;margin-bottom:6px;color:#7c6df8}'
    + '.subtitle{color:#5a5a80;font-size:13px;margin-bottom:24px}'
    + '.section-title{font-size:11px;font-weight:700;color:#5a5a80;text-transform:uppercase;'
    +   'letter-spacing:1px;margin:20px 0 8px}'
    + '.card{background:#141428;border:1px solid #1e1e40;border-radius:14px;'
    +   'padding:20px;margin-bottom:12px}'
    + '.row{display:flex;justify-content:space-between;align-items:center;'
    +   'padding:10px 0;border-bottom:1px solid #1e1e40}'
    + '.row:last-child{border:none}'
    + '.label{color:#9090b0;font-size:14px}'
    + '.value{color:#e8e8f0;font-weight:600;font-size:14px;text-align:right}'
    + '.ok{color:#22d3a5}'
    + '.err{color:#f87171}'
    + '.warn{color:#fbbf24}'
    + '.badge-ok{display:inline-block;background:rgba(34,211,165,.15);color:#22d3a5;'
    +   'border:1px solid rgba(34,211,165,.3);border-radius:20px;padding:2px 10px;font-size:11px}'
    + '.badge-err{display:inline-block;background:rgba(248,113,113,.15);color:#f87171;'
    +   'border:1px solid rgba(248,113,113,.3);border-radius:20px;padding:2px 10px;font-size:11px}'
    + '.badge-warn{display:inline-block;background:rgba(251,191,36,.15);color:#fbbf24;'
    +   'border:1px solid rgba(251,191,36,.3);border-radius:20px;padding:2px 10px;font-size:11px}'
    + '.back{display:inline-block;margin-top:16px;color:#7c6df8;text-decoration:none;font-size:14px}'
    + '.refresh-note{color:#5a5a80;font-size:12px;margin-top:4px}'
    + '.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}'
    + '.stat-box{background:#141428;border:1px solid #1e1e40;border-radius:10px;'
    +   'padding:14px;text-align:center}'
    + '.stat-num{font-size:28px;font-weight:700;color:#7c6df8;line-height:1}'
    + '.stat-label{font-size:11px;color:#5a5a80;margin-top:4px}'
    + '</style>'
    + '</head><body>'

    // Header
    + '<h1>' + t.statusTitle + '</h1>'
    + '<p class="subtitle">Hybrid Addon v6.7.0 &nbsp;·&nbsp; Auto refresh mỗi 30 giây</p>'
    + '<p class="refresh-note">' + t.statusLastCheck + ': ' + new Date().toLocaleString() + '</p>'

    // Stat Grid
    + '<div class="section-title">📈 Thống kê requests</div>'
    + '<div class="stat-grid">'
    + '<div class="stat-box"><div class="stat-num">' + SERVER_STATS.totalRequests + '</div>'
    +   '<div class="stat-label">Tổng requests</div></div>'
    + '<div class="stat-box"><div class="stat-num">' + SERVER_STATS.streamRequests + '</div>'
    +   '<div class="stat-label">Stream requests</div></div>'
    + '<div class="stat-box"><div class="stat-num">' + SERVER_STATS.jacredRequests + '</div>'
    +   '<div class="stat-label">JacRed requests</div></div>'
    + '<div class="stat-box"><div class="stat-num">' + SERVER_STATS.knabenRequests + '</div>'
    +   '<div class="stat-label">Knaben requests</div></div>'
    + '<div class="stat-box"><div class="stat-num">' + SERVER_STATS.torrentioRequests + '</div>'
    +   '<div class="stat-label">Torrentio requests</div></div>'
    + '<div class="stat-box"><div class="stat-num">' + SERVER_STATS.cacheHits + '</div>'
    +   '<div class="stat-label">Cache hits</div></div>'
    + '</div>'

    // Server Info
    + '<div class="section-title">🖥 Server</div>'
    + '<div class="card">'
    + '<div class="row"><span class="label">⏱ Uptime</span>'
    +   '<span class="value ok">' + h + 'h ' + m + 'm ' + s + 's</span></div>'
    + '<div class="row"><span class="label">🧠 Memory (heap)</span>'
    +   '<span class="value">' + Math.round(mem.heapUsed/1024/1024) + ' MB'
    +   ' / ' + Math.round(mem.heapTotal/1024/1024) + ' MB</span></div>'
    + '<div class="row"><span class="label">📦 RSS Memory</span>'
    +   '<span class="value">' + Math.round(mem.rss/1024/1024) + ' MB</span></div>'
    + '<div class="row"><span class="label">🔖 Version</span>'
    +   '<span class="value">6.7.0</span></div>'
    + '<div class="row"><span class="label">🌍 Node.js</span>'
    +   '<span class="value">' + process.version + '</span></div>'
    + '</div>'

    // Cache Info
    + '<div class="section-title">💾 Cache</div>'
    + '<div class="card">'
    + '<div class="row"><span class="label">🎬 TMDB Cache</span>'
    +   '<span class="value">' + Object.keys(TMDB_CACHE).length + ' ' + t.statusEntries + '</span></div>'
    + '<div class="row"><span class="label">🖥 TorrServer Cache</span>'
    +   '<span class="value">' + Object.keys(torrServerCache).length + ' ' + t.statusEntries + '</span></div>'
    + '<div class="row"><span class="label">⚡ Cache Hits</span>'
    +   '<span class="value ok">' + SERVER_STATS.cacheHits + '</span></div>'
    + '</div>'

    // JacRed Fallback Stats
    + '<div class="section-title">🔁 JacRed Fallback</div>'
    + '<div class="card">'
    + '<div class="row"><span class="label">✅ Thành công</span>'
    +   '<span class="value ok">' + SERVER_STATS.jacredRequests + ' ' + t.statusRequests + '</span></div>'
    + '<div class="row"><span class="label">🔁 Fallback đã dùng</span>'
    +   '<span class="value warn">' + SERVER_STATS.jacredFallbacks + ' ' + t.statusTimes + '</span></div>'
    + '<div class="row"><span class="label">❌ Lỗi hoàn toàn</span>'
    +   '<span class="value err">' + SERVER_STATS.jacredErrors + ' ' + t.statusTimes + '</span></div>'
    + '</div>'

    // JacRed Domain Status
    + '<div class="section-title">🌐 JacRed Domain Status</div>'
    + '<div class="card">'
    + domainRows
    + '</div>'

    // Actions
    + '<a class="back" href="/configure">← Back to Configure</a>'
    + ' &nbsp; '
    + '<a class="back" href="/status" style="color:#22d3a5">🔄 Refresh</a>'

    + '</body></html>';

  res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
  res.end(html);
}

// ===================== CONFIG PAGE =====================
function buildConfigPage(cfg, configStr, pub) {
  var t = getLang(cfg);
  var currentLang = (cfg && cfg.uiLang) || 'vi';
  var installUrl = pub + (configStr ? '/' + configStr : '') + '/manifest.json';
  var stremioUrl = 'stremio://' + installUrl.replace(/^https?:\/\//, '');
  var commonSort = cfg.commonSortBy || 'size';
  var jacredDomain = cfg.jacredDomain || DEFAULT_JACRED_DOMAIN;
  var jacredFallback = cfg.jacredFallback !== false;
  var sizeMinGB = cfg.sizeMinGB !== undefined ? cfg.sizeMinGB : 0;
  var sizeMaxGB = cfg.sizeMaxGB !== undefined ? cfg.sizeMaxGB : 100;

  // Domain options với status indicator
  var domainOptions = '';
  for (var key in JAC_RED_DOMAINS) {
    var st = JACRED_DOMAIN_STATUS[key] || {};
    var indicator = st.ok === true ? ' ✅' : st.ok === false ? ' ❌' : ' ⏳';
    var latencyText = (st.ok === true && st.latency) ? ' (' + st.latency + 'ms)' : '';
    domainOptions += '<option value="' + key + '"' +
      (jacredDomain === key ? ' selected' : '') + '>' +
      key + indicator + latencyText + '</option>';
  }

  var guideSteps = '';
  t.guideSteps.forEach(function(step, i) {
    guideSteps += '<div class="step-item"><div class="step-num">' + (i+1) +
      '</div><div class="step-content"><strong>' + step.title +
      '</strong><p>' + step.desc + '</p></div></div>';
  });

  var html = '<!DOCTYPE html><html lang="' + currentLang + '"><head>'
    + '<meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + t.addonName + '</title>'
    + '<link rel="preconnect" href="https://fonts.googleapis.com">'
    + '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
    + '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700'
    +   '&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + '*{margin:0;padding:0;box-sizing:border-box}'
    + ':root{--bg:#080812;--bg2:#0d0d1f;--bg3:#12122a;--card:#141428;--border:#1e1e40;'
    +   '--border2:#2a2a50;--text:#e8e8f0;--text2:#9090b0;--text3:#5a5a80;--primary:#7c6df8;'
    +   '--primary2:#9d8fff;--green:#22d3a5;--green2:#10b981;--red:#f87171;--yellow:#fbbf24;'
    +   '--blue:#60a5fa;--grad1:linear-gradient(135deg,#7c6df8,#a855f7);'
    +   '--grad2:linear-gradient(135deg,#22d3a5,#059669);'
    +   '--grad3:linear-gradient(135deg,#f87171,#ef4444);'
    +   '--radius:14px;--radius2:10px;--radius3:8px;--shadow:0 4px 24px rgba(0,0,0,.4)}'
    + 'body{font-family:"Inter",system-ui,-apple-system,sans-serif;background:var(--bg);'
    +   'color:var(--text);min-height:100vh;padding:24px 16px 48px;line-height:1.6}'
    + '.wrap{max-width:640px;margin:0 auto}'
    + '.header{text-align:center;margin-bottom:32px;padding:32px 24px;background:var(--card);'
    +   'border:1px solid var(--border);border-radius:20px;position:relative;overflow:hidden}'
    + '.header::before{content:"";position:absolute;inset:0;'
    +   'background:radial-gradient(ellipse at top,rgba(124,109,248,.15),transparent 60%);pointer-events:none}'
    + '.header h1{font-size:26px;font-weight:700;background:var(--grad1);'
    +   '-webkit-background-clip:text;-webkit-text-fill-color:transparent;'
    +   'letter-spacing:-.5px;margin-bottom:6px}'
    + '.header p{color:var(--text2);font-size:13px;font-weight:400}'
    + '.badge{display:inline-flex;align-items:center;gap:6px;background:rgba(124,109,248,.15);'
    +   'border:1px solid rgba(124,109,248,.3);border-radius:20px;padding:4px 12px;'
    +   'font-size:11px;font-weight:600;color:var(--primary2);margin-top:10px;letter-spacing:.5px}'
    + '.lang-row{display:flex;gap:8px;justify-content:center;margin-top:14px}'
    + '.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);'
    +   'padding:20px;margin-bottom:12px;transition:border-color .2s}'
    + '.card:hover{border-color:var(--border2)}'
    + '.card-header{display:flex;align-items:center;gap:8px;margin-bottom:16px}'
    + '.card-header h2{font-size:14px;font-weight:600;color:var(--text2);'
    +   'text-transform:uppercase;letter-spacing:.8px}'
    + '.card-icon{width:28px;height:28px;border-radius:8px;display:flex;align-items:center;'
    +   'justify-content:center;font-size:14px;flex-shrink:0}'
    + '.ci-purple{background:rgba(124,109,248,.2)}'
    + '.ci-green{background:rgba(34,211,165,.2)}'
    + '.ci-red{background:rgba(248,113,113,.2)}'
    + '.ci-yellow{background:rgba(251,191,36,.2)}'
    + '.ci-blue{background:rgba(96,165,250,.2)}'
    + '.fg{margin-bottom:14px}.fg:last-child{margin-bottom:0}'
    + '.fg label{display:block;color:var(--text2);font-size:12px;font-weight:600;'
    +   'margin-bottom:6px;text-transform:uppercase;letter-spacing:.6px}'
    + 'input[type=text],input[type=number],textarea,select{width:100%;padding:11px 14px;'
    +   'background:var(--bg2);border:1px solid var(--border2);border-radius:var(--radius3);'
    +   'color:var(--text);font-size:14px;font-family:"Inter",sans-serif;'
    +   'transition:border-color .2s,box-shadow .2s;outline:none}'
    + 'input:focus,textarea:focus,select:focus{border-color:var(--primary);'
    +   'box-shadow:0 0 0 3px rgba(124,109,248,.15)}'
    + 'textarea{resize:vertical;min-height:72px;font-family:"JetBrains Mono",monospace;font-size:12px}'
    + 'select option{background:var(--bg2)}'
    + '.trow{display:flex;align-items:center;justify-content:space-between;'
    +   'padding:10px 0;border-bottom:1px solid var(--border)}'
    + '.trow:last-of-type{border:none;padding-bottom:0}'
    + '.trow-info{flex:1;min-width:0}'
    + '.trow-info .trow-label{font-size:15px;font-weight:500;color:var(--text)}'
    + '.trow-info .trow-sub{font-size:12px;color:var(--text3);margin-top:2px}'
    + '.sw{position:relative;width:46px;height:26px;flex-shrink:0}'
    + '.sw input{opacity:0;width:0;height:0}'
    + '.sl{position:absolute;inset:0;background:var(--border2);border-radius:26px;'
    +   'cursor:pointer;transition:.25s}'
    + '.sl::before{content:"";position:absolute;width:20px;height:20px;left:3px;top:3px;'
    +   'background:#fff;border-radius:50%;transition:.25s;box-shadow:0 1px 4px rgba(0,0,0,.3)}'
    + 'input:checked+.sl{background:var(--primary)}'
    + 'input:checked+.sl::before{transform:translateX(20px)}'
    + '.btn{padding:11px 18px;border:none;border-radius:var(--radius3);font-size:13px;'
    +   'font-weight:600;cursor:pointer;text-decoration:none;display:inline-flex;'
    +   'align-items:center;justify-content:center;gap:6px;transition:all .2s;'
    +   'font-family:"Inter",sans-serif;white-space:nowrap}'
    + '.btn:hover{filter:brightness(1.1);transform:translateY(-1px)}'
    + '.btn:active{transform:translateY(0)}'
    + '.btn-ghost{background:var(--bg2);border:1px solid var(--border2);color:var(--text2)}'
    + '.btn-primary{background:var(--grad1);color:#fff;box-shadow:0 4px 15px rgba(124,109,248,.3)}'
    + '.btn-green{background:var(--grad2);color:#fff;box-shadow:0 4px 15px rgba(34,211,165,.3)}'
    + '.btn-active-lang{background:rgba(124,109,248,.2);border:1px solid var(--primary);color:var(--primary2)}'
    + '.btn-full{width:100%}'
    + '.btn-sm{padding:8px 14px;font-size:12px;border-radius:6px}'
    + '.btn-row{display:flex;gap:8px;margin-top:8px}'
    + '.sort-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px}'
    + '.sort-btn{padding:14px 8px;background:var(--bg2);border:2px solid var(--border2);'
    +   'border-radius:var(--radius3);color:var(--text2);font-size:12px;font-weight:600;'
    +   'cursor:pointer;text-align:center;transition:all .2s;font-family:"Inter",sans-serif}'
    + '.sort-btn:hover{border-color:var(--primary);color:var(--text)}'
    + '.sort-btn.active{border-color:var(--primary);background:rgba(124,109,248,.15);color:var(--primary2)}'
    + '.sort-btn .sort-icon{font-size:18px;display:block;margin-bottom:4px}'
    + '.qf-grid{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}'
    + '.qf-label{display:flex;align-items:center;gap:6px;padding:7px 12px;background:var(--bg2);'
    +   'border:1.5px solid var(--border2);border-radius:6px;cursor:pointer;font-size:13px;'
    +   'font-weight:500;transition:all .2s;user-select:none}'
    + '.qf-label:hover{border-color:var(--primary);color:var(--text)}'
    + '.qf-label input[type=checkbox]{width:14px;height:14px;accent-color:var(--primary);cursor:pointer}'
    + '.qf-label.active-qf{border-color:var(--red);background:rgba(248,113,113,.1);color:var(--red)}'
    + '.url-box{background:var(--bg);border:1px solid var(--border2);border-radius:var(--radius3);'
    +   'padding:12px 14px;font-family:"JetBrains Mono",monospace;font-size:11px;'
    +   'color:var(--blue);word-break:break-all;margin:14px 0;line-height:1.6}'
    + '.divider{height:1px;background:var(--border);margin:14px 0}'
    + '.test-result{margin-top:8px;padding:8px 12px;border-radius:6px;font-size:12px;'
    +   'font-family:"Inter",sans-serif;display:none}'
    + '.test-result.ok{background:rgba(34,211,165,.1);color:var(--green);border:1px solid rgba(34,211,165,.3)}'
    + '.test-result.err{background:rgba(248,113,113,.1);color:var(--red);border:1px solid rgba(248,113,113,.3)}'
    + '.test-result.loading{background:rgba(124,109,248,.1);color:var(--primary2);border:1px solid rgba(124,109,248,.3)}'
    + '.install-row{display:grid;grid-template-columns:auto 1fr;gap:8px}'
    + '.guide{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);'
    +   'padding:20px;margin-top:8px}'
    + '.guide h3{font-size:13px;font-weight:600;color:var(--primary2);text-transform:uppercase;'
    +   'letter-spacing:.6px;margin-bottom:14px}'
    + '.step-item{display:flex;gap:12px;margin-bottom:14px}'
    + '.step-item:last-child{margin-bottom:0}'
    + '.step-num{width:24px;height:24px;border-radius:50%;background:rgba(124,109,248,.2);'
    +   'color:var(--primary2);font-size:11px;font-weight:700;display:flex;align-items:center;'
    +   'justify-content:center;flex-shrink:0;margin-top:1px}'
    + '.step-content{flex:1}'
    + '.step-content strong{font-size:13px;color:var(--text);display:block;margin-bottom:4px}'
    + '.step-content p{font-size:13px;color:var(--text3);line-height:1.6}'
    + '.gen-wrap{margin:16px 0}'
    + '.footer{text-align:center;margin-top:32px;padding:20px;color:var(--text3);font-size:13px;'
    +   'border-top:1px solid var(--border)}'
    + '.footer span{color:var(--red)}'
    + '.footer a{color:var(--primary2);text-decoration:none}'
    + '.footer a:hover{text-decoration:underline}'
    + '.hint{font-size:12px;color:var(--text3);margin-top:5px;line-height:1.5}'
    + '.hint a{color:var(--primary2);text-decoration:none}'
    + '.hint a:hover{text-decoration:underline}'
    + '.domain-status-bar{display:flex;gap:4px;margin-top:8px;flex-wrap:wrap}'
    + '.domain-dot{font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600}'
    + '.domain-dot-ok{background:rgba(34,211,165,.15);color:#22d3a5;border:1px solid rgba(34,211,165,.3)}'
    + '.domain-dot-err{background:rgba(248,113,113,.15);color:#f87171;border:1px solid rgba(248,113,113,.3)}'
    + '.domain-dot-unk{background:rgba(251,191,36,.1);color:#fbbf24;border:1px solid rgba(251,191,36,.2)}'
    + '</style></head><body><div class="wrap">'

    // ── Header ──
    + '<div class="header">'
    + '<h1>' + t.addonName + '</h1>'
    + '<p>' + t.addonSubtitle + '</p>'
    + '<div class="badge">✨ ' + t.addonVersion + '</div>'
    + '<div class="lang-row">'
    + '<button class="btn btn-sm ' + (currentLang === 'vi' ? 'btn-active-lang' : 'btn-ghost') +
        '" onclick="switchLang(\'vi\')">🇻🇳 Tiếng Việt</button>'
    + '<button class="btn btn-sm ' + (currentLang === 'en' ? 'btn-active-lang' : 'btn-ghost') +
        '" onclick="switchLang(\'en\')">🇬🇧 English</button>'
    + '<a class="btn btn-sm btn-ghost" href="/status?lang=' + currentLang + '">📊 Status</a>'
    + '</div></div>'

    // ── Torrentio Config ──
    + '<div class="card">'
    + '<div class="card-header"><div class="card-icon ci-green">🔗</div>'
    + '<h2>' + t.cardTorrentioConfig + '</h2></div>'
    + '<div class="fg"><label>' + t.torrentioConfigLabel + '</label>'
    + '<textarea id="configLink" placeholder="' + t.torrentioConfigPlaceholder + '"></textarea></div>'
    + '<div class="btn-row">'
    + '<button class="btn btn-ghost" style="flex:1" onclick="applyTorrentioConfig()">' + t.torrentioApply + '</button>'
    + '<button class="btn btn-ghost" style="flex:1" onclick="resetTorrentioConfig()">' + t.torrentioReset + '</button>'
    + '</div></div>'

    // ── Sources ──
    + '<div class="card">'
    + '<div class="card-header"><div class="card-icon ci-purple">📡</div>'
    + '<h2>' + t.cardSources + '</h2></div>'
    + '<div class="trow"><div class="trow-info"><div class="trow-label">' + t.srcTorrentio +
        '</div><div class="trow-sub">' + t.srcTorrentioDesc + '</div></div>'
    +   '<label class="sw"><input type="checkbox" id="torrentioEnabled"' +
        (cfg.torrentioEnabled ? ' checked' : '') + '><span class="sl"></span></label></div>'
    + '<div class="trow"><div class="trow-info"><div class="trow-label">' + t.srcKnaben +
        '</div><div class="trow-sub">' + t.srcKnabenDesc + '</div></div>'
    +   '<label class="sw"><input type="checkbox" id="knabenEnabled"' +
        (cfg.knabenEnabled ? ' checked' : '') + '><span class="sl"></span></label></div>'
    + '<div class="trow"><div class="trow-info"><div class="trow-label">' + t.srcJacred +
        '</div><div class="trow-sub">' + t.srcJacredDesc + '</div></div>'
    +   '<label class="sw"><input type="checkbox" id="jacredEnabled"' +
        (cfg.jacredEnabled ? ' checked' : '') + '><span class="sl"></span></label></div>'
    + '<div class="divider"></div>'
    // JacRed Domain + status dots
    + '<div class="fg" style="margin-top:14px">'
    + '<label>' + t.srcJacredDomain + '</label>'
    + '<select id="jacredDomain">' + domainOptions + '</select>'
    + '<p class="hint">' + t.srcJacredDomainHint + '</p>'
    // Status dots
    + '<div class="domain-status-bar">'
    + (function() {
        var dots = '';
        Object.keys(JAC_RED_DOMAINS).forEach(function(key) {
          var st = JACRED_DOMAIN_STATUS[key] || {};
          var cls = st.ok === true ? 'domain-dot-ok' : st.ok === false ? 'domain-dot-err' : 'domain-dot-unk';
          var icon = st.ok === true ? '✅' : st.ok === false ? '❌' : '⏳';
          dots += '<span class="domain-dot ' + cls + '">' + icon + ' ' + key + '</span>';
        });
        return dots;
      })()
    + '</div></div>'
    // Fallback toggle
    + '<div class="trow" style="margin-top:10px">'
    + '<div class="trow-info"><div class="trow-label">🔁 Fallback Domain</div>'
    + '<div class="trow-sub">' + t.statusFallbackDesc + '</div></div>'
    + '<label class="sw"><input type="checkbox" id="jacredFallback"' +
        (jacredFallback ? ' checked' : '') + '><span class="sl"></span></label>'
    + '</div>'
    + '</div>'

    // ── TorrServer ──
    + '<div class="card">'
    + '<div class="card-header"><div class="card-icon ci-blue">🖥</div>'
    + '<h2>' + t.cardTorrServer + '</h2></div>'
    + '<div class="fg"><label>' + t.tsUrlLabel + '</label>'
    + '<div style="display:flex;gap:8px;align-items:center">'
    + '<input type="text" id="tsUrl" value="' + (cfg.torrServerUrl || '') +
        '" placeholder="' + t.tsUrlPlaceholder + '" style="flex:1">'
    + '<button class="btn btn-ghost btn-sm" onclick="testTorrServer()">' + t.tsTestBtn + '</button>'
    + '</div>'
    + '<div id="tsTestResult" class="test-result"></div>'
    + '<p class="hint">' + t.tsHint + ' <a href="https://github.com/YouROK/TorrServer" target="_blank">' +
        t.tsHintLink + '</a></p>'
    + '</div></div>'

    // ── Filters ──
    + '<div class="card">'
    + '<div class="card-header"><div class="card-icon ci-yellow">⚙️</div>'
    + '<h2>' + t.cardFilter + '</h2></div>'
    + '<p style="font-size:11px;color:var(--text3);margin-bottom:16px">' + t.filterNote + '</p>'
    + '<div class="fg"><label>' + t.filterSortLabel + '</label>'
    + '<div class="sort-grid">'
    + '<div class="sort-btn' + (commonSort === 'size' ? ' active' : '') +
        '" onclick="setCommonSort(\'size\',this)"><span class="sort-icon">💾</span>' + t.filterSortSize + '</div>'
    + '<div class="sort-btn' + (commonSort === 'seeds' ? ' active' : '') +
        '" onclick="setCommonSort(\'seeds\',this)"><span class="sort-icon">👥</span>' + t.filterSortSeeds + '</div>'
    + '<div class="sort-btn' + (commonSort === 'date' ? ' active' : '') +
        '" onclick="setCommonSort(\'date\',this)"><span class="sort-icon">📅</span>' + t.filterSortDate + '</div>'
    + '</div><input type="hidden" id="commonSort" value="' + commonSort + '"></div>'
    + '<div class="fg"><label>' + t.filterMaxResults + '</label>'
    + '<input type="number" id="maxResults" value="' + (cfg.maxResults || 30) + '" min="5" max="100"></div>'
    + '<div class="fg"><label>' + t.filterSizeLabel + '</label>'
    + '<div style="display:flex;gap:8px">'
    + '<input type="number" id="minSize" placeholder="' + t.filterSizeMin + '" value="' +
        (cfg.sizeMinGB || '') + '" style="flex:1" step="0.5" min="0">'
    + '<input type="number" id="maxSize" placeholder="' + t.filterSizeMax + '" value="' +
        (cfg.sizeMaxGB || '') + '" style="flex:1" step="0.5" min="0">'
    + '</div><p class="hint">' + t.filterSizeHint + '</p></div>'
    + '<div class="fg"><label>' + t.filterQualityLabel + '</label>'
    + '<div class="qf-grid">'
    + '<label class="qf-label" id="qfl-480p"><input type="checkbox" value="480p" ' +
        (cfg.commonQualityFilter && cfg.commonQualityFilter.includes('480p') ? 'checked' : '') +
        ' onchange="updateQfLabel(this)"> 480p</label>'
    + '<label class="qf-label" id="qfl-720p"><input type="checkbox" value="720p" ' +
        (cfg.commonQualityFilter && cfg.commonQualityFilter.includes('720p') ? 'checked' : '') +
        ' onchange="updateQfLabel(this)"> 720p</label>'
    + '<label class="qf-label" id="qfl-1080p"><input type="checkbox" value="1080p" ' +
        (cfg.commonQualityFilter && cfg.commonQualityFilter.includes('1080p') ? 'checked' : '') +
        ' onchange="updateQfLabel(this)"> 1080p</label>'
    + '<label class="qf-label" id="qfl-4K"><input type="checkbox" value="4K" ' +
        (cfg.commonQualityFilter && cfg.commonQualityFilter.includes('4K') ? 'checked' : '') +
        ' onchange="updateQfLabel(this)"> 4K</label>'
    + '</div><p class="hint">' + t.filterQualityHint + '</p></div>'
    + '</div>'

    // ── Search ──
    + '<div class="card">'
    + '<div class="card-header"><div class="card-icon ci-purple">🔍</div>'
    + '<h2>' + t.cardSearch + '</h2></div>'
    + '<div class="trow"><div class="trow-info"><div class="trow-label">' + t.preferPackLabel +
        '</div><div class="trow-sub">' + t.preferPackDesc + '</div></div>'
    + '<label class="sw"><input type="checkbox" id="preferPack"' +
        (cfg.preferPack !== false ? ' checked' : '') + '><span class="sl"></span></label>'
    + '</div></div>'

    // ── Anime ──
    + '<div class="card">'
    + '<div class="card-header"><div class="card-icon ci-red">🎌</div>'
    + '<h2>' + t.cardAnime + '</h2></div>'
    + '<div class="trow"><div class="trow-info"><div class="trow-label">' + t.animeModeLabel +
        '</div><div class="trow-sub">' + t.animeModeDesc + '</div></div>'
    + '<label class="sw"><input type="checkbox" id="animeMode"' +
        (cfg.animeMode ? ' checked' : '') + '><span class="sl"></span></label>'
    + '</div></div>'

    // ── Install ──
    + '<div class="card">'
    + '<div class="card-header"><div class="card-icon ci-green">📦</div>'
    + '<h2>' + t.cardInstall + '</h2></div>'
    + '<div class="url-box" id="iurl">' + installUrl + '</div>'
    + '<div class="install-row">'
    + '<button class="btn btn-ghost" onclick="copyUrl()">' + t.installCopy + '</button>'
    + '<a class="btn btn-green" href="' + stremioUrl + '" id="slink">' + t.installBtn + '</a>'
    + '</div></div>'

    // ── Generate ──
    + '<div class="gen-wrap">'
    + '<button class="btn btn-primary btn-full" style="padding:16px;font-size:15px;border-radius:var(--radius)" onclick="gen()">'
    + t.generateBtn + '</button></div>'

    // ── Guide ──
    + '<div class="guide"><h3>' + t.guideTitle + '</h3>' + guideSteps + '</div>'

    // ── Footer ──
    + '<div class="footer">' + t.footerText + '</div>'
    + '</div>'

    // ── Scripts ──
    + '<script>'
    + 'var currentConfig=' + JSON.stringify({
        providers: cfg.providers, sortBy: cfg.sortBy,
        language: cfg.language, qualityfilter: cfg.qualityfilter
      }) + ';'
    + 'var MSG_COPIED="' + t.installCopied + '";'
    + 'var MSG_COPY_FAIL="' + t.installCopyFail + '";'
    + 'var MSG_TS_EMPTY="' + t.tsErrEmpty + '";'
    + 'var MSG_TS_TESTING="' + t.tsTesting + '";'
    + 'var MSG_TS_OK="' + t.tsOk + '";'
    + 'var MSG_TS_TIMEOUT="' + t.tsErrTimeout + '";'
    + 'var MSG_TS_FAIL="' + t.tsErrFail + '";'
    + 'function updateQfLabel(cb){'
    +   'var lbl=cb.closest("label");'
    +   'if(cb.checked)lbl.classList.add("active-qf");'
    +   'else lbl.classList.remove("active-qf");'
    + '}'
    + 'document.querySelectorAll(".qf-label input[type=checkbox]").forEach(function(cb){updateQfLabel(cb)});'
    + 'function setCommonSort(v,el){'
    +   'document.getElementById("commonSort").value=v;'
    +   'document.querySelectorAll(".sort-btn").forEach(function(b){b.classList.remove("active")});'
    +   'el.classList.add("active");'
    + '}'
    + 'function enc(o){return btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=/g,"")}'
    + 'function parseTorrentioLink(link){'
    +   'try{'
    +     'var u=new URL(link.replace("stremio://","https://"));'
    +     'var m=u.pathname.match(/\\/([^\\/]+)\\/manifest\\.json/);'
    +     'if(!m)return null;'
    +     'var p=m[1].split("|");'
    +     'var c={providers:[],sortBy:"size",language:"",qualityfilter:[]};'
    +     'p.forEach(function(x){'
    +       'var kv=x.split("=");var k=kv[0],v=kv[1];'
    +       'if(k==="providers")c.providers=v.split(",");'
    +       'else if(k==="sort")c.sortBy=v;'
    +       'else if(k==="language")c.language=v;'
    +       'else if(k==="qualityfilter")c.qualityfilter=v.split(",");'
    +     '});'
    +     'return c;'
    +   '}catch(e){return null;}'
    + '}'
    + 'function applyTorrentioConfig(){'
    +   'var l=document.getElementById("configLink").value.trim();'
    +   'if(!l)return alert("!");'
    +   'var c=parseTorrentioLink(l);'
    +   'if(!c)return alert("Invalid link!");'
    +   'currentConfig=c;gen();'
    + '}'
    + 'function resetTorrentioConfig(){'
    +   'currentConfig=' + JSON.stringify(DEFAULT_TORRENTIO_CONFIG) + ';'
    +   'document.getElementById("configLink").value="";gen();'
    + '}'
    + 'function getCurrentConfig(){'
    +   'var qualityFilter=Array.from(document.querySelectorAll(".qf-grid input[type=checkbox]:checked")).map(function(c){return c.value});'
    +   'return Object.assign({'
    +     'torrServerUrl:document.getElementById("tsUrl").value.trim(),'
    +     'jacredEnabled:document.getElementById("jacredEnabled").checked,'
    +     'torrentioEnabled:document.getElementById("torrentioEnabled").checked,'
    +     'knabenEnabled:document.getElementById("knabenEnabled").checked,'
    +     'commonSortBy:document.getElementById("commonSort").value,'
    +     'maxResults:parseInt(document.getElementById("maxResults").value)||30,'
    +     'jacredDomain:document.getElementById("jacredDomain").value,'
    +     'jacredFallback:document.getElementById("jacredFallback").checked,'
    +     'animeMode:document.getElementById("animeMode").checked,'
    +     'preferPack:document.getElementById("preferPack").checked,'
    +     'commonQualityFilter:qualityFilter,'
    +     'sizeMinGB:parseFloat(document.getElementById("minSize").value)||0,'
    +     'sizeMaxGB:parseFloat(document.getElementById("maxSize").value)||100,'
    +     'uiLang:"' + currentLang + '"'
    +   '},currentConfig);'
    + '}'
    + 'function copyUrl(){'
    +   'var url=document.getElementById("iurl").textContent;'
    +   'if(navigator.clipboard&&navigator.clipboard.writeText){'
    +     'navigator.clipboard.writeText(url).then(function(){alert(MSG_COPIED)}).catch(function(){fallbackCopy(url)});'
    +   '}else{fallbackCopy(url);}'
    + '}'
    + 'function fallbackCopy(text){'
    +   'var ta=document.createElement("textarea");ta.value=text;'
    +   'ta.style.cssText="position:fixed;top:-9999px;left:-9999px";'
    +   'document.body.appendChild(ta);ta.select();'
    +   'try{document.execCommand("copy");alert(MSG_COPIED)}'
    +   'catch(e){alert(MSG_COPY_FAIL+text)}'
    +   'document.body.removeChild(ta);'
    + '}'
    + 'function gen(){'
    +   'var c=getCurrentConfig();var e=enc(c);'
    +   'var u=location.protocol+"//"+location.host+"/"+e+"/manifest.json";'
    +   'document.getElementById("iurl").textContent=u;'
    +   'document.getElementById("slink").href="stremio://"+u.replace(/^https?:\\/\\//,"");'
    + '}'
    + 'function switchLang(lang){'
    +   'var c=getCurrentConfig();c.uiLang=lang;var e=enc(c);'
    +   'location.href=location.protocol+"//"+location.host+"/"+e+"/configure";'
    + '}'
    + 'async function testTorrServer(){'
    +   'var url=document.getElementById("tsUrl").value.trim();'
    +   'var rd=document.getElementById("tsTestResult");'
    +   'if(!url){rd.className="test-result err";rd.style.display="block";rd.textContent=MSG_TS_EMPTY;return;}'
    +   'if(!url.match(/^https?:\\/\\//))url="http://"+url;'
    +   'rd.className="test-result loading";rd.style.display="block";rd.textContent=MSG_TS_TESTING;'
    +   'try{'
    +     'var ctrl=new AbortController();'
    +     'var tid=setTimeout(function(){ctrl.abort()},8000);'
    +     'var r=await fetch(url+"/echo",{signal:ctrl.signal});'
    +     'clearTimeout(tid);'
    +     'if(r.ok){rd.className="test-result ok";rd.textContent=MSG_TS_OK;}'
    +     'else throw new Error("HTTP "+r.status);'
    +   '}catch(e){'
    +     'rd.className="test-result err";'
    +     'rd.textContent=e.name==="AbortError"?MSG_TS_TIMEOUT:MSG_TS_FAIL+e.message;'
    +   '}'
    + '}'
    + '</script></body></html>';

  return html;
}

// ===================== SERVER =====================
var server = http.createServer(function(req, res) {
  SERVER_STATS.totalRequests++;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  var host = req.headers['host'] || 'localhost';
  var p = parseUrl(req.url, host);
  var cfg = p.userConfig || DEFAULT_CONFIG;
  var rest = p.rest;
  var pub = getPublicUrlFromReq(req);
  var query = parseQuery(req.url, host);

  console.log('[REQ]', req.method, req.url);

  if (rest === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (rest === '/play') { handlePlay(query, cfg, res); return; }
  if (rest === '/status') { if (query.lang) cfg = Object.assign({}, cfg, { uiLang: query.lang }); handleStatus(cfg, res); return; }

  if (rest === '/' || rest === '/configure') {
    res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
    res.end(buildConfigPage(cfg, p.configStr, pub));
    return;
  }
  if (rest === '/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildManifest(cfg, p.configStr, pub)));
    return;
  }
  if (rest.indexOf('/stream/') === 0) {
    var parts = rest.split('/').filter(Boolean);
    if (parts[1] && parts[2])
      handleStream(parts[1], parts[2].replace('.json',''), cfg, res, pub);
    else { res.writeHead(404); res.end(); }
    return;
  }
  res.writeHead(404); res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('\n✅ Hybrid Addon v6.7.0 started!');
  console.log('🌐 http://localhost:' + PORT);
  console.log('⚙️  Configure : http://localhost:' + PORT + '/configure');
  console.log('📊 Status    : http://localhost:' + PORT + '/status');
  console.log('🌍 Language  : ' + DEFAULT_CONFIG.uiLang.toUpperCase());
  console.log('🎌 Anime Mode: ' + (DEFAULT_CONFIG.animeMode ? 'ON' : 'OFF'));
  console.log('🟠 Knaben   : ' + (DEFAULT_CONFIG.knabenEnabled ? 'ON' : 'OFF'));
  console.log('📦 Prefer Pack: ' + (DEFAULT_CONFIG.preferPack ? 'ON' : 'OFF'));
  console.log('🔁 JacRed Fallback: ON');
  console.log('💾 Cache file: ' + CACHE_FILE);
  console.log('❤️  Made with love\n');
});
