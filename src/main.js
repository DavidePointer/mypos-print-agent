const { app, Tray, Menu, nativeImage, BrowserWindow } = require("electron");
const path = require("path");
const { startServer, stopServer, getStatus } = require("./server");
const { setupAutoLaunch, isAutoLaunchEnabled, setAutoLaunch } = require("./autolaunch");
const { setupUpdater, checkForUpdates, installUpdateNow, stopUpdater } = require("./updater");

// Impedisce finestre multiple
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let tray = null;
let statusWindow = null;
let serverRunning = false;
let updateMessage = null; // messaggio aggiornamento da mostrare nel menu

app.dock?.hide();

app.whenReady().then(async () => {
  try {
    await startServer();
    serverRunning = true;
  } catch (err) {
    console.error("Errore avvio server:", err);
    serverRunning = false;
  }

  createTray();
  setupAutoLaunch();

  // Avvia auto-updater passando riferimento al tray e callback menu
  setupUpdater(tray, (msg) => {
    updateMessage = msg;
    updateTrayMenu();
  });
});

app.on("window-all-closed", (e) => {
  e.preventDefault();
});

app.on("before-quit", () => {
  stopServer();
  stopUpdater();
});

function createTray() {
  const icon = nativeImage.createFromPath(getIconPath());
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("MyPos Print Agent");
  updateTrayMenu();
  tray.on("double-click", () => openStatusWindow());
}

function updateTrayMenu() {
  if (!tray) return;

  const statusLabel = serverRunning ? "🟢 Attivo — porta 8888" : "🔴 Non attivo";
  const { printCount } = getStatus();

  const template = [
    { label: "MyPos Print Agent", enabled: false },
    { type: "separator" },
    { label: statusLabel, enabled: false },
    { label: `Stampe oggi: ${printCount}`, enabled: false },
  ];

  // Mostra messaggio aggiornamento se disponibile
  if (updateMessage) {
    template.push({ type: "separator" });
    template.push({ label: updateMessage, enabled: false });
    template.push({
      label: "Installa aggiornamento ora",
      click: () => installUpdateNow(),
    });
  }

  template.push(
    { type: "separator" },
    { label: "Mostra stato", click: () => openStatusWindow() },
    {
      label: "Controlla aggiornamenti",
      click: () => {
        updateMessage = null;
        checkForUpdates();
      },
    },
    {
      label: "Avvio automatico con Windows",
      type: "checkbox",
      checked: isAutoLaunchEnabled(),
      click: (item) => { setAutoLaunch(item.checked); updateTrayMenu(); },
    },
    { type: "separator" },
    { label: "Esci", click: () => app.quit() }
  );

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function openStatusWindow() {
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.focus();
    return;
  }

  statusWindow = new BrowserWindow({
    width: 420,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "MyPos Print Agent",
    icon: getIconPath(),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    autoHideMenuBar: true,
  });

  statusWindow.loadFile(path.join(__dirname, "status.html"));
  statusWindow.on("closed", () => { statusWindow = null; });
}

function getIconPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "assets", "icon.ico");
  }
  return path.join(__dirname, "..", "assets", "icon.ico");
}
