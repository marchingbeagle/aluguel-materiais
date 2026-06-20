"use strict";

const path = require("path");
const fs = require("fs");
const { app, BrowserWindow } = require("electron");

const settings = require("./settings");
const ipc = require("./ipc");

let mainWindow = null;
let watcher = null;
let debounceTimer = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: "Aluguel de Materiais",
    backgroundColor: "#1e3314",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

// Observa a pasta de dados e avisa o renderer quando arquivos mudam
// (inclusive alteracoes vindas de outros PCs via sincronizacao em nuvem).
function setupWatcher() {
  if (watcher) {
    try {
      watcher.close();
    } catch {
      // Watcher ja encerrado ou indisponivel.
    }
    watcher = null;
  }

  const dir = settings.getDataDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    watcher = fs.watch(dir, (_eventType, filename) => {
      if (filename && !String(filename).endsWith(".csv")) return;

      // Ignora eventos disparados pela nossa propria escrita recente.
      if (Date.now() - ipc.getLastWriteAt() < 1500) return;

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("data:changed");
        }
      }, 800);
    });
  } catch (err) {
    // Sem watcher (ex.: pasta indisponivel) o app ainda funciona com refresh manual.
    console.error("Falha ao observar a pasta de dados:", err.message);
  }
}

app.whenReady().then(() => {
  try {
    settings.load();
    ipc.ensureAllFiles();
  } catch (err) {
    // Falha ao preparar os arquivos (ex.: pasta sem permissao). Registra e segue:
    // a janela ainda abre e o usuario pode ajustar a pasta nas Configuracoes.
    console.error("Erro ao preparar os arquivos de dados:", err);
  }
  ipc.registerIpc();
  createWindow();
  setupWatcher();

  // Reposiciona o watcher quando o usuario troca a pasta de dados.
  settings.events.on("dataDirChanged", () => setupWatcher());

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
