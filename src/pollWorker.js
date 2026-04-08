/**
 * pollWorker.js — Windows Print Agent Poll Loop (#161)
 *
 * Equivalente Node.js di SupabasePollWorker.kt (Android).
 * Flusso per ogni ciclo (ogni 2s):
 *   1. Fetch jobs: pending pronti + claimed con heartbeat scaduto (watchdog)
 *   2. Per ogni job: claim atomico → heartbeat loop → stampa → aggiorna stato
 *   3. Backoff su fallimento: 5s al 1° retry, 15s al 2°, error definitivo al 3°
 *
 * DEBUG: tutti i log vengono scritti su C:\Users\david\poll-debug.txt
 */

const https  = require('https');
const http   = require('http');
const net    = require('net');
const sharp  = require('sharp');
const fs     = require('fs');

const HEARTBEAT_INTERVAL_MS = 10_000;
const WATCHDOG_THRESHOLD_S  = 30;
const LOG_FILE              = 'C:\\Users\\david\\poll-debug.txt';

// ── Logger su file ────────────────────────────────────────────────

function log(msg) {
  const line = new Date().toISOString() + ' ' + msg + '\n';
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {
    // silenzioso — non bloccare il poll loop se il log fallisce
  }
  console.log(msg);
}

// Inizializzazione: scrivi riga di avvio nel file di log
log('═══════════════════════════════════════════');
log('[PollWorker] File logging attivato');

// ── Helpers ──────────────────────────────────────────────────────

