const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// JSONBlob.com cloud storage for persistence
const ENTRIES_BLOB_ID = process.env.ENTRIES_BLOB_ID || '019d2c76-2fdf-76f9-bb11-165816e7cd37';
const RESULTS_BLOB_ID = process.env.RESULTS_BLOB_ID || '019d2c76-4587-7d0c-a8e3-e2ace5bdeae7';
const JSONBLOB_HOST = 'jsonblob.com';

// In-memory cache (loaded from cloud on startup)
let entriesCache = [];
let resultsCache = { results: {}, finalScore: null, lastUpdated: null };

// MIME types
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// ============================================================
// BRACKET DEFINITION - 2026 NCAA Sweet 16
// ============================================================
const BRACKET_TEAMS = [
  { gameId: "e1", seed: 1, name: "Duke", espn: ["duke blue devils", "duke"] },
  { gameId: "e1", seed: 5, name: "St. John's", espn: ["st. john's red storm", "st. john's", "st john's"] },
  { gameId: "e2", seed: 3, name: "Michigan St", espn: ["michigan state spartans", "michigan state", "michigan st"] },
  { gameId: "e2", seed: 2, name: "UConn", espn: ["uconn huskies", "uconn", "connecticut huskies", "connecticut"] },
  { gameId: "s1", seed: 3, name: "Illinois", espn: ["illinois fighting illini", "illinois"] },
  { gameId: "s1", seed: 2, name: "Houston", espn: ["houston cougars", "houston"] },
  { gameId: "s2", seed: 9, name: "Iowa", espn: ["iowa hawkeyes", "iowa"] },
  { gameId: "s2", seed: 4, name: "Nebraska", espn: ["nebraska cornhuskers", "nebraska"] },
  { gameId: "m1", seed: 1, name: "Michigan", espn: ["michigan wolverines", "michigan"] },
  { gameId: "m1", seed: 4, name: "Alabama", espn: ["alabama crimson tide", "alabama"] },
  { gameId: "m2", seed: 6, name: "Tennessee", espn: ["tennessee volunteers", "tennessee"] },
  { gameId: "m2", seed: 2, name: "Iowa St", espn: ["iowa state cyclones", "iowa state", "iowa st"] },
  { gameId: "w1", seed: 11, name: "Texas", espn: ["texas longhorns", "texas"] },
  { gameId: "w1", seed: 2, name: "Purdue", espn: ["purdue boilermakers", "purdue"] },
  { gameId: "w2", seed: 4, name: "Arkansas", espn: ["arkansas razorbacks", "arkansas"] },
  { gameId: "w2", seed: 1, name: "Arizona", espn: ["arizona wildcats", "arizona"] },
];

// Game tree for later rounds
const GAME_TREE = {
  ee: ["e1", "e2"], se: ["s1", "s2"], me: ["m1", "m2"], we: ["w1", "w2"],
  ff1: ["ee", "se"], ff2: ["me", "we"],
  champ: ["ff1", "ff2"]
};

function seedName(team) { return team.seed + " " + team.name; }

function findBracketTeam(espnName) {
  const lower = espnName.toLowerCase().replace(/[.']/g, '');
  for (const t of BRACKET_TEAMS) {
    for (const alias of t.espn) {
      if (lower.includes(alias.replace(/[.']/g, '')) || alias.replace(/[.']/g, '').includes(lower)) {
        return { gameId: t.gameId, seedName: seedName(t) };
      }
    }
  }
  return null;
}

function identifyGame(t1Info, t2Info, currentResults) {
  if (t1Info.gameId === t2Info.gameId) return t1Info.gameId;
  for (const [gameId, feeders] of Object.entries(GAME_TREE)) {
    const [f1, f2] = feeders;
    const t1From1 = currentResults[f1] === t1Info.seedName;
    const t1From2 = currentResults[f2] === t1Info.seedName;
    const t2From1 = currentResults[f1] === t2Info.seedName;
    const t2From2 = currentResults[f2] === t2Info.seedName;
    if ((t1From1 && t2From2) || (t1From2 && t2From1)) return gameId;
  }
  return null;
}

// ============================================================
// CLOUD STORAGE (jsonblob.com)
// ============================================================
function cloudRequest(method, blobId, data) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: JSONBLOB_HOST,
      path: `/api/jsonBlob/${blobId}`,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };

    const req = https.request(options, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(null); }
      });
    });

    req.on('error', err => {
      console.error(`Cloud storage error (${method} ${blobId}):`, err.message);
      reject(err);
    });

    if (data !== undefined) req.write(JSON.stringify(data));
    req.end();
  });
}

