// NetTube 2G - Server
// Set env var: YOUTUBE_API_KEY=your_key
// Deploy free on Render.com or Railway.app

const http  = require('http');
const https = require('https');
const url   = require('url');

const PORT   = process.env.PORT || 3000;
const YT_KEY = process.env.YOUTUBE_API_KEY || 'AIzaSyCUekS5EAfyNlMSmMwGtOkeq1Z6m1RPtfA';

// ── HELPERS ───────────────────────────────────────────────────

function httpsGet(hostname, path) {
  return new Promise(function(resolve, reject) {
    https.get({ hostname: hostname, path: path, headers: { 'User-Agent': 'NetTube2G/1.0' } }, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { resolve({ status: res.statusCode, body: JSON.parse(d), headers: res.headers }); }
        catch(e) { resolve({ status: res.statusCode, body: d, headers: res.headers }); }
      });
    }).on('error', reject);
  });
}

function httpsPost(hostname, path, data) {
  var body = JSON.stringify(data);
  return new Promise(function(resolve, reject) {
    var r = https.request({
      hostname: hostname, path: path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'NetTube2G/1.0', 'Content-Length': Buffer.byteLength(body) }
    }, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { resolve({ status: res.statusCode, body: JSON.parse(d), headers: res.headers }); }
        catch(e) { resolve({ status: res.statusCode, body: d, headers: res.headers }); }
      });
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

function yt(path) {
  var sep = path.indexOf('?') >= 0 ? '&' : '?';
  return httpsGet('www.googleapis.com', '/youtube/v3/' + path + sep + 'key=' + YT_KEY);
}

function fmt(n) {
  n = parseInt(n) || 0;
  if (n >= 1e9) return (n/1e9).toFixed(1)+'B';
  if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(1)+'K';
  return String(n);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJSON(res, data, status) {
  cors(res);
  res.writeHead(status || 200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendError(res, msg, status) {
  sendJSON(res, { error: msg }, status || 500);
}

function getChannels(ids) {
  if (!ids.length) return Promise.resolve({});
  return yt('channels?part=snippet,statistics&id=' + ids.join(',')).then(function(r) {
    var map = {};
    ((r.body && r.body.items) || []).forEach(function(c) {
      var subs = parseInt((c.statistics && c.statistics.subscriberCount) || 0);
      map[c.id] = {
        pfp: (c.snippet && c.snippet.thumbnails && c.snippet.thumbnails.default && c.snippet.thumbnails.default.url) || '',
        subs: subs, verified: subs > 100000
      };
    });
    return map;
  });
}

function mapVideo(v, chMap) {
  var ch = (chMap && chMap[v.snippet && v.snippet.channelId]) || {};
  var st = v.statistics || {};
  var th = v.snippet && v.snippet.thumbnails;
  return {
    id: v.id,
    title: (v.snippet && v.snippet.title) || '',
    channel: (v.snippet && v.snippet.channelTitle) || '',
    channelId: (v.snippet && v.snippet.channelId) || '',
    thumb: (th && (th.medium || th.default) && (th.medium || th.default).url) || '',
    published: (v.snippet && v.snippet.publishedAt) || '',
    pfp: ch.pfp || '', subs: fmt(ch.subs || 0), verified: ch.verified || false,
    views: fmt(st.viewCount || 0), likes: fmt(st.likeCount || 0)
  };
}

function collectCids(items) {
  var cids = [];
  items.forEach(function(v) { if (v.snippet && v.snippet.channelId && cids.indexOf(v.snippet.channelId) < 0) cids.push(v.snippet.channelId); });
  return cids;
}

function shuffle(arr) {
  for (var i = arr.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// ── DOWNLOAD via cobalt.tools ─────────────────────────────────

function cobaltFetch(videoId, format, quality) {
  var isAudio = (format === 'mp3' || format === 'wav');
  var body = { url: 'https://www.youtube.com/watch?v=' + videoId };
  if (isAudio) {
    body.downloadMode = 'audio';
    body.audioFormat  = (format === 'wav' ? 'wav' : 'mp3');
  } else {
    body.downloadMode  = 'auto';
    body.videoQuality  = quality || (format === '3gp' ? '144' : '720');
  }
  return httpsPost('api.cobalt.tools', '/', body);
}

// ── ROUTES ────────────────────────────────────────────────────

// GET /api/feed?catId=&pageUS=&pagePH=
function handleFeed(res, q) {
  var catId = q.catId || '';
  var cp    = catId ? '&videoCategoryId=' + catId : '';
  var ppUS  = q.pageUS ? '&pageToken=' + encodeURIComponent(q.pageUS) : '';
  var ppPH  = q.pagePH ? '&pageToken=' + encodeURIComponent(q.pagePH) : '';

  Promise.all([
    yt('videos?part=snippet,statistics&chart=mostPopular&maxResults=10&regionCode=US' + cp + ppUS),
    yt('videos?part=snippet,statistics&chart=mostPopular&maxResults=10&regionCode=PH' + cp + ppPH)
  ]).then(function(results) {
    var usItems = (results[0].body && results[0].body.items) || [];
    var phItems = (results[1].body && results[1].body.items) || [];
    var all = usItems.concat(phItems);
    return getChannels(collectCids(all)).then(function(chMap) {
      var mixed = [];
      var max = Math.max(usItems.length, phItems.length);
      for (var i = 0; i < max; i++) {
        if (i < usItems.length) mixed.push(mapVideo(usItems[i], chMap));
        if (i < phItems.length) mixed.push(mapVideo(phItems[i], chMap));
      }
      shuffle(mixed);
      sendJSON(res, {
        videos: mixed,
        nextPageUS: (results[0].body && results[0].body.nextPageToken) || '',
        nextPagePH: (results[1].body && results[1].body.nextPageToken) || ''
      });
    });
  }).catch(function(e) { sendError(res, e.message); });
}

// GET /api/trending
var TREND_REGIONS = ['PH','US','JP','KR','MX'];
var TREND_LABELS  = { PH:'Philippines', US:'United States', JP:'Japan', KR:'Korea', MX:'Mexico' };
function handleTrending(res, q) {
  Promise.all(TREND_REGIONS.map(function(r) {
    var pp = q[r+'_page'] ? '&pageToken=' + encodeURIComponent(q[r+'_page']) : '';
    return yt('videos?part=snippet,statistics&chart=mostPopular&maxResults=8&regionCode=' + r + pp)
      .then(function(d) { return { region: r, items: (d.body && d.body.items) || [], next: (d.body && d.body.nextPageToken) || '' }; })
      .catch(function() { return { region: r, items: [], next: '' }; });
  })).then(function(results) {
    var all = [];
    results.forEach(function(r) { all = all.concat(r.items); });
    return getChannels(collectCids(all)).then(function(chMap) {
      var out = {};
      results.forEach(function(r) {
        out[r.region] = { label: TREND_LABELS[r.region], videos: r.items.map(function(v) { return mapVideo(v, chMap); }), next: r.next };
      });
      sendJSON(res, out);
    });
  }).catch(function(e) { sendError(res, e.message); });
}

// GET /api/rec
var REC_CATS = { music:'10', gaming:'20', shows:'43', news:'25' };
var REC_LABELS = { music:'Top Music', gaming:'Top Gaming', shows:'Top Shows', news:'Top News' };
function handleRec(res, q) {
  var promises = [];
  Object.keys(REC_CATS).forEach(function(c) {
    ['PH','US'].forEach(function(region) {
      var key = c + '_' + region;
      var pp  = q[key+'_page'] ? '&pageToken=' + encodeURIComponent(q[key+'_page']) : '';
      promises.push(
        yt('videos?part=snippet,statistics&chart=mostPopular&maxResults=8&regionCode=' + region + '&videoCategoryId=' + REC_CATS[c] + pp)
          .then(function(d) { return { cat: c, items: (d.body && d.body.items) || [] }; })
          .catch(function() { return { cat: c, items: [] }; })
      );
    });
  });
  Promise.all(promises).then(function(results) {
    var bycat = {};
    results.forEach(function(r) {
      if (!bycat[r.cat]) bycat[r.cat] = [];
      bycat[r.cat] = bycat[r.cat].concat(r.items);
    });
    var all = [];
    Object.keys(bycat).forEach(function(k) { all = all.concat(bycat[k]); });
    return getChannels(collectCids(all)).then(function(chMap) {
      var out = {};
      Object.keys(bycat).forEach(function(k) {
        out[k] = { label: REC_LABELS[k], videos: shuffle(bycat[k].map(function(v) { return mapVideo(v, chMap); })).slice(0,8) };
      });
      sendJSON(res, out);
    });
  }).catch(function(e) { sendError(res, e.message); });
}

// GET /api/search?q=&page=
function handleSearch(res, q) {
  var query = q.q || '';
  if (!query) return sendJSON(res, { videos: [] });
  var pp = q.page ? '&pageToken=' + encodeURIComponent(q.page) : '';
  yt('search?part=snippet&type=video&maxResults=12&q=' + encodeURIComponent(query) + pp)
    .then(function(d) {
      var items = (d.body && d.body.items) || [];
      var ids = items.filter(function(v) { return v && v.id && v.id.videoId; }).map(function(v) { return v.id.videoId; });
      if (!ids.length) return sendJSON(res, { videos: [], nextPage: '' });
      return yt('videos?part=snippet,statistics&id=' + ids.join(',')).then(function(vd) {
        var all = (vd.body && vd.body.items) || [];
        return getChannels(collectCids(all)).then(function(chMap) {
          sendJSON(res, {
            videos: all.map(function(v) { return mapVideo(v, chMap); }),
            nextPage: (d.body && d.body.nextPageToken) || ''
          });
        });
      });
    }).catch(function(e) { sendError(res, e.message); });
}

// GET /api/video/:id
function handleVideo(res, q) {
  var id = q.id || '';
  if (!id) return sendError(res, 'Missing id', 400);
  yt('videos?part=snippet,statistics&id=' + id).then(function(d) {
    var item = d.body && d.body.items && d.body.items[0];
    if (!item) return sendError(res, 'Not found', 404);
    var st = item.statistics || {};
    sendJSON(res, {
      views: fmt(st.viewCount || 0),
      likes: fmt(st.likeCount || 0),
      description: (item.snippet && item.snippet.description || '').substring(0, 400)
    });
  }).catch(function(e) { sendError(res, e.message); });
}

// GET /api/comments?id=&page=
function handleComments(res, q) {
  var id = q.id || '';
  if (!id) return sendError(res, 'Missing id', 400);
  var pp = q.page ? '&pageToken=' + encodeURIComponent(q.page) : '';
  yt('commentThreads?part=snippet,replies&videoId=' + id + '&maxResults=20&order=relevance' + pp)
    .then(function(d) {
      var items = (d.body && d.body.items) || [];
      var comments = items.map(function(c) {
        var s = c.snippet.topLevelComment.snippet;
        var replies = (c.replies && c.replies.comments || []).map(function(r) {
          var rs = r.snippet;
          return { author: rs.authorDisplayName, pfp: rs.authorProfileImageUrl, text: rs.textDisplay, likes: fmt(rs.likeCount || 0), published: rs.publishedAt };
        });
        return {
          id: c.id,
          author: s.authorDisplayName, pfp: s.authorProfileImageUrl,
          text: s.textDisplay, likes: fmt(s.likeCount || 0), published: s.publishedAt,
          replyCount: c.snippet.totalReplyCount || 0, replies: replies
        };
      });
      sendJSON(res, { comments: comments, nextPage: (d.body && d.body.nextPageToken) || '' });
    }).catch(function(e) { sendError(res, e.message); });
}

// GET /api/replies?id=&page=
function handleReplies(res, q) {
  var id = q.id || '';
  if (!id) return sendError(res, 'Missing id', 400);
  var pp = q.page ? '&pageToken=' + encodeURIComponent(q.page) : '';
  yt('comments?part=snippet&parentId=' + id + '&maxResults=20&textFormat=plainText' + pp)
    .then(function(d) {
      var replies = (d.body && d.body.items || []).map(function(r) {
        var s = r.snippet;
        return { author: s.authorDisplayName, pfp: s.authorProfileImageUrl, text: s.textDisplay, likes: fmt(s.likeCount || 0), published: s.publishedAt };
      });
      sendJSON(res, { replies: replies, nextPage: (d.body && d.body.nextPageToken) || '' });
    }).catch(function(e) { sendError(res, e.message); });
}

// GET /api/rec-video?id=&chanId=
function handleRecVideo(res, q) {
  var id = q.id || '', chanId = q.chanId || '';
  var p1 = yt('videos?part=snippet,statistics&chart=mostPopular&maxResults=10&regionCode=PH');
  var p2 = chanId ? yt('search?part=snippet&type=video&channelId=' + chanId + '&maxResults=6&order=viewCount') : Promise.resolve({ body: { items: [] } });
  Promise.all([p1, p2]).then(function(results) {
    var seen = {}; seen[id] = true;
    var items = [];
    ((results[0].body && results[0].body.items) || []).forEach(function(v) {
      if (!seen[v.id]) { seen[v.id] = true; items.push(v); }
    });
    var searchItems = ((results[1].body && results[1].body.items) || []).filter(function(v) { return v && v.id && v.id.videoId && !seen[v.id.videoId]; });
    if (!searchItems.length) {
      return getChannels(collectCids(items)).then(function(chMap) {
        sendJSON(res, { videos: items.slice(0,8).map(function(v) { return mapVideo(v, chMap); }) });
      });
    }
    var sids = searchItems.map(function(v) { return v.id.videoId; }).join(',');
    return yt('videos?part=snippet,statistics&id=' + sids).then(function(vd) {
      ((vd.body && vd.body.items) || []).forEach(function(v) { if (!seen[v.id]) { seen[v.id] = true; items.push(v); } });
      return getChannels(collectCids(items)).then(function(chMap) {
        sendJSON(res, { videos: items.slice(0,8).map(function(v) { return mapVideo(v, chMap); }) });
      });
    });
  }).catch(function(e) { sendError(res, e.message); });
}

// GET /dl?id=VIDEO_ID&f=mp3|wav|mp4|3gp&q=144|360|720|1080
// Server-side cobalt fetch — no CORS problem — redirects phone to raw file
function handleDownload(res, q) {
  var id     = q.id || '';
  var format = q.f  || 'mp4';
  var quality= q.q  || '';
  if (!id) { res.writeHead(400); res.end('Missing id'); return; }

  cobaltFetch(id, format, quality).then(function(r) {
    var d = r.body;
    // Direct URL — redirect the phone straight to the file
    if (d.url && (d.status === 'redirect' || d.status === 'tunnel' || d.url)) {
      cors(res);
      res.writeHead(302, { 'Location': d.url });
      res.end();
      return;
    }
    // Picker — return JSON with all quality options so client can show a menu
    if (d.status === 'picker' && d.picker && d.picker.length) {
      sendJSON(res, { picker: d.picker.map(function(p) { return { url: p.url, quality: p.quality || '' }; }) });
      return;
    }
    // cobalt error
    sendError(res, (d.error && d.error.code) || 'cobalt returned no URL', 502);
  }).catch(function(e) { sendError(res, e.message, 502); });
}

// ── SERVER ────────────────────────────────────────────────────

var server = http.createServer(function(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  var parsed = url.parse(req.url, true);
  var path   = parsed.pathname;
  var q      = parsed.query;

  // Static index.html is served by GitHub Pages — server only handles /api/* and /dl
  if (path === '/api/feed')      return handleFeed(res, q);
  if (path === '/api/trending')  return handleTrending(res, q);
  if (path === '/api/rec')       return handleRec(res, q);
  if (path === '/api/search')    return handleSearch(res, q);
  if (path === '/api/video')     return handleVideo(res, q);
  if (path === '/api/comments')  return handleComments(res, q);
  if (path === '/api/replies')   return handleReplies(res, q);
  if (path === '/api/rec-video') return handleRecVideo(res, q);
  if (path === '/dl')            return handleDownload(res, q);

  // Health check
  if (path === '/') { cors(res); res.writeHead(200); res.end('NetTube 2G server running'); return; }

  cors(res); res.writeHead(404); res.end('Not found');
});

server.listen(PORT, function() {
  console.log('NetTube 2G server running on port ' + PORT);
  if (!YT_KEY || YT_KEY === 'YOUR_API_KEY_HERE') {
    console.warn('WARNING: YOUTUBE_API_KEY env var not set!');
  } else {
    console.log('YouTube API key: set');
  }
});