function iso(offsetSeconds = 0) {
  return new Date(Date.now() + offsetSeconds * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
}

// HTTP client minimale — stessa filosofia di SupabaseClient.kt
function supabaseRequest(config, method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(config.supabaseUrl + urlPath);
    } catch (e) {
      log(`[supabaseRequest] URL non valido: "${config.supabaseUrl + urlPath}" — ${e.message}`);
      return reject(e);
    }

    const isHttps = url.protocol === 'https:';
    const mod     = isHttps ? https : http;

    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      'apikey':        config.supabaseAnonKey,
      'Authorization': `Bearer ${config.accessToken}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=representation,count=exact',
    };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    log(`[supabaseRequest] ${method} ${url.hostname}${url.pathname}${url.search}`);

    const req = mod.request(
      {
        hostname: url.hostname,
        port:     url.port || (isHttps ? 443 : 80),
        path:     url.pathname + url.search,
        method,
        headers,
        timeout: 10_000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end',  () => {
          log(`[supabaseRequest] → HTTP ${res.statusCode}, body.length=${data.length}`);
          resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
        });
      }
    );

    req.on('error',   (e) => { log(`[supabaseRequest] ERRORE rete: ${e.message}`); reject(e); });
    req.on('timeout', () => { req.destroy(); log('[supabaseRequest] TIMEOUT 10s'); reject(new Error('Timeout Supabase')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Fetch jobs ───────────────────────────────────────────────────

async function fetchJobs(config) {
  const now            = iso();
  const watchdogCutoff = iso(-WATCHDOG_THRESHOLD_S);
  const rid            = config.restaurantId;

  const pendingPath = `/rest/v1/print_jobs` +
    `?restaurant_id=eq.${rid}` +
    `&status=eq.pending` +
    `&or=(next_retry_at.is.null,next_retry_at.lte.${now})` +
    `&order=created_at.asc&limit=5`;

  const stalePath = `/rest/v1/print_jobs` +
    `?restaurant_id=eq.${rid}` +
    `&status=eq.claimed` +
    `&claim_heartbeat=lt.${watchdogCutoff}` +
    `&order=created_at.asc&limit=5`;

  const byId = new Map();

  for (const [label, p] of [['pending', pendingPath], ['stale', stalePath]]) {
    try {
      const res = await supabaseRequest(config, 'GET', p);
      if (res.statusCode === 200) {
        let jobs;
        try {
          jobs = JSON.parse(res.body);
        } catch (e) {
          log(`[fetchJobs] Errore parsing JSON (${label}): ${e.message}`);
          log(`[fetchJobs] body raw: ${res.body.substring(0, 200)}`);
          continue;
        }
        log(`[fetchJobs] ${label}: ${jobs.length} job trovati`);
        for (const job of jobs) {
          // Log diagnostico per ogni job
          const hasImage   = job.image_base64 ? `sì (${job.image_base64.length} chars)` : 'NO ⚠️';
          const printerIp  = (job.payload || {}).printerIp || 'MANCANTE ⚠️';
          log(`[fetchJobs]   job ${job.id} | status=${job.status} | attempt=${job.attempt_count} | has_image=${hasImage} | printerIp=${printerIp}`);
          byId.set(job.id, job);
        }
      } else {
        log(`[fetchJobs] HTTP ${res.statusCode} per query ${label}`);
        log(`[fetchJobs] body: ${res.body.substring(0, 300)}`);
      }
    } catch (e) {
      log(`[fetchJobs] eccezione (${label}): ${e.message}`);
    }
  }

  const sorted = [...byId.values()]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, 5);

  log(`[fetchJobs] totale da processare: ${sorted.length}`);
  return sorted;
}

// ── Claim atomico ────────────────────────────────────────────────
// PostgREST non supporta or=(...) nested su PATCH — solo su GET.
// Usiamo due PATCH semplici: prima tenta pending, poi watchdog.

async function claimJob(config, jobId) {
  const now            = iso();
  const watchdogCutoff = iso(-WATCHDOG_THRESHOLD_S);
  const body           = { status: 'claimed', claimed_by: config.deviceId, claim_heartbeat: now };

  // Tentativo 1: claim se il job è pending
  try {
    const res = await supabaseRequest(
      config, 'PATCH',
      `/rest/v1/print_jobs?id=eq.${jobId}&status=eq.pending`,
      body
    );
    const cr = res.headers['content-range'] || '';
    log(`[claimJob] pending — HTTP ${res.statusCode}, content-range: "${cr}"`);
    if (res.statusCode >= 400) log(`[claimJob] pending errore body: ${res.body}`);
    if (cr.includes('/1')) return true;
  } catch (e) {
    log(`[claimJob] eccezione pending job ${jobId}: ${e.message}`);
  }

  // Tentativo 2: watchdog — claim se claimed con heartbeat scaduto
  try {
    const res = await supabaseRequest(
      config, 'PATCH',
      `/rest/v1/print_jobs?id=eq.${jobId}&status=eq.claimed&claim_heartbeat=lt.${watchdogCutoff}`,
      body
    );
    const cr = res.headers['content-range'] || '';
    log(`[claimJob] watchdog — HTTP ${res.statusCode}, content-range: "${cr}"`);
    if (res.statusCode >= 400) log(`[claimJob] watchdog errore body: ${res.body}`);    if (cr.includes('/1')) return true;
  } catch (e) {
    log(`[claimJob] eccezione watchdog job ${jobId}: ${e.message}`);
  }

  log(`[claimJob] job ${jobId} non claimabile`);
  return false;
}

// ── Heartbeat ────────────────────────────────────────────────────

function startHeartbeat(config, jobId) {
  return setInterval(async () => {
    try {
      await supabaseRequest(
        config, 'PATCH',
        `/rest/v1/print_jobs?id=eq.${jobId}&claimed_by=eq.${config.deviceId}`,
        { claim_heartbeat: iso() }
      );
      log(`[heartbeat] job ${jobId} OK`);
    } catch (e) {
      log(`[heartbeat] errore job ${jobId}: ${e.message}`);
    }
  }, HEARTBEAT_INTERVAL_MS);
}

// ── Stampa ───────────────────────────────────────────────────────

async function printJob(job) {
  log(`[printJob] inizio job ${job.id}`);

  // Verifica image_base64
  const imageBase64 = job.image_base64;
  if (!imageBase64) {
    log(`[printJob] ⚠️ image_base64 MANCANTE — job ${job.id}. Campi disponibili: ${Object.keys(job).join(', ')}`);
    return false;
  }
  log(`[printJob] image_base64 presente: ${imageBase64.length} caratteri`);

  // Verifica printerIp
  const payload     = job.payload || {};
  const printerIp   = payload.printerIp;
  const printerPort = payload.printerPort || 9100;

  if (!printerIp) {
    log(`[printJob] ⚠️ printerIp MANCANTE — job ${job.id}. payload keys: ${Object.keys(payload).join(', ')}`);
    log(`[printJob] payload completo: ${JSON.stringify(payload).substring(0, 500)}`);
    return false;
  }
  log(`[printJob] stampante: ${printerIp}:${printerPort}`);

  // Decodifica base64
  let imgBuffer;
  try {
    imgBuffer = Buffer.from(imageBase64, 'base64');
    log(`[printJob] buffer decodificato: ${imgBuffer.length} bytes`);
  } catch (e) {
    log(`[printJob] errore decodifica base64: ${e.message}`);
    return false;
  }

  // Conversione ESC/POS
  let escposData;
  try {
    log(`[printJob] inizio conversione ESC/POS con sharp`);
    escposData = await buildEscPosRaster(imgBuffer);
    log(`[printJob] ESC/POS pronto: ${escposData.length} bytes`);
  } catch (e) {
    log(`[printJob] errore buildEscPosRaster: ${e.message}`);
    log(`[printJob] stack: ${e.stack}`);
    return false;
  }

  // Invio TCP
  try {
    log(`[printJob] connessione TCP a ${printerIp}:${printerPort}`);
    await sendToPrinter(printerIp, printerPort, escposData);
    log(`[printJob] ✅ TCP inviato con successo`);
    return true;
  } catch (e) {
    log(`[printJob] ❌ errore TCP: ${e.message}`);
    return false;
  }
}

// ── Mark done / failed ───────────────────────────────────────────

async function markDone(config, jobId) {
  try {
    const res = await supabaseRequest(config, 'PATCH', `/rest/v1/print_jobs?id=eq.${jobId}`, {
      status: 'done', printed_at: iso(), claimed_by: null, claim_heartbeat: null,
    });
    log(`[markDone] job ${jobId} → HTTP ${res.statusCode}`);
  } catch (e) { log(`[markDone] errore job ${jobId}: ${e.message}`); }
}

async function markFailed(config, jobId, attemptCount) {
  const newCount = attemptCount + 1;
  try {
    if (newCount >= 3) {
      const res = await supabaseRequest(config, 'PATCH', `/rest/v1/print_jobs?id=eq.${jobId}`, {
        status: 'error', attempt_count: newCount, claimed_by: null, claim_heartbeat: null,
      });
      log(`[markFailed] job ${jobId} → error definitivo dopo 3 tentativi (HTTP ${res.statusCode})`);
    } else {
      const delaySec = newCount === 1 ? 5 : 15;
      const res = await supabaseRequest(config, 'PATCH', `/rest/v1/print_jobs?id=eq.${jobId}`, {
        status: 'pending', attempt_count: newCount,
        claimed_by: null, claim_heartbeat: null,
        next_retry_at: iso(delaySec),
      });
      log(`[markFailed] job ${jobId} → retry tra ${delaySec}s (HTTP ${res.statusCode})`);
    }
  } catch (e) { log(`[markFailed] errore job ${jobId}: ${e.message}`); }
}

// ── ESC/POS (identico a server.js — nessuna dipendenza circolare) ─

async function buildEscPosRaster(pngBuffer) {
  const image    = sharp(pngBuffer).grayscale().flatten({ background: '#ffffff' });
  const metadata = await image.metadata();

  log(`[ESC/POS] immagine: ${metadata.width}×${metadata.height} px, format=${metadata.format}`);

  const widthBytes   = Math.ceil(metadata.width / 8);
  const alignedWidth = widthBytes * 8;
  const resized      = alignedWidth !== metadata.width
    ? image.resize(alignedWidth, null, { fit: 'fill' })
    : image;

  const { data, info } = await resized.raw().toBuffer({ resolveWithObject: true });
  const height         = info.height;
  const bitmap         = Buffer.alloc(widthBytes * height);

  log(`[ESC/POS] bitmap: ${widthBytes} bytes/riga × ${height} righe`);

  for (let row = 0; row < height; row++) {
    for (let byteIdx = 0; byteIdx < widthBytes; byteIdx++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const px = byteIdx * 8 + bit;
        if (px < info.width && data[row * info.width + px] < 128) byte |= (0x80 >> bit);
      }
      bitmap[row * widthBytes + byteIdx] = byte;
    }
  }

  const xL = widthBytes & 0xff, xH = (widthBytes >> 8) & 0xff;
  const yL = height & 0xff,     yH = (height >> 8) & 0xff;

  return Buffer.concat([
    Buffer.from([0x1b, 0x40]),
    Buffer.from([0x1d, 0x76, 0x30, 0x00, xL, xH, yL, yH]),
    bitmap,
    Buffer.from([0x0a, 0x0a, 0x0a, 0x0a]),
    Buffer.from([0x1d, 0x56, 0x42, 0x03]),
  ]);
}

function sendToPrinter(ip, port, data) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    client.setTimeout(5000);
    client.connect(port, ip, () => {
      log(`[TCP] connesso a ${ip}:${port} — invio ${data.length} bytes`);
      client.write(data, () => { client.end(); resolve(); });
    });
    client.on('error',   (e) => { client.destroy(); log(`[TCP] errore: ${e.message}`); reject(e); });
    client.on('timeout', ()  => { client.destroy(); log('[TCP] timeout 5s'); reject(new Error('Timeout stampante')); });
  });
}

// ── Loop principale ──────────────────────────────────────────────

let _pollTimer   = null;
let _isPolling   = false;
let _config      = null;
let _onResult    = null;
let _pollCount   = 0;

async function poll() {
  if (_isPolling || !_config) return;
  _isPolling = true;
  _pollCount++;

  // Log ogni 30 cicli (~60s) per confermare che il loop gira
  if (_pollCount % 30 === 1) {
    log(`[poll] ciclo #${_pollCount} — loop attivo, restaurant=${_config.restaurantId}`);
  }

  try {
    const jobs = await fetchJobs(_config);
    for (const job of jobs) {
      const jobId        = job.id;
      const attemptCount = job.attempt_count || 0;
      const printerName  = (job.payload || {}).printerName || 'Stampante';

      log(`[poll] processo job ${jobId} (tentativo ${attemptCount + 1}/3, printer="${printerName}")`);

      if (!await claimJob(_config, jobId)) {
        log(`[poll] job ${jobId} già preso da altro device — skip`);
        continue;
      }

      log(`[poll] job ${jobId} claimato OK — avvio heartbeat`);
      const heartbeat = startHeartbeat(_config, jobId);

      let ok = false;
      try {
        ok = await printJob(job);
      } catch (e) {
        log(`[poll] eccezione printJob ${jobId}: ${e.message}`);
        log(`[poll] stack: ${e.stack}`);
      }

      clearInterval(heartbeat);
      log(`[poll] heartbeat fermato per job ${jobId}`);

      if (ok) {
        await markDone(_config, jobId);
        log(`[poll] ✅ job ${jobId} DONE`);
        _onResult?.({ printerName, success: true });
      } else {
        await markFailed(_config, jobId, attemptCount);
        log(`[poll] ❌ job ${jobId} FAILED`);
        _onResult?.({ printerName, success: false, error: `Stampa fallita (tentativo ${attemptCount + 1}/3)` });
      }
    }
  } catch (e) {
    log(`[poll] errore loop principale: ${e.message}`);
    log(`[poll] stack: ${e.stack}`);
  } finally {
    _isPolling = false;
  }
}

// ── API pubblica ─────────────────────────────────────────────────

function start(config, onResult) {
  stop();
  _config    = config;
  _onResult  = onResult;
  _pollCount = 0;
  log(`[PollWorker] ══ AVVIATO ══ restaurant=${config.restaurantId} device=${config.deviceId}`);
  log(`[PollWorker] supabaseUrl=${config.supabaseUrl}`);
  log(`[PollWorker] anonKey=${config.supabaseAnonKey ? config.supabaseAnonKey.substring(0, 20) + '...' : 'VUOTA ⚠️'}`);
  log(`[PollWorker] accessToken=${config.accessToken ? config.accessToken.substring(0, 20) + '...' : 'VUOTO ⚠️'}`);
  poll(); // prima poll immediata
  _pollTimer = setInterval(poll, 2000);
}

function stop() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
    log('[PollWorker] fermato');
  }
  _config    = null;
  _isPolling = false;
}

function isRunning() { return _pollTimer !== null; }

module.exports = { start, stop, isRunning };