async function loadEntriesFromCloud() {
  try {
    const data = await cloudRequest('GET', ENTRIES_BLOB_ID);
    if (Array.isArray(data)) {
      entriesCache = data;
      console.log(`  Loaded ${entriesCache.length} entries from cloud`);
    }
  } catch (err) {
    console.error('Failed to load entries from cloud:', err.message);
  }
}

async function saveEntriesToCloud() {
  try {
    await cloudRequest('PUT', ENTRIES_BLOB_ID, entriesCache);
    console.log(`  Saved ${entriesCache.length} entries to cloud`);
  } catch (err) {
    console.error('Failed to save entries to cloud:', err.message);
  }
}

async function loadResultsFromCloud() {
  try {
    const data = await cloudRequest('GET', RESULTS_BLOB_ID);
    if (data && typeof data === 'object') {
      resultsCache = data;
      const numResults = Object.keys(resultsCache.results || {}).length;
      console.log(`  Loaded ${numResults} results from cloud`);
    }
  } catch (err) {
    console.error('Failed to load results from cloud:', err.message);
  }
}

async function saveResultsToCloud() {
  try {
    await cloudRequest('PUT', RESULTS_BLOB_ID, resultsCache);
    console.log(`  Saved results to cloud`);
  } catch (err) {
    console.error('Failed to save results to cloud:', err.message);
  }
}

// ============================================================
// DATA ACCESS (in-memory with cloud sync)
// ============================================================
function readEntries() { return entriesCache; }

async function writeEntries(e) {
  entriesCache = e;
  await saveEntriesToCloud();
}

function readResults() { return resultsCache; }

async function writeResults(d) {
  resultsCache = d;
  await saveResultsToCloud();
}

// ============================================================
// ESPN SCORE FETCHER
// ============================================================
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function formatDate(d) {
  return d.getFullYear().toString() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
}

