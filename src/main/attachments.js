"use strict";

// Gerenciamento dos arquivos anexados aos alugueis.
//
// Os arquivos sao COPIADOS para dentro da pasta de dados, em:
//   anexos/alugueis/<id_do_aluguel>/<nome_do_arquivo>
//
// No CSV (anexos_aluguel.csv) e gravado apenas o caminho RELATIVO a pasta de
// dados (com "/"), nunca um caminho absoluto, para que a pasta possa ser
// movida/sincronizada entre computadores sem quebrar os anexos.

const fs = require("fs");
const path = require("path");

const ATTACHMENTS_SUBDIR_PARTS = ["anexos", "alugueis"];

// Limites razoaveis para uma pasta sincronizada em nuvem.
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
const ALLOWED_EXTENSIONS = [
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "png", "jpg", "jpeg", "gif", "webp",
  "txt", "csv", "zip",
];

// Nomes reservados do Windows (CON, PRN, AUX, NUL, COM1.., LPT1..).
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function extensionOf(name) {
  return path.extname(String(name || "")).slice(1).toLowerCase();
}

function isAllowedExtension(name) {
  return ALLOWED_EXTENSIONS.includes(extensionOf(name));
}

function normalizeSeparators(value) {
  return String(value || "").replace(/\\/g, "/");
}

function isAbsolutePathAnyPlatform(value) {
  const text = String(value || "");
  return path.isAbsolute(text) || path.win32.isAbsolute(text) || path.posix.isAbsolute(text);
}

