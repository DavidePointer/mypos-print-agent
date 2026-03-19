const { app } = require("electron");
const path = require("path");

const APP_NAME = "MyPos Print Agent";

function setupAutoLaunch() {
  // Abilita avvio automatico di default alla prima installazione
  if (!app.isPackaged) return;

  const loginSettings = app.getLoginItemSettings();
  if (!loginSettings.wasOpenedAtLogin) {
    // Prima volta: abilita avvio automatico
    if (!loginSettings.openAtLogin) {
      setAutoLaunch(true);
    }
  }
}

function isAutoLaunchEnabled() {
  if (!app.isPackaged) return false;
  const settings = app.getLoginItemSettings();
  return settings.openAtLogin;
}

function setAutoLaunch(enabled) {
  if (!app.isPackaged) return;

  app.setLoginItemSettings({
    openAtLogin: enabled,
    name: APP_NAME,
    args: ["--hidden"],
  });
}

module.exports = { setupAutoLaunch, isAutoLaunchEnabled, setAutoLaunch };