async function fetchESPNScores() {
  try {
    const dates = [
      '20260326','20260327','20260328','20260329',
      '20260404','20260405','20260406','20260407',
      formatDate(new Date()),
      formatDate(new Date(Date.now() - 86400000))
    ].filter((v,i,a) => a.indexOf(v) === i);

    let allEvents = [];
    for (const date of dates) {
      try {
        const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=${date}&limit=50&groups=100`;
        const data = await fetchJSON(url);
        if (data.events) allEvents = allEvents.concat(data.events);
      } catch {}
    }

    let updated = false;

    for (const event of allEvents) {
      const comp = event.competitions?.[0];
      if (!comp || comp.status?.type?.name !== 'STATUS_FINAL') continue;
      const c = comp.competitors;
      if (!c || c.length !== 2) continue;

      const t1Name = c[0].team?.displayName || c[0].team?.name || '';
      const t2Name = c[1].team?.displayName || c[1].team?.name || '';
      const t1Info = findBracketTeam(t1Name);
      const t2Info = findBracketTeam(t2Name);
      if (!t1Info || !t2Info) continue;

      const t1Score = parseInt(c[0].score);
      const t2Score = parseInt(c[1].score);
      const winnerInfo = t1Score > t2Score ? t1Info : t2Info;

      const gameId = identifyGame(t1Info, t2Info, resultsCache.results);
      if (!gameId || resultsCache.results[gameId]) continue;

      console.log(`  Result: ${winnerInfo.seedName} wins (${gameId})`);
      resultsCache.results[gameId] = winnerInfo.seedName;
      updated = true;

      if (gameId === 'champ') {
        resultsCache.finalScore = { team1: Math.max(t1Score, t2Score), team2: Math.min(t1Score, t2Score) };
      }
    }

    if (updated) {
      resultsCache.lastUpdated = new Date().toISOString();
      await saveResultsToCloud();
      console.log('  Results updated and saved to cloud!');
    } else {
      console.log('  No new results');
    }
  } catch (err) {
    console.error('ESPN fetch error:', err.message);
  }
}

// ============================================================
// HTTP SERVER
// ============================================================
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function sendJSON(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // API Routes
  if (pathname === '/api/entries' && method === 'GET') {
    return sendJSON(res, 200, readEntries());
  }

  if (pathname === '/api/entries' && method === 'POST') {
    const body = await readBody(req);
    if (!body.name?.trim()) return sendJSON(res, 400, { error: 'Name required' });
    if (!body.picks) return sendJSON(res, 400, { error: 'Picks required' });
    const entries = readEntries();
    const entry = {
      id: Date.now(),
      name: body.name.trim(),
      picks: body.picks,
      tiebreaker: parseInt(body.tiebreaker) || 0,
      submittedAt: new Date().toISOString()
    };
    entries.push(entry);
    await writeEntries(entries);
    return sendJSON(res, 201, entry);
  }

  if (pathname.startsWith('/api/entries/') && method === 'DELETE') {
    const id = parseInt(pathname.split('/').pop());
    let entries = readEntries();
    const before = entries.length;
    entries = entries.filter(e => e.id !== id);
    if (entries.length === before) return sendJSON(res, 404, { error: 'Not found' });
    await writeEntries(entries);
    return sendJSON(res, 200, { success: true });
  }

  if (pathname === '/api/results' && method === 'GET') {
    return sendJSON(res, 200, readResults());
  }

  if (pathname === '/api/results' && method === 'POST') {
    const body = await readBody(req);
    if (body.gameId && body.winner) {
      resultsCache.results[body.gameId] = body.winner;
      resultsCache.lastUpdated = new Date().toISOString();
    }
    await writeResults(resultsCache);
    return sendJSON(res, 200, resultsCache);
  }

  if (pathname === '/api/results/final-score' && method === 'POST') {
    const body = await readBody(req);
    resultsCache.finalScore = { team1: parseInt(body.team1), team2: parseInt(body.team2) };
    resultsCache.lastUpdated = new Date().toISOString();
    await writeResults(resultsCache);
    return sendJSON(res, 200, resultsCache);
  }

  if (pathname === '/api/refresh' && method === 'POST') {
    await fetchESPNScores();
    return sendJSON(res, 200, readResults());
  }

  // Static files
  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// ============================================================
// STARTUP
// ============================================================
(async () => {
  console.log('\nLoading data from cloud storage...');
  await loadEntriesFromCloud();
  await loadResultsFromCloud();

  server.listen(PORT, () => {
    console.log(`\n\uD83C\uDFC0 Janpa's Madness is running at http://localhost:${PORT}`);
    console.log(`  Cloud storage: jsonblob.com`);
    console.log(`  Entries blob: ${ENTRIES_BLOB_ID}`);
    console.log(`  Results blob: ${RESULTS_BLOB_ID}\n`);
    console.log('Fetching initial scores from ESPN...');
    fetchESPNScores();
    // Poll ESPN every 2 minutes
    setInterval(() => {
      console.log(`[${new Date().toLocaleTimeString()}] Checking ESPN for updates...`);
      fetchESPNScores();
    }, 2 * 60 * 1000);
  });
})();