// Gera um nome de arquivo seguro para Windows/macOS/Linux a partir do nome
// original: remove diretorio, troca caracteres invalidos, limita o tamanho e
// evita nomes reservados. A extensao e normalizada para minusculas.
function sanitizeFileName(name) {
  let base = path.posix.basename(normalizeSeparators(name));
  base = base
    .split("")
    .map((ch) => (ch.charCodeAt(0) <= 31 || /[<>:"/\\|?*]/.test(ch) ? "_" : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  if (!base) base = "arquivo";
  const ext = path.extname(base).toLowerCase();
  let stem = path.basename(base, path.extname(base));
  if (WINDOWS_RESERVED.test(stem)) stem = `_${stem}`;
  if (stem.length > 80) stem = stem.slice(0, 80).trim();
  if (!stem) stem = "arquivo";
  return stem + ext;
}

// Evita sobrescrever arquivos ja existentes na pasta: "doc.pdf" -> "doc (2).pdf".
function uniqueNameIn(dir, fileName) {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  let candidate = fileName;
  for (let n = 2; fs.existsSync(path.join(dir, candidate)); n++) {
    candidate = `${stem} (${n})${ext}`;
  }
  return candidate;
}

// Caminho relativo canonico (sempre com "/") gravado no CSV.
function relPathFor(rentalId, fileName) {
  return [...ATTACHMENTS_SUBDIR_PARTS, rentalId, fileName].join("/");
}

// Resolve um caminho relativo do CSV para absoluto, garantindo que ele nao
// escape da pasta de dados (rejeita absolutos e ".."). Retorna null se invalido.
function absolutePathOf(dataDir, relPath) {
  const raw = String(relPath || "").trim();
  const normalized = normalizeSeparators(raw).trim();
  if (!normalized || isAbsolutePathAnyPlatform(raw) || /^[a-zA-Z]:/.test(normalized)) return null;
  if (normalized.split("/").some((part) => part === "..")) return null;
  const root = path.resolve(dataDir);
  const abs = path.resolve(root, normalized);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

// Valida o arquivo de origem (existencia, extensao e tamanho) ANTES de copiar.
// Retorna { ok, message?, size? }.
function validateSource(sourcePath, originalName) {
  const name = originalName || path.basename(String(sourcePath || ""));
  if (!isAllowedExtension(name)) {
    return {
      ok: false,
      message: `Tipo de arquivo nao permitido: "${name}". Permitidos: ${ALLOWED_EXTENSIONS.join(", ")}.`,
    };
  }
  let st;
  try {
    st = fs.statSync(sourcePath);
  } catch {
    return { ok: false, message: `Arquivo nao encontrado: "${name}".` };
  }
  if (!st.isFile()) return { ok: false, message: `"${name}" nao e um arquivo.` };
  if (st.size > MAX_FILE_SIZE) {
    const mb = Math.round(MAX_FILE_SIZE / (1024 * 1024));
    return { ok: false, message: `"${name}" excede o limite de ${mb} MB.` };
  }
  return { ok: true, size: st.size };
}

// Copia um arquivo para a pasta do aluguel, com nome seguro e sem sobrescrever
// arquivos de mesmo nome. Retorna { fileName, relPath, size }; lanca em caso de
// erro de I/O (o chamador faz a limpeza/rollback).
function copyIntoStore(dataDir, rentalId, sourcePath, originalName) {
  const check = validateSource(sourcePath, originalName);
  if (!check.ok) {
    const err = new Error(check.message);
    err.code = "ATTACH_VALIDATION";
    throw err;
  }
  const dir = path.join(dataDir, ...ATTACHMENTS_SUBDIR_PARTS, rentalId);
  fs.mkdirSync(dir, { recursive: true });
  const safeName = uniqueNameIn(dir, sanitizeFileName(originalName || path.basename(sourcePath)));
  fs.copyFileSync(sourcePath, path.join(dir, safeName), fs.constants.COPYFILE_EXCL);
  return {
    fileName: String(originalName || path.basename(sourcePath)),
    relPath: relPathFor(rentalId, safeName),
    size: check.size,
  };
}

// Copia VARIOS arquivos para a pasta do aluguel. Operacao tudo-ou-nada: se a
// validacao ou a copia de qualquer arquivo falhar, os ja copiados sao
// removidos e o erro e propagado (nenhum anexo parcial fica para tras).
// files = [{ path, name }]; retorna [{ fileName, relPath, size }].
function copyAllIntoStore(dataDir, rentalId, files) {
  const results = [];
  try {
    for (const f of files) {
      results.push(copyIntoStore(dataDir, rentalId, f.path, f.name));
    }
    return results;
  } catch (err) {
    for (const r of results) removeStoredFile(dataDir, r.relPath);
    throw err;
  }
}

// Remove o arquivo fisico de um anexo e apaga a pasta do aluguel se ela ficar
// vazia. Tolerante a arquivo ja ausente (removido externamente).
function removeStoredFile(dataDir, relPath) {
  const abs = absolutePathOf(dataDir, relPath);
  if (!abs) return;
  try {
    fs.unlinkSync(abs);
  } catch {
    // Arquivo ja ausente: nada a remover.
  }
  try {
    const dir = path.dirname(abs);
    if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
  } catch {
    // Pasta ainda indisponivel/em uso: limpeza sera tentada em outra operacao.
  }
}

// Remove toda a pasta de anexos de um aluguel (exclusao do aluguel ou rollback
// de um salvamento que falhou).
function removeRentalDir(dataDir, rentalId) {
  if (!rentalId) return;
  const dir = path.join(dataDir, ...ATTACHMENTS_SUBDIR_PARTS, String(rentalId));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Remocao tolerante: a pasta pode ja nao existir.
  }
}

function storedFileExists(dataDir, relPath) {
  const abs = absolutePathOf(dataDir, relPath);
  return !!abs && fs.existsSync(abs);
}

module.exports = {
  MAX_FILE_SIZE,
  ALLOWED_EXTENSIONS,
  extensionOf,
  isAllowedExtension,
  sanitizeFileName,
  uniqueNameIn,
  relPathFor,
  absolutePathOf,
  validateSource,
  copyIntoStore,
  copyAllIntoStore,
  removeStoredFile,
  removeRentalDir,
  storedFileExists,
};
