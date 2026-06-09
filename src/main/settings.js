"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { app } = require("electron");

const SETTINGS_FILE = "settings.json";

// Permite que o processo principal reaja a troca da pasta de dados
// (ex.: reposicionar o file watcher na nova pasta).
const events = new EventEmitter();

const FILE_NAMES = {
  materials: "materiais.csv",
  agencies: "agencias.csv",
  rentals: "alugueis.csv",
  rentalItems: "itens_aluguel.csv",
  attachments: "anexos_aluguel.csv",
};

// Nomes dos arquivos no formato antigo (virgula + cabecalhos em ingles),
// usados apenas para migracao automatica.
const LEGACY_FILE_NAMES = {
  materials: "materials.csv",
  agencies: "agencies.csv",
  rentals: "rentals.csv",
};

function settingsPath() {
  return path.join(app.getPath("userData"), SETTINGS_FILE);
}

function defaultDataDir() {
  // Pasta padrao no primeiro uso. O usuario normalmente troca isto para uma
  // pasta sincronizada (OneDrive/Drive/Dropbox) nas Configuracoes.
  return path.join(app.getPath("userData"), "dados");
}

function readRaw() {
  try {
    const txt = fs.readFileSync(settingsPath(), "utf8");
    const parsed = JSON.parse(txt);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_err) {
    return {};
  }
}

let cache = null;

function load() {
  if (cache) return cache;
  const raw = readRaw();
  const settings = {
    dataDir: typeof raw.dataDir === "string" && raw.dataDir.trim() ? raw.dataDir : defaultDataDir(),
    userId: typeof raw.userId === "string" && raw.userId.trim() ? raw.userId : crypto.randomUUID(),
  };
  cache = settings;
  // Persiste imediatamente para fixar o userId gerado no primeiro uso.
  persist();
  return cache;
}

function persist() {
  if (!cache) return;
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(cache, null, 2), "utf8");
}

function getDataDir() {
  return load().dataDir;
}

function setDataDir(dir) {
  load();
  cache.dataDir = dir;
  persist();
  events.emit("dataDirChanged", cache.dataDir);
  return cache.dataDir;
}

function getUserId() {
  return load().userId;
}

function csvPaths() {
  const dir = getDataDir();
  return {
    materials: path.join(dir, FILE_NAMES.materials),
    agencies: path.join(dir, FILE_NAMES.agencies),
    rentals: path.join(dir, FILE_NAMES.rentals),
    rentalItems: path.join(dir, FILE_NAMES.rentalItems),
    attachments: path.join(dir, FILE_NAMES.attachments),
  };
}

function legacyCsvPaths() {
  const dir = getDataDir();
  return {
    materials: path.join(dir, LEGACY_FILE_NAMES.materials),
    agencies: path.join(dir, LEGACY_FILE_NAMES.agencies),
    rentals: path.join(dir, LEGACY_FILE_NAMES.rentals),
  };
}

module.exports = {
  FILE_NAMES,
  LEGACY_FILE_NAMES,
  events,
  load,
  getDataDir,
  setDataDir,
  getUserId,
  csvPaths,
  legacyCsvPaths,
  defaultDataDir,
};
