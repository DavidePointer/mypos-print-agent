const express    = require("express");
const net        = require("net");
const sharp      = require("sharp");
const os         = require("os");
const fs         = require("fs");
const path       = require("path");
const pollWorker = require("./pollWorker");

const PORT = 8888;
let server = null;

const status = {
  printCount: 0,
  lastPrint: null,
  lastError: null,
};

// ── Config persistence (#161) ─────────────────────────────────────
// Salva/carica credenziali Supabase su disco: il poll loop sopravvive
// al riavvio del PC senza richiedere una nuova chiamata /configure.
const CONFIG_PATH = path.join(
  process.env.APPDATA || os.homedir(),
  "ComandaPrintAgent",
  "supabase-config.json"
);

function saveConfig(config) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config), "utf8");
  } catch (e) {
    console.warn("[Config] Salvataggio fallito:", e.message);
  }
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    console.warn("[Config] Caricamento fallito:", e.message);
    return null;
  }
}

function startPollLoop(config) {
  pollWorker.start(config, (result) => {
    if (result.success) status.printCount++;
    status.lastPrint = new Date().toISOString();
    if (!result.success) status.lastError = result.error;
  });
}

const app = express();

// ── CORS + Private Network Access ─────────────────────────────────────────────
// Da Chrome 94+ la specifica "Private Network Access" aggiunge un preflight
// OPTIONS con header `Access-Control-Request-Private-Network: true`.
// Il server DEVE rispondere con `Access-Control-Allow-Private-Network: true`,
// altrimenti Chrome blocca ogni fetch da https://swcomanda.com verso localhost
// indipendentemente dal CORS generico già presente.
// Senza questo header: banner sempre "offline", comande mai ricevute.
// ─────────────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Private-Network", "true"); // ← fix PNA
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "10mb" }));

