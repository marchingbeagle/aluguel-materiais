"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const LOCK_NAME = ".app.lock";
// Um lock cujo heartbeat esteja mais velho que isto e considerado orfao
// (ex.: app fechou no meio de uma escrita) e pode ser reivindicado.
const STALE_MS = 15000;
// Quanto tempo tentar adquirir antes de desistir.
const ACQUIRE_TIMEOUT_MS = 4000;
const RETRY_INTERVAL_MS = 150;

class LockBusyError extends Error {
  constructor(holder) {
    super("Outro usuario esta salvando, tente novamente em instantes.");
    this.name = "LockBusyError";
    this.code = "LOCK_BUSY";
    this.holder = holder;
  }
}

function lockPath(dir) {
  return path.join(dir, LOCK_NAME);
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isStale(info) {
  if (!info || typeof info.heartbeatAt !== "number") return true;
  return Date.now() - info.heartbeatAt > STALE_MS;
}

function writeLockFile(file, userId) {
  const payload = {
    userId,
    host: os.hostname(),
    pid: process.pid,
    acquiredAt: Date.now(),
    heartbeatAt: Date.now(),
  };
  // Flag "wx": falha se o arquivo ja existir -> garante exclusao mutua.
  const fd = fs.openSync(file, "wx");
  try {
    fs.writeFileSync(fd, JSON.stringify(payload));
  } finally {
    fs.closeSync(fd);
  }
  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Adquire o lock. Retorna um handle com heartbeat() e release().
async function acquire(dir, userId) {
  fs.mkdirSync(dir, { recursive: true });
  const file = lockPath(dir);
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;

  for (;;) {
    try {
      writeLockFile(file, userId);
      return makeHandle(file, userId);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;

      const existing = readLock(file);
      if (isStale(existing)) {
        // Lock orfao: remove e tenta de novo no proximo laco.
        try {
          fs.unlinkSync(file);
        } catch {
          // Outro processo pode ter removido o lock antes desta tentativa.
        }
        continue;
      }

      if (Date.now() >= deadline) {
        throw new LockBusyError(existing);
      }
      await sleep(RETRY_INTERVAL_MS);
    }
  }
}

function makeHandle(file, userId) {
  let released = false;
  return {
    // Atualiza o heartbeat durante operacoes mais longas.
    heartbeat() {
      if (released) return;
      const info = readLock(file);
      if (info && info.userId === userId) {
        info.heartbeatAt = Date.now();
        try {
          fs.writeFileSync(file, JSON.stringify(info));
        } catch {
          // Heartbeat e melhor-esforco; a proxima operacao valida o lock.
        }
      }
    },
    release() {
      if (released) return;
      released = true;
      const info = readLock(file);
      // So remove se ainda formos o dono (evita apagar lock de outro processo).
      if (!info || info.userId === userId) {
        try {
          fs.unlinkSync(file);
        } catch {
          // Release tolerante: o lock pode ja ter sido removido.
        }
      }
    },
  };
}

// Executa fn() com o lock adquirido, garantindo a liberacao no finally.
async function withLock(dir, userId, fn) {
  const handle = await acquire(dir, userId);
  try {
    return await fn(handle);
  } finally {
    handle.release();
  }
}

module.exports = {
  LOCK_NAME,
  LockBusyError,
  acquire,
  withLock,
};
