const { autoUpdater } = require("electron-updater");
const { dialog, app } = require("electron");

let updateCheckInterval = null;

function setupUpdater(trayRef, updateTrayMenuFn) {
  // Log aggiornamenti in console
  autoUpdater.logger = console;
  autoUpdater.autoDownload = true;        // scarica automaticamente in background
  autoUpdater.autoInstallOnAppQuit = true; // installa quando si chiude l'app

  // Aggiornamento disponibile → scarica in background silenziosamente
  autoUpdater.on("update-available", (info) => {
    console.log(`🔄 Aggiornamento disponibile: v${info.version}`);
    if (updateTrayMenuFn) updateTrayMenuFn(`🔄 Download aggiornamento v${info.version}...`);
  });

  // Nessun aggiornamento
  autoUpdater.on("update-not-available", () => {
    console.log("✅ App aggiornata all'ultima versione");
  });

  // Progresso download
  autoUpdater.on("download-progress", (progress) => {
    const pct = Math.round(progress.percent);
    if (pct % 20 === 0) {
      console.log(`⬇️  Download: ${pct}%`);
    }
  });

  // Aggiornamento scaricato → avvisa l'utente
  autoUpdater.on("update-downloaded", (info) => {
    console.log(`✅ Aggiornamento v${info.version} pronto — verrà installato alla prossima chiusura`);
    if (updateTrayMenuFn) updateTrayMenuFn(`✅ v${info.version} pronta — riavvia per installare`);

    // Notifica discreta: click destro tray → installa ora
    if (trayRef) {
      trayRef.setToolTip(`MyPos Print Agent — v${info.version} disponibile!\nClick destro per installare`);
    }
  });

  // Errore update (non bloccante)
  autoUpdater.on("error", (err) => {
    // Ignora errori di rete — riproverà al prossimo check
    console.warn("⚠️  Errore check aggiornamenti:", err.message);
  });

  // Primo check dopo 10 secondi dall'avvio
  setTimeout(() => {
    checkForUpdates();
  }, 10000);

  // Check automatico ogni 4 ore
  updateCheckInterval = setInterval(() => {
    checkForUpdates();
  }, 4 * 60 * 60 * 1000);
}

function checkForUpdates() {
  if (!app.isPackaged) {
    console.log("⚠️  Auto-update disabilitato in sviluppo");
    return;
  }
  autoUpdater.checkForUpdates().catch((err) => {
    console.warn("Check update fallito:", err.message);
  });
}

function installUpdateNow() {
  autoUpdater.quitAndInstall(false, true);
}

function stopUpdater() {
  if (updateCheckInterval) {
    clearInterval(updateCheckInterval);
    updateCheckInterval = null;
  }
}

module.exports = { setupUpdater, checkForUpdates, installUpdateNow, stopUpdater };
