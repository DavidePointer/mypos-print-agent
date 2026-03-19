# MyPos Print Agent — Desktop App

App Electron che fa girare il server di stampa ESC/POS in background,
con icona nel system tray di Windows.

## Funzionalità

- 🖨️ Server HTTP sulla porta 8888 per stampa comande ESC/POS
- 🔄 Avvio automatico con Windows (abilitabile dal menu tray)
- 📊 Finestra di stato con log attività (doppio click sull'icona)
- 🚫 Singola istanza (impedisce duplicati)
- ✂️ Taglio automatico carta dopo ogni comanda

## Sviluppo

```bash
npm install
npm start
```

## Build installer Windows

```bash
npm run build
```

Produce: `dist/MyPos Print Agent Setup 1.0.0.exe`

## Build portabile (no installer)

```bash
npm run build-portable
```

## Icona

Metti il file `assets/icon.ico` (256x256, formato .ico multi-risoluzione).
Puoi generarla da un PNG con: https://icoconvert.com/

## API

### GET /status
```json
{ "status": "ok", "version": "1.0.0", "printCount": 42, "lastPrint": "2025-01-01T12:00:00Z" }
```

### POST /print
```json
{
  "printerIp": "192.168.1.100",
  "printerPort": 9100,
  "imageBase64": "...",
  "printerName": "Cucina"
}
```

## Deploy cliente

1. Installa `MyPos Print Agent Setup 1.0.0.exe` sul PC cassa
2. L'app si avvia automaticamente con Windows
3. L'icona 🖨️ appare nel system tray in basso a destra
4. Su MyPos, nelle impostazioni stampanti, verifica che l'URL del Print Agent sia `http://localhost:8888`
