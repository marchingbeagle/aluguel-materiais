"use strict";

const { ipcMain, dialog, BrowserWindow } = require("electron");
const fs = require("fs");

const settings = require("./settings");
const store = require("./csvStore");
const lock = require("./lock");

const { SCHEMAS } = store;

// Janela de tempo na qual o watcher ignora eventos gerados pela nossa propria
// escrita, evitando loop de auto-refresh.
let lastWriteAt = 0;
function markSelfWrite() {
  lastWriteAt = Date.now();
}
function getLastWriteAt() {
  return lastWriteAt;
}

const STATUS = { RENTED: "alugado", RETURNED: "devolvido" };

// ----------------------------- Helpers de data -----------------------------

function todayStr() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function isValidDate(str) {
  if (!str) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str + "T00:00:00");
  return !Number.isNaN(d.getTime());
}

// Carimbo de data/hora local "YYYY-MM-DD HH:mm:ss" para adicionado_em/alterado_em.
function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// --------------------------- Leitura de dados -------------------------------

function ensureAllFiles() {
  const paths = settings.csvPaths();
  const legacy = settings.legacyCsvPaths();
  // Migra arquivos do formato antigo (virgula + ingles) caso existam.
  for (const key of Object.keys(paths)) {
    store.migrateLegacy(legacy[key], paths[key], SCHEMAS[key]);
  }
  store.ensureFile(paths.materials, SCHEMAS.materials);
  store.ensureFile(paths.agencies, SCHEMAS.agencies);
  store.ensureFile(paths.rentals, SCHEMAS.rentals);
  return paths;
}

function readEntity(name) {
  const paths = settings.csvPaths();
  return store.readAll(paths[name], SCHEMAS[name]);
}

// Quantidade alugada (ativa) por material_id.
function rentedByMaterial(rentals) {
  const map = new Map();
  for (const r of rentals) {
    if (r.status === STATUS.RENTED) {
      const q = Number(r.quantity) || 0;
      map.set(r.material_id, (map.get(r.material_id) || 0) + q);
    }
  }
  return map;
}

function isOverdue(rental, today) {
  return (
    rental.status === STATUS.RENTED &&
    isValidDate(rental.expected_return_date) &&
    rental.expected_return_date < today
  );
}

// Monta o pacote completo de dados ja enriquecido para a interface.
function buildSnapshot() {
  ensureAllFiles();
  const materials = readEntity("materials");
  const agencies = readEntity("agencies");
  const rentals = readEntity("rentals");
  const today = todayStr();

  const rentedMap = rentedByMaterial(rentals);
  const materialById = new Map(materials.map((m) => [m.id, m]));
  const agencyById = new Map(agencies.map((a) => [a.id, a]));

  const materialsView = materials.map((m) => {
    const rented = rentedMap.get(m.id) || 0;
    const total = Number(m.total_quantity) || 0;
    return { ...m, rented, available: total - rented };
  });

  const rentalsView = rentals.map((r) => ({
    ...r,
    material_name: materialById.get(r.material_id)?.name || "(material removido)",
    agency_name: agencyById.get(r.agency_id)?.name || "(agencia removida)",
    overdue: isOverdue(r, today),
  }));

  let totalUnits = 0;
  for (const m of materials) totalUnits += Number(m.total_quantity) || 0;

  let rentedUnits = 0;
  for (const q of rentedMap.values()) rentedUnits += q;

  const activeRentals = rentals.filter((r) => r.status === STATUS.RENTED);
  const overdueCount = activeRentals.filter((r) => isOverdue(r, today)).length;

  const stats = {
    totalMaterials: materials.length,
    totalUnits,
    rentedUnits,
    availableUnits: Math.max(0, totalUnits - rentedUnits),
    activeRentals: activeRentals.length,
    overdueCount,
    totalAgencies: agencies.length,
  };

  return { materials: materialsView, agencies: agenciesSorted(agencies), rentals: rentalsView, stats, today };
}