app.get("/status", (req, res) => {
  res.json({
    status: "ok",
    version: "1.2.0",
    printCount: status.printCount,
    lastPrint: status.lastPrint,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /scan-network?base=192.168.1&start=1&end=50&port=9100&timeout=500
 * Scansiona un range di IP alla ricerca di stampanti ESC/POS raggiungibili via TCP.
 * Eseguito in batch da 10 IP paralleli per non saturare la rete.
 *
 * Risposta: { discovered: [{ ip, port }, ...] }
 */
app.get("/scan-network", async (req, res) => {
  const { base, start, end, port = "9100", timeout = "500" } = req.query;
  if (!base || !start || !end) {
    return res.status(400).json({ error: "base, start, end obbligatori" });
  }

  const from = parseInt(start);
  const to = parseInt(end);
  const tcpPort = parseInt(port);
  const tcpTimeout = parseInt(timeout);

  if (isNaN(from) || isNaN(to) || isNaN(tcpPort) || to < from || to - from > 254) {
    return res.status(400).json({ error: "Parametri non validi" });
  }

  console.log(`🔍 Scan rete ${base}.${from}–${base}.${to}:${tcpPort}`);

  const probe = (ip) =>
    new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(tcpTimeout);
      sock.connect(tcpPort, ip, () => {
        sock.destroy();
        resolve({ ip, port: tcpPort });
      });
      sock.on("error", () => resolve(null));
      sock.on("timeout", () => { sock.destroy(); resolve(null); });
    });

  const discovered = [];
  const BATCH = 10;
  for (let i = from; i <= to; i += BATCH) {
    const batch = [];
    for (let j = i; j < Math.min(i + BATCH, to + 1); j++) {
      batch.push(probe(`${base}.${j}`));
    }
    const results = await Promise.all(batch);
    discovered.push(...results.filter(Boolean));
  }

  console.log(`✅ Scan completato: ${discovered.length} stampant${discovered.length === 1 ? "e" : "i"} trovat${discovered.length === 1 ? "a" : "e"}`);
  res.json({ discovered });
});

/**
 * GET /test-printer?ip=192.168.1.100&port=9100
 * Testa la connessione TCP a una stampante senza inviare dati.
 * Usato dalla cassa al primo avvio per verificare che tutte le
 * stampanti siano raggiungibili prima di iniziare il servizio.
 *
 * Risposta: { reachable: true } oppure { reachable: false, error: "..." }
 */
app.get("/test-printer", (req, res) => {
  const { ip, port } = req.query;
  if (!ip) return res.status(400).json({ reachable: false, error: "ip obbligatorio" });

  const tcpPort = parseInt(port) || 9100;
  console.log(`🔍 Test connessione → ${ip}:${tcpPort}`);

  testConnection(ip, tcpPort)
    .then(() => {
      console.log(`✅ ${ip}:${tcpPort} raggiungibile`);
      res.json({ reachable: true });
    })
    .catch((err) => {
      console.log(`❌ ${ip}:${tcpPort} non raggiungibile — ${err.message}`);
      res.json({ reachable: false, error: err.message });
    });
});

// ── POST /configure (#161) ─────────────────────────────────────
// Riceve credenziali Supabase dalla PWA e avvia il polling autonomo.
// Payload: { supabase_url, supabase_anon_key, restaurant_id, device_id,
//            access_token, refresh_token }
app.post("/configure", (req, res) => {
  const { supabase_url, supabase_anon_key, restaurant_id, device_id, access_token, refresh_token } = req.body;

  if (!supabase_url || !supabase_anon_key || !restaurant_id || !device_id || !access_token || !refresh_token) {
    return res.status(400).json({ error: "Campi obbligatori mancanti" });
  }

  const config = {
    supabaseUrl:     supabase_url,
    supabaseAnonKey: supabase_anon_key,
    restaurantId:    restaurant_id,
    deviceId:        device_id,
    accessToken:     access_token,
    refreshToken:    refresh_token,
  };

  saveConfig(config);
  startPollLoop(config);

  console.log(`✅ /configure OK — restaurant=${restaurant_id} device=${device_id}`);
  res.json({ success: true });
});

app.post("/print", async (req, res) => {
  const { printerIp, printerPort, imageBase64, printerName } = req.body;

  if (!printerIp || !imageBase64) {
    return res.status(400).json({ error: "printerIp e imageBase64 obbligatori" });
  }

  const port = printerPort || 9100;
  console.log(`🖨️  Stampa su ${printerName || "?"} (${printerIp}:${port})`);

  try {
    const imgBuffer = Buffer.from(imageBase64, "base64");
    const escposData = await buildEscPosRaster(imgBuffer);
    await sendToPrinter(printerIp, port, escposData);

    status.printCount++;
    status.lastPrint = new Date().toISOString();
    status.lastError = null;

    console.log(`✅ Stampato con successo (totale: ${status.printCount})`);
    res.json({ success: true });
  } catch (err) {
    status.lastError = err.message;
    console.error(`❌ Errore stampa:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

async function buildEscPosRaster(pngBuffer) {
  const image = sharp(pngBuffer).grayscale().flatten({ background: "#ffffff" });
  const metadata = await image.metadata();

  let width = metadata.width;
  const widthBytes = Math.ceil(width / 8);
  const alignedWidth = widthBytes * 8;

  const resized = alignedWidth !== width
    ? image.resize(alignedWidth, null, { fit: "fill" })
    : image;

  const { data, info } = await resized.raw().toBuffer({ resolveWithObject: true });
  const height = info.height;

  const bitmapBytes = widthBytes * height;
  const bitmap = Buffer.alloc(bitmapBytes);

  for (let row = 0; row < height; row++) {
    for (let byteIdx = 0; byteIdx < widthBytes; byteIdx++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const pixelX = byteIdx * 8 + bit;
        if (pixelX < info.width) {
          const pixelValue = data[row * info.width + pixelX];
          if (pixelValue < 128) byte |= (0x80 >> bit);
        }
      }
      bitmap[row * widthBytes + byteIdx] = byte;
    }
  }

  const chunks = [];
  chunks.push(Buffer.from([0x1b, 0x40])); // ESC @ - Reset
  const xL = widthBytes & 0xff;
  const xH = (widthBytes >> 8) & 0xff;
  const yL = height & 0xff;
  const yH = (height >> 8) & 0xff;
  chunks.push(Buffer.from([0x1d, 0x76, 0x30, 0x00, xL, xH, yL, yH])); // GS v 0
  chunks.push(bitmap);
  chunks.push(Buffer.from([0x0a, 0x0a, 0x0a, 0x0a])); // avanzamento carta
  chunks.push(Buffer.from([0x1d, 0x56, 0x42, 0x03])); // taglio parziale

  return Buffer.concat(chunks);
}

/**
 * Testa la connessione TCP senza inviare dati.
 * Apre il socket, aspetta che sia connesso, poi lo chiude subito.
 * Timeout 3 secondi.
 */
function testConnection(ip, port) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    client.setTimeout(3000);
    client.connect(port, ip, () => {
      client.destroy();
      resolve();
    });
    client.on("error", (err) => { client.destroy(); reject(err); });
    client.on("timeout", () => { client.destroy(); reject(new Error("Timeout connessione (3s)")); });
  });
}

function sendToPrinter(ip, port, data) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    client.setTimeout(5000);
    client.connect(port, ip, () => {
      client.write(data, () => {
        client.end();
        resolve();
      });
    });
    client.on("error", (err) => { client.destroy(); reject(err); });
    client.on("timeout", () => { client.destroy(); reject(new Error("Timeout connessione stampante")); });
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`\n🖨️  MyPos Print Agent v1.2.0 attivo su http://localhost:${PORT}\n`);

      // #161 — Riprendi il polling se il PC era già stato configurato (riavvio)
      const savedConfig = loadConfig();
      if (savedConfig) {
        console.log("[Config] Configurazione Supabase trovata — avvio poll loop automatico");
        startPollLoop(savedConfig);
      }

      resolve();
    });
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Porta ${PORT} già in uso. Chiudi l'altra istanza del Print Agent.`));
      } else {
        reject(err);
      }
    });
  });
}

function stopServer() {
  pollWorker.stop();
  if (server) {
    server.close();
    server = null;
    console.log("🛑 Server fermato");
  }
}

function getStatus() {
  return { ...status, pollLoopRunning: pollWorker.isRunning() };
}

module.exports = { startServer, stopServer, getStatus };