function agenciesSorted(agencies) {
  return [...agencies].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

// ------------------------- Escrita sob lock ---------------------------------

// Executa uma mutacao com lock + re-leitura fresca + gravacao atomica.
// fn recebe a lista atual (lida do disco) e deve retornar a nova lista.
async function mutate(entity, fn) {
  const dir = settings.getDataDir();
  const userId = settings.getUserId();
  return lock.withLock(dir, userId, async () => {
    ensureAllFiles();
    const paths = settings.csvPaths();
    const current = store.readAll(paths[entity], SCHEMAS[entity]);
    const next = fn(current);
    markSelfWrite();
    store.writeAll(paths[entity], SCHEMAS[entity], next);
  });
}

function fail(code, message) {
  return { ok: false, code, message };
}
function done(extra) {
  return { ok: true, ...(extra || {}) };
}

// Detecta se um registro foi alterado por outro usuario desde que o cliente
// carregou os dados (concorrencia otimista).
function changedSinceBaseline(currentRow, baseline, fields) {
  if (!baseline) return false;
  for (const f of fields) {
    if (String(currentRow[f] ?? "") !== String(baseline[f] ?? "")) return true;
  }
  return false;
}

// --------------------------- Validacoes -------------------------------------

function parseIntStrict(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  return n;
}

// Sanitiza uma cor HEX. Aceita "#rrggbb" (qualquer caixa) e normaliza para
// minusculas. Valor ausente/invalido vira "" (a interface usa a cor padrao).
function cleanColor(value) {
  const v = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : "";
}

function validateMaterial(data) {
  const errors = [];
  const name = String(data.name || "").trim();
  if (!name) errors.push("Nome e obrigatorio.");
  const total = parseIntStrict(data.total_quantity);
  if (total === null || total < 0) errors.push("Quantidade total deve ser um numero inteiro >= 0.");
  return { errors, clean: { name, total } };
}

function validateAgency(data) {
  const errors = [];
  const name = String(data.name || "").trim();
  if (!name) errors.push("Nome e obrigatorio.");
  return { errors, clean: { name } };
}

// ----------------------------- Handlers -------------------------------------

function registerIpc() {
  ipcMain.handle("settings:get", () => {
    const paths = settings.csvPaths();
    return {
      dataDir: settings.getDataDir(),
      userId: settings.getUserId(),
      paths,
    };
  });

  ipcMain.handle("settings:chooseDir", async () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win, {
      title: "Selecione a pasta de dados (CSV)",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: settings.getDataDir(),
    });
    if (res.canceled || !res.filePaths.length) {
      return { ok: false, canceled: true };
    }
    settings.setDataDir(res.filePaths[0]);
    ensureAllFiles();
    return done({ dataDir: settings.getDataDir(), paths: settings.csvPaths() });
  });

  // Verifica existencia/legibilidade dos arquivos e cria os que faltam.
  ipcMain.handle("files:validate", () => {
    const paths = settings.csvPaths();
    const report = {};
    for (const key of Object.keys(paths)) {
      const p = paths[key];
      const existedBefore = fs.existsSync(p);
      store.ensureFile(p, SCHEMAS[key]);
      let readable = false;
      try {
        fs.accessSync(p, fs.constants.R_OK | fs.constants.W_OK);
        readable = true;
      } catch (_err) {
        readable = false;
      }
      report[key] = { path: p, existedBefore, exists: fs.existsSync(p), readable, created: !existedBefore };
    }
    return report;
  });

  ipcMain.handle("data:loadAll", () => buildSnapshot());

  // ----------------------------- Materiais ----------------------------------

  ipcMain.handle("material:create", async (_e, data) => {
    const { errors, clean } = validateMaterial(data);
    if (errors.length) return fail("VALIDATION", errors.join(" "));

    await mutate("materials", (rows) => {
      rows.push({
        id: store.newId(),
        name: clean.name,
        category: String(data.category || "").trim(),
        description: String(data.description || "").trim(),
        total_quantity: clean.total,
        notes: String(data.notes || "").trim(),
        color: cleanColor(data.color),
        adicionado_em: nowStamp(),
        alterado_em: "",
      });
      return rows;
    });
    return done();
  });

  ipcMain.handle("material:update", async (_e, data) => {
    const { errors, clean } = validateMaterial(data);
    if (errors.length) return fail("VALIDATION", errors.join(" "));

    let conflict = false;
    let notFound = false;
    let belowRented = false;

    await mutate("materials", (rows) => {
      const idx = rows.findIndex((r) => r.id === data.id);
      if (idx === -1) {
        notFound = true;
        return rows;
      }
      if (changedSinceBaseline(rows[idx], data._baseline, store.keysOf(SCHEMAS.materials))) {
        conflict = true;
        return rows;
      }
      // Nao permitir total menor que o que ja esta alugado.
      const rentals = readEntity("rentals");
      const rented = rentedByMaterial(rentals).get(data.id) || 0;
      if (clean.total < rented) {
        belowRented = true;
        return rows;
      }
      rows[idx] = {
        ...rows[idx],
        name: clean.name,
        category: String(data.category || "").trim(),
        description: String(data.description || "").trim(),
        total_quantity: clean.total,
        notes: String(data.notes || "").trim(),
        color: cleanColor(data.color),
        alterado_em: nowStamp(),
      };
      return rows;
    });

    if (notFound) return fail("NOT_FOUND", "Material nao encontrado (pode ter sido removido).");
    if (conflict) return fail("CONFLICT", "Este material foi alterado por outro usuario. Recarregue e tente novamente.");
    if (belowRented) return fail("VALIDATION", "Quantidade total nao pode ser menor que a quantidade atualmente alugada.");
    return done();
  });

  ipcMain.handle("material:delete", async (_e, id) => {
    let blocked = false;
    await mutate("materials", (rows) => {
      const rentals = readEntity("rentals");
      const hasActive = rentals.some((r) => r.material_id === id && r.status === STATUS.RENTED);
      if (hasActive) {
        blocked = true;
        return rows;
      }
      return rows.filter((r) => r.id !== id);
    });
    if (blocked) return fail("VALIDATION", "Nao e possivel excluir: existe aluguel ativo deste material.");
    return done();
  });

  // ----------------------------- Agencias -----------------------------------

  ipcMain.handle("agency:create", async (_e, data) => {
    const { errors, clean } = validateAgency(data);
    if (errors.length) return fail("VALIDATION", errors.join(" "));

    await mutate("agencies", (rows) => {
      rows.push({
        id: store.newId(),
        name: clean.name,
        contact_person: String(data.contact_person || "").trim(),
        phone: String(data.phone || "").trim(),
        email: String(data.email || "").trim(),
        notes: String(data.notes || "").trim(),
        adicionado_em: nowStamp(),
        alterado_em: "",
      });
      return rows;
    });
    return done();
  });

  ipcMain.handle("agency:update", async (_e, data) => {
    const { errors, clean } = validateAgency(data);
    if (errors.length) return fail("VALIDATION", errors.join(" "));

    let conflict = false;
    let notFound = false;

    await mutate("agencies", (rows) => {
      const idx = rows.findIndex((r) => r.id === data.id);
      if (idx === -1) {
        notFound = true;
        return rows;
      }
      if (changedSinceBaseline(rows[idx], data._baseline, store.keysOf(SCHEMAS.agencies))) {
        conflict = true;
        return rows;
      }
      rows[idx] = {
        ...rows[idx],
        name: clean.name,
        contact_person: String(data.contact_person || "").trim(),
        phone: String(data.phone || "").trim(),
        email: String(data.email || "").trim(),
        notes: String(data.notes || "").trim(),
        alterado_em: nowStamp(),
      };
      return rows;
    });

    if (notFound) return fail("NOT_FOUND", "Agencia nao encontrada (pode ter sido removida).");
    if (conflict) return fail("CONFLICT", "Esta agencia foi alterada por outro usuario. Recarregue e tente novamente.");
    return done();
  });

  ipcMain.handle("agency:delete", async (_e, id) => {
    let blocked = false;
    await mutate("agencies", (rows) => {
      const rentals = readEntity("rentals");
      const hasActive = rentals.some((r) => r.agency_id === id && r.status === STATUS.RENTED);
      if (hasActive) {
        blocked = true;
        return rows;
      }
      return rows.filter((r) => r.id !== id);
    });
    if (blocked) return fail("VALIDATION", "Nao e possivel excluir: esta agencia possui aluguel ativo.");
    return done();
  });

  // ------------------------------ Alugueis -----------------------------------

  ipcMain.handle("rental:create", async (_e, data) => {
    const quantity = parseIntStrict(data.quantity);
    const errors = [];
    if (!data.material_id) errors.push("Selecione um material.");
    if (!data.agency_id) errors.push("Selecione uma agencia.");
    if (quantity === null || quantity < 1) errors.push("Quantidade deve ser um inteiro >= 1.");
    if (!isValidDate(data.checkout_date)) errors.push("Data de retirada invalida.");
    if (!isValidDate(data.expected_return_date)) errors.push("Data prevista de devolucao invalida.");
    if (
      isValidDate(data.checkout_date) &&
      isValidDate(data.expected_return_date) &&
      data.expected_return_date < data.checkout_date
    ) {
      errors.push("Devolucao prevista nao pode ser anterior a retirada.");
    }
    if (errors.length) return fail("VALIDATION", errors.join(" "));

    let problem = null;

    await mutate("rentals", (rows) => {
      const materials = readEntity("materials");
      const agencies = readEntity("agencies");
      const material = materials.find((m) => m.id === data.material_id);
      const agency = agencies.find((a) => a.id === data.agency_id);
      if (!material) {
        problem = fail("NOT_FOUND", "Material nao encontrado.");
        return rows;
      }
      if (!agency) {
        problem = fail("NOT_FOUND", "Agencia nao encontrada.");
        return rows;
      }
      // Recalcula disponibilidade com dados frescos do disco.
      const rented = rentedByMaterial(rows).get(material.id) || 0;
      const available = (Number(material.total_quantity) || 0) - rented;
      if (quantity > available) {
        problem = fail(
          "VALIDATION",
          `Quantidade indisponivel. Disponivel agora: ${Math.max(0, available)}.`
        );
        return rows;
      }
      rows.push({
        id: store.newId(),
        material_id: data.material_id,
        agency_id: data.agency_id,
        quantity,
        checkout_date: data.checkout_date,
        expected_return_date: data.expected_return_date,
        actual_return_date: "",
        status: STATUS.RENTED,
        notes: String(data.notes || "").trim(),
        adicionado_em: nowStamp(),
        alterado_em: "",
      });
      return rows;
    });

    return problem || done();
  });

  ipcMain.handle("rental:update", async (_e, data) => {
    const quantity = parseIntStrict(data.quantity);
    const errors = [];
    if (!data.material_id) errors.push("Selecione um material.");
    if (!data.agency_id) errors.push("Selecione uma agencia.");
    if (quantity === null || quantity < 1) errors.push("Quantidade deve ser um inteiro >= 1.");
    if (!isValidDate(data.checkout_date)) errors.push("Data de retirada invalida.");
    if (!isValidDate(data.expected_return_date)) errors.push("Data prevista de devolucao invalida.");
    if (
      isValidDate(data.checkout_date) &&
      isValidDate(data.expected_return_date) &&
      data.expected_return_date < data.checkout_date
    ) {
      errors.push("Devolucao prevista nao pode ser anterior a retirada.");
    }
    // Quando devolvido, a data de devolucao (se informada) deve ser valida.
    const isReturned = data._baseline ? data._baseline.status === STATUS.RETURNED : false;
    let actualReturnDate = "";
    if (isReturned) {
      if (data.actual_return_date) {
        if (!isValidDate(data.actual_return_date)) {
          errors.push("Data de devolucao invalida.");
        } else if (data.actual_return_date < data.checkout_date) {
          errors.push("Devolucao nao pode ser anterior a retirada.");
        } else {
          actualReturnDate = data.actual_return_date;
        }
      }
    }
    if (errors.length) return fail("VALIDATION", errors.join(" "));

    let problem = null;

    await mutate("rentals", (rows) => {
      const idx = rows.findIndex((r) => r.id === data.id);
      if (idx === -1) {
        problem = fail("NOT_FOUND", "Aluguel nao encontrado (pode ter sido removido).");
        return rows;
      }
      if (changedSinceBaseline(rows[idx], data._baseline, store.keysOf(SCHEMAS.rentals))) {
        problem = fail("CONFLICT", "Este aluguel foi alterado por outro usuario. Recarregue e tente novamente.");
        return rows;
      }

      const materials = readEntity("materials");
      const agencies = readEntity("agencies");
      const material = materials.find((m) => m.id === data.material_id);
      const agency = agencies.find((a) => a.id === data.agency_id);
      if (!material) {
        problem = fail("NOT_FOUND", "Material nao encontrado.");
        return rows;
      }
      if (!agency) {
        problem = fail("NOT_FOUND", "Agencia nao encontrada.");
        return rows;
      }

      // Se o aluguel continua ativo, valida disponibilidade excluindo a propria
      // contribuicao atual deste registro para o material escolhido.
      const current = rows[idx];
      if (current.status === STATUS.RENTED) {
        const othersRented = rows.reduce((sum, r) => {
          if (r.id === current.id) return sum;
          if (r.status === STATUS.RENTED && r.material_id === material.id) {
            return sum + (Number(r.quantity) || 0);
          }
          return sum;
        }, 0);
        const available = (Number(material.total_quantity) || 0) - othersRented;
        if (quantity > available) {
          problem = fail(
            "VALIDATION",
            `Quantidade indisponivel. Disponivel agora: ${Math.max(0, available)}.`
          );
          return rows;
        }
      }

      rows[idx] = {
        ...current,
        material_id: data.material_id,
        agency_id: data.agency_id,
        quantity,
        checkout_date: data.checkout_date,
        expected_return_date: data.expected_return_date,
        actual_return_date: current.status === STATUS.RETURNED ? actualReturnDate : "",
        notes: String(data.notes || "").trim(),
        alterado_em: nowStamp(),
      };
      return rows;
    });

    return problem || done();
  });

  ipcMain.handle("rental:return", async (_e, payload) => {
    const id = typeof payload === "string" ? payload : payload?.id;
    const providedDate = typeof payload === "object" ? payload.actual_return_date : "";
    const returnDate = isValidDate(providedDate) ? providedDate : todayStr();

    let notFound = false;
    let already = false;

    await mutate("rentals", (rows) => {
      const idx = rows.findIndex((r) => r.id === id);
      if (idx === -1) {
        notFound = true;
        return rows;
      }
      if (rows[idx].status !== STATUS.RENTED) {
        already = true;
        return rows;
      }
      rows[idx] = { ...rows[idx], status: STATUS.RETURNED, actual_return_date: returnDate, alterado_em: nowStamp() };
      return rows;
    });

    if (notFound) return fail("NOT_FOUND", "Aluguel nao encontrado.");
    if (already) return fail("VALIDATION", "Este aluguel ja foi devolvido.");
    return done();
  });

  ipcMain.handle("rental:delete", async (_e, id) => {
    await mutate("rentals", (rows) => rows.filter((r) => r.id !== id));
    return done();
  });
}

module.exports = { registerIpc, ensureAllFiles, getLastWriteAt };
