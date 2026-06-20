"use strict";

const { ipcMain, dialog, shell, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const settings = require("./settings");
const store = require("./csvStore");
const lock = require("./lock");
const availability = require("./availability");
const attachments = require("./attachments");
const rentalRules = require("./rentalRules");
const stock = require("./stock");
const dateUtils = require("../shared/dates");

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

// Validacao centralizada de datas internas (YYYY-MM-DD), rejeitando datas
// inexistentes como 2026-02-31.
function isValidDate(str) {
  return dateUtils.isValidISO(str);
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
  // Migra arquivos do formato antigo (virgula + ingles) caso existam. O
  // alugueis.csv legado e migrado primeiro para o formato intermediario (um
  // material por linha) e em seguida dividido em cabecalho + itens.
  store.migrateLegacy(legacy.materials, paths.materials, SCHEMAS.materials);
  store.migrateLegacy(legacy.agencies, paths.agencies, SCHEMAS.agencies);
  store.migrateLegacy(legacy.rentals, paths.rentals, store.LEGACY_RENTALS_SCHEMA);

  // Divide o alugueis.csv da versao anterior (coluna id_material) em
  // alugueis.csv (dados gerais) + itens_aluguel.csv (materiais). Roda antes do
  // reconcileSchema para que o cabecalho antigo nao seja descartado.
  const split = store.migrateRentalsToItems(
    paths.rentals,
    paths.rentalItems,
    SCHEMAS.rentals,
    SCHEMAS.rentalItems
  );

  for (const key of Object.keys(paths)) {
    store.ensureFile(paths[key], SCHEMAS[key]);
  }
  // Atualiza o cabecalho de arquivos ja existentes para o schema atual.
  // So regrava quando o cabecalho realmente difere; nenhum dado e perdido.
  let upgraded = split;
  for (const key of Object.keys(paths)) {
    if (store.reconcileSchema(paths[key], SCHEMAS[key])) upgraded = true;
  }
  if (upgraded) markSelfWrite();
  return paths;
}

function readEntity(name) {
  const paths = settings.csvPaths();
  return store.readAll(paths[name], SCHEMAS[name]);
}

// Quantidade alugada (itens ativos) por material_id. Itens orfaos (sem
// cabecalho de aluguel) sao ignorados.
function rentedByMaterial(rentals, items) {
  const headerIds = new Set(rentals.map((r) => r.id));
  const map = new Map();
  for (const it of items) {
    if (it.status === STATUS.RENTED && headerIds.has(it.rental_id)) {
      const q = Number(it.quantity) || 0;
      map.set(it.material_id, (map.get(it.material_id) || 0) + q);
    }
  }
  return map;
}

function isItemOverdue(item, rental, today) {
  return (
    item.status === STATUS.RENTED &&
    isValidDate(rental.expected_return_date) &&
    rental.expected_return_date < today
  );
}

// Situacao derivada do aluguel a partir dos itens:
//   alugado   - todos os itens ativos
//   parcial   - parte devolvida, parte ativa
//   devolvido - todos os itens devolvidos
function rentalStatusOf(items) {
  if (!items.length) return STATUS.RETURNED;
  const active = items.filter((it) => it.status === STATUS.RENTED).length;
  if (active === 0) return STATUS.RETURNED;
  if (active === items.length) return STATUS.RENTED;
  return "parcial";
}

// Monta o pacote completo de dados ja enriquecido para a interface.
function buildSnapshot() {
  ensureAllFiles();
  const materials = readEntity("materials");
  const agencies = readEntity("agencies");
  const rentals = readEntity("rentals");
  const items = readEntity("rentalItems");
  const attachRows = readEntity("attachments");
  const stockProducts = readEntity("stockProducts");
  const stockMovements = readEntity("stockMovements");
  const today = todayStr();
  const dataDir = settings.getDataDir();

  const rentedMap = rentedByMaterial(rentals, items);
  const materialById = new Map(materials.map((m) => [m.id, m]));
  const agencyById = new Map(agencies.map((a) => [a.id, a]));

  const itemsByRental = new Map();
  for (const it of items) {
    if (!itemsByRental.has(it.rental_id)) itemsByRental.set(it.rental_id, []);
    itemsByRental.get(it.rental_id).push(it);
  }
  const attachmentsByRental = new Map();
  for (const a of attachRows) {
    if (!attachmentsByRental.has(a.rental_id)) attachmentsByRental.set(a.rental_id, []);
    attachmentsByRental.get(a.rental_id).push(a);
  }

  const materialsView = materials.map((m) => {
    const rented = rentedMap.get(m.id) || 0;
    const total = Number(m.total_quantity) || 0;
    return { ...m, rented, available: total - rented };
  });

  const rentalsView = rentals.map((r) => {
    const its = (itemsByRental.get(r.id) || []).map((it) => ({
      ...it,
      material_name: materialById.get(it.material_id)?.name || "(material removido)",
      material_color: materialById.get(it.material_id)?.color || "",
      overdue: isItemOverdue(it, r, today),
    }));
    const atts = (attachmentsByRental.get(r.id) || []).map((a) => ({
      ...a,
      missing: !attachments.storedFileExists(dataDir, a.rel_path),
    }));
    const status = rentalStatusOf(its);
    return {
      ...r,
      agency_name: agencyById.get(r.agency_id)?.name || "(agencia removida)",
      agency_code: agencyById.get(r.agency_id)?.code || "",
      items: its,
      attachments: atts,
      status,
      overdue: its.some((it) => it.overdue),
      total_quantity: its.reduce((s, it) => s + (Number(it.quantity) || 0), 0),
    };
  });

  // Entradas planas (uma por item) para calendario e painel analitico.
  const rentalEntries = [];
  for (const r of rentalsView) {
    for (const it of r.items) {
      rentalEntries.push({
        id: it.id,
        rental_id: r.id,
        material_id: it.material_id,
        material_name: it.material_name,
        agency_id: r.agency_id,
        agency_name: r.agency_name,
        agency_code: r.agency_code,
        event_name: r.event_name,
        process_number: r.process_number,
        quantity: it.quantity,
        checkout_date: r.checkout_date,
        expected_return_date: r.expected_return_date,
        actual_return_date: it.actual_return_date,
        status: it.status,
        overdue: it.overdue,
      });
    }
  }

  let totalUnits = 0;
  for (const m of materials) totalUnits += Number(m.total_quantity) || 0;

  let rentedUnits = 0;
  for (const q of rentedMap.values()) rentedUnits += q;

  const activeRentals = rentalsView.filter((r) => r.status !== STATUS.RETURNED);
  const overdueCount = activeRentals.filter((r) => r.overdue).length;

  const stats = {
    totalMaterials: materials.length,
    totalUnits,
    rentedUnits,
    availableUnits: Math.max(0, totalUnits - rentedUnits),
    activeRentals: activeRentals.length,
    overdueCount,
    totalAgencies: agencies.length,
  };

  const inventory = stock.buildInventory(stockProducts, stockMovements);
  const productById = new Map(stockProducts.map((p) => [p.id, p]));
  const stockMovementsView = stockMovements
    .map((m) => ({
      ...m,
      product_name: productById.get(m.product_id)?.name || "(produto removido)",
      signed_quantity: stock.movementSignedQuantity(m),
    }))
    .sort((a, b) => (b.movement_date || "").localeCompare(a.movement_date || ""));

  return {
    materials: materialsView,
    agencies: agenciesSorted(agencies),
    rentals: rentalsView,
    rentalEntries,
    stockProducts: inventory,
    stockMovements: stockMovementsView,
    stockStats: stock.buildStats(inventory, stockMovements),
    stats,
    today,
  };
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

// Mutacao dos dados de aluguel (cabecalho + itens + anexos) sob o MESMO lock,
// com releitura fresca de tudo. fn recebe { rentals, items, attachments,
// materials, agencies } e deve retornar { rentals, items, attachments } com as
// novas listas, ou null para nao gravar nada (operacao recusada).
//
// A gravacao escreve itens e anexos ANTES do cabecalho: se o processo cair no
// meio, linhas orfas (sem cabecalho) sao invisiveis para a aplicacao, em vez
// de um aluguel sem itens.
async function mutateRentalData(fn) {
  const dir = settings.getDataDir();
  const userId = settings.getUserId();
  return lock.withLock(dir, userId, async () => {
    ensureAllFiles();
    const paths = settings.csvPaths();
    const state = {
      rentals: store.readAll(paths.rentals, SCHEMAS.rentals),
      items: store.readAll(paths.rentalItems, SCHEMAS.rentalItems),
      attachments: store.readAll(paths.attachments, SCHEMAS.attachments),
      materials: store.readAll(paths.materials, SCHEMAS.materials),
      agencies: store.readAll(paths.agencies, SCHEMAS.agencies),
    };
    const next = await fn(state);
    if (!next) return;
    markSelfWrite();
    store.writeAll(paths.rentalItems, SCHEMAS.rentalItems, next.items);
    store.writeAll(paths.attachments, SCHEMAS.attachments, next.attachments);
    store.writeAll(paths.rentals, SCHEMAS.rentals, next.rentals);
  });
}

async function mutateStockData(fn) {
  const dir = settings.getDataDir();
  const userId = settings.getUserId();
  return lock.withLock(dir, userId, async () => {
    ensureAllFiles();
    const paths = settings.csvPaths();
    const state = {
      products: store.readAll(paths.stockProducts, SCHEMAS.stockProducts),
      movements: store.readAll(paths.stockMovements, SCHEMAS.stockMovements),
    };
    const next = await fn(state);
    if (!next) return;
    markSelfWrite();
    store.writeAll(paths.stockProducts, SCHEMAS.stockProducts, next.products);
    store.writeAll(paths.stockMovements, SCHEMAS.stockMovements, next.movements);
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
  const code = String(data.code || "").trim();
  if (!code) errors.push("Codigo e obrigatorio.");
  else if (!/^\d+$/.test(code)) errors.push("Codigo deve conter apenas numeros (ex.: 01, 02, 03).");
  return { errors, clean: { name, code } };
}

function validateStockProduct(data, { requireId = true } = {}) {
  const errors = [];
  const id = String(data.id || data.code || "").trim();
  const name = String(data.name || "").trim();
  const min = parseIntStrict(data.min_stock);
  const max = parseIntStrict(data.max_stock);
  if (requireId && !id) errors.push("Codigo do produto e obrigatorio.");
  if (id && !/^[A-Za-z0-9._-]+$/.test(id)) errors.push("Codigo do produto deve usar letras, numeros, ponto, hifen ou underline.");
  if (!name) errors.push("Descricao e obrigatoria.");
  if (min === null || min < 0) errors.push("Estoque minimo deve ser um numero inteiro >= 0.");
  if (max === null || max < 0) errors.push("Estoque maximo deve ser um numero inteiro >= 0.");
  return { errors, clean: { id, name, min, max } };
}

function validateStockMovement(data) {
  const errors = [];
  const productId = String(data.product_id || "").trim();
  const type = stock.normalizeType(data.type);
  const movementDate = String(data.movement_date || "").trim();
  const quantity = parseIntStrict(data.quantity);
  const unitCost = stock.parseNumber(data.unit_cost);
  let totalValue = stock.parseNumber(data.total_value);

  if (!productId) errors.push("Produto e obrigatorio.");
  if (!type) errors.push("Tipo deve ser Entrada ou Saida.");
  if (!isValidDate(movementDate)) errors.push("Data da movimentacao invalida.");
  if (quantity === null || quantity <= 0) errors.push("Quantidade deve ser um numero inteiro maior que zero.");
  if (unitCost < 0) errors.push("Valor unitario deve ser >= 0.");
  if (totalValue < 0) errors.push("Valor da transacao deve ser >= 0.");
  if (!totalValue && unitCost > 0 && quantity > 0) totalValue = unitCost * quantity;

  return { errors, clean: { productId, type, movementDate, quantity, unitCost, totalValue } };
}

// ------------------------- Anexos: copia + rollback --------------------------

// Copia os arquivos de origem para a pasta do aluguel e devolve as linhas de
// metadados prontas para o CSV. Em caso de falha em QUALQUER arquivo, os ja
// copiados sao removidos (tudo-ou-nada, dentro de attachments.copyAllIntoStore).
function copyAttachmentFiles(rentalId, files, stamp) {
  const dataDir = settings.getDataDir();
  const results = attachments.copyAllIntoStore(dataDir, rentalId, files);
  return results.map((result) => ({
    id: store.newId(),
    rental_id: rentalId,
    file_name: result.fileName,
    rel_path: result.relPath,
    size: result.size,
    adicionado_em: stamp,
    alterado_em: "",
  }));
}

function normalizeFilesPayload(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((f) => ({ path: String(f?.path || ""), name: String(f?.name || "") }))
    .filter((f) => f.path);
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

  ipcMain.handle("stock:template", async (_e, kind) => {
    const templateKind = kind === "movements" ? "movements" : "products";
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const defaultName = templateKind === "movements" ? "template_movimentacoes_estoque.csv" : "template_produtos.csv";
    const res = await dialog.showSaveDialog(win, {
      title: "Salvar template CSV",
      defaultPath: path.join(settings.getDataDir(), defaultName),
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(res.filePath, stock.templateCsv(templateKind), "utf8");
    return done({ path: res.filePath });
  });

  ipcMain.handle("stock:importCsv", async (_e, kind) => {
    const importKind = kind === "movements" ? "movements" : "products";
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win, {
      title: importKind === "movements" ? "Importar entradas e saidas" : "Importar produtos",
      properties: ["openFile"],
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };

    let raw;
    try {
      raw = fs.readFileSync(res.filePaths[0], "utf8");
    } catch (err) {
      return fail("IO", `Nao foi possivel ler o CSV: ${err.message}`);
    }

    const stamp = nowStamp();
    const parsed =
      importKind === "movements" ? stock.parseMovementsCsv(raw, stamp) : stock.parseProductsCsv(raw, stamp);
    if (!parsed.length) return fail("VALIDATION", "Nenhuma linha valida foi encontrada no CSV.");

    let imported = 0;
    let updated = 0;
    let skipped = 0;

    await mutateStockData((state) => {
      if (importKind === "products") {
        const byId = new Map(state.products.map((p, idx) => [p.id, idx]));
        const products = [...state.products];
        for (const p of parsed) {
          const idx = byId.get(p.id);
          if (idx === undefined) {
            products.push(p);
            byId.set(p.id, products.length - 1);
            imported += 1;
          } else {
            products[idx] = { ...products[idx], ...p, adicionado_em: products[idx].adicionado_em, alterado_em: stamp };
            updated += 1;
          }
        }
        return { products, movements: state.movements };
      }

      const productIds = new Set(state.products.map((p) => p.id));
      const movementIds = new Set(state.movements.map((m) => m.id));
      const movements = [...state.movements];
      for (const m of parsed) {
        if (!productIds.has(m.product_id) || movementIds.has(m.id)) {
          skipped += 1;
          continue;
        }
        movements.push(m);
        movementIds.add(m.id);
        imported += 1;
      }
      return { products: state.products, movements };
    });

    const label = importKind === "movements" ? "movimentacoes" : "produtos";
    return done({
      imported,
      updated,
      skipped,
      message: `${imported} ${label} importado(s), ${updated} atualizado(s), ${skipped} ignorado(s).`,
    });
  });

  ipcMain.handle("data:loadAll", () => buildSnapshot());

  // Disponibilidade de cada material durante um periodo informado. Usado pelo
  // formulario de aluguel para mostrar a quantidade disponivel no intervalo.
  // Le os dados mais recentes do disco a cada chamada. excludeId = id do
  // ALUGUEL em edicao (todos os seus itens sao desconsiderados).
  ipcMain.handle("rentals:availability", (_e, payload) => {
    const checkout = payload?.checkout_date;
    const expectedReturn = payload?.expected_return_date;
    const excludeId = payload?.excludeId || null;

    if (!isValidDate(checkout) || !isValidDate(expectedReturn)) {
      return fail("VALIDATION", "Periodo invalido.");
    }
    if (expectedReturn < checkout) {
      return fail("VALIDATION", "Devolucao prevista nao pode ser anterior a retirada.");
    }

    ensureAllFiles();
    const materials = readEntity("materials");
    const rentals = readEntity("rentals");
    const items = readEntity("rentalItems");
    const occupancy = availability.occupancyFromItems(rentals, items, excludeId);

    const map = {};
    for (const m of materials) {
      map[m.id] = availability.availabilityForPeriod(
        m.total_quantity,
        occupancy,
        m.id,
        checkout,
        expectedReturn,
        null
      );
    }
    return done({ available: map });
  });

  // ----------------------------- Materiais ----------------------------------

  ipcMain.handle("material:create", async (_e, data) => {
    const { errors, clean } = validateMaterial(data);
    if (errors.length) return fail("VALIDATION", errors.join(" "));

    await mutate("materials", (rows) => {
      rows.push({
        id: store.newId(),
        name: clean.name,
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
      const items = readEntity("rentalItems");
      const rented = rentedByMaterial(rentals, items).get(data.id) || 0;
      if (clean.total < rented) {
        belowRented = true;
        return rows;
      }
      rows[idx] = {
        ...rows[idx],
        name: clean.name,
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
      const items = readEntity("rentalItems");
      const headerIds = new Set(rentals.map((r) => r.id));
      const hasActive = items.some(
        (it) => it.material_id === id && it.status === STATUS.RENTED && headerIds.has(it.rental_id)
      );
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

    let duplicate = false;

    await mutate("agencies", (rows) => {
      // Codigo deve ser unico entre as agencias (ignora codigos em branco de registros legados).
      if (rows.some((r) => String(r.code || "").trim() === clean.code)) {
        duplicate = true;
        return rows;
      }
      rows.push({
        id: store.newId(),
        code: clean.code,
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

    if (duplicate) return fail("VALIDATION", `Codigo "${clean.code}" ja esta em uso por outra agencia.`);
    return done();
  });

  ipcMain.handle("agency:update", async (_e, data) => {
    const { errors, clean } = validateAgency(data);
    if (errors.length) return fail("VALIDATION", errors.join(" "));

    let conflict = false;
    let notFound = false;
    let duplicate = false;

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
      // Codigo deve ser unico (ignora a propria agencia e codigos em branco legados).
      if (rows.some((r) => r.id !== data.id && String(r.code || "").trim() === clean.code)) {
        duplicate = true;
        return rows;
      }
      rows[idx] = {
        ...rows[idx],
        code: clean.code,
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
    if (duplicate) return fail("VALIDATION", `Codigo "${clean.code}" ja esta em uso por outra agencia.`);
    return done();
  });

  ipcMain.handle("agency:delete", async (_e, id) => {
    let blocked = false;
    await mutate("agencies", (rows) => {
      const rentals = readEntity("rentals");
      const items = readEntity("rentalItems");
      const activeRentalIds = new Set(
        items.filter((it) => it.status === STATUS.RENTED).map((it) => it.rental_id)
      );
      const hasActive = rentals.some((r) => r.agency_id === id && activeRentalIds.has(r.id));
      if (hasActive) {
        blocked = true;
        return rows;
      }
      return rows.filter((r) => r.id !== id);
    });
    if (blocked) return fail("VALIDATION", "Nao e possivel excluir: esta agencia possui aluguel ativo.");
    return done();
  });

  // ------------------------------ Estoque -----------------------------------

  ipcMain.handle("stockProduct:create", async (_e, data) => {
    const { errors, clean } = validateStockProduct(data);
    if (errors.length) return fail("VALIDATION", errors.join(" "));

    let duplicate = false;
    await mutate("stockProducts", (rows) => {
      if (rows.some((p) => p.id === clean.id)) {
        duplicate = true;
        return rows;
      }
      rows.push({
        id: clean.id,
        name: clean.name,
        category: String(data.category || "").trim(),
        supplier: String(data.supplier || "").trim(),
        min_stock: clean.min,
        max_stock: clean.max,
        notes: String(data.notes || "").trim(),
        adicionado_em: nowStamp(),
        alterado_em: "",
      });
      return rows;
    });
    if (duplicate) return fail("VALIDATION", `Codigo "${clean.id}" ja esta em uso.`);
    return done();
  });

  ipcMain.handle("stockProduct:update", async (_e, data) => {
    const { errors, clean } = validateStockProduct(data);
    if (errors.length) return fail("VALIDATION", errors.join(" "));

    let notFound = false;
    let conflict = false;
    await mutate("stockProducts", (rows) => {
      const idx = rows.findIndex((p) => p.id === clean.id);
      if (idx === -1) {
        notFound = true;
        return rows;
      }
      if (changedSinceBaseline(rows[idx], data._baseline, store.keysOf(SCHEMAS.stockProducts))) {
        conflict = true;
        return rows;
      }
      rows[idx] = {
        ...rows[idx],
        name: clean.name,
        category: String(data.category || "").trim(),
        supplier: String(data.supplier || "").trim(),
        min_stock: clean.min,
        max_stock: clean.max,
        notes: String(data.notes || "").trim(),
        alterado_em: nowStamp(),
      };
      return rows;
    });
    if (notFound) return fail("NOT_FOUND", "Produto nao encontrado.");
    if (conflict) return fail("CONFLICT", "Este produto foi alterado por outro usuario. Recarregue e tente novamente.");
    return done();
  });

  ipcMain.handle("stockProduct:delete", async (_e, id) => {
    let blocked = false;
    await mutateStockData((state) => {
      if (state.movements.some((m) => m.product_id === id)) {
        blocked = true;
        return null;
      }
      return { products: state.products.filter((p) => p.id !== id), movements: state.movements };
    });
    if (blocked) return fail("VALIDATION", "Nao e possivel excluir: existem entradas ou saidas deste produto.");
    return done();
  });

  ipcMain.handle("stockMovement:create", async (_e, data) => {
    const { errors, clean } = validateStockMovement(data);
    if (errors.length) return fail("VALIDATION", errors.join(" "));

    let notFound = false;
    await mutateStockData((state) => {
      if (!state.products.some((p) => p.id === clean.productId)) {
        notFound = true;
        return null;
      }
      const stamp = nowStamp();
      return {
        products: state.products,
        movements: [
          ...state.movements,
          {
            id: store.newId(),
            product_id: clean.productId,
            type: clean.type,
            movement_date: clean.movementDate,
            quantity: clean.quantity,
            unit_cost: clean.unitCost,
            total_value: clean.totalValue,
            notes: String(data.notes || "").trim(),
            adicionado_em: stamp,
            alterado_em: "",
          },
        ],
      };
    });
    if (notFound) return fail("NOT_FOUND", "Produto nao encontrado.");
    return done();
  });

  ipcMain.handle("stockMovement:update", async (_e, data) => {
    const { errors, clean } = validateStockMovement(data);
    if (errors.length) return fail("VALIDATION", errors.join(" "));

    let notFound = false;
    let productMissing = false;
    let conflict = false;
    await mutateStockData((state) => {
      if (!state.products.some((p) => p.id === clean.productId)) {
        productMissing = true;
        return null;
      }
      const idx = state.movements.findIndex((m) => m.id === data.id);
      if (idx === -1) {
        notFound = true;
        return null;
      }
      if (changedSinceBaseline(state.movements[idx], data._baseline, store.keysOf(SCHEMAS.stockMovements))) {
        conflict = true;
        return null;
      }
      const movements = [...state.movements];
      movements[idx] = {
        ...movements[idx],
        product_id: clean.productId,
        type: clean.type,
        movement_date: clean.movementDate,
        quantity: clean.quantity,
        unit_cost: clean.unitCost,
        total_value: clean.totalValue,
        notes: String(data.notes || "").trim(),
        alterado_em: nowStamp(),
      };
      return { products: state.products, movements };
    });
    if (productMissing) return fail("NOT_FOUND", "Produto nao encontrado.");
    if (notFound) return fail("NOT_FOUND", "Movimentacao nao encontrada.");
    if (conflict) return fail("CONFLICT", "Esta movimentacao foi alterada por outro usuario. Recarregue e tente novamente.");
    return done();
  });

  ipcMain.handle("stockMovement:delete", async (_e, id) => {
    await mutate("stockMovements", (rows) => rows.filter((m) => m.id !== id));
    return done();
  });

  // ------------------------------ Alugueis -----------------------------------

  // Criacao: valida o payload (cabecalho + itens), depois, SOB O LOCK, rele os
  // CSVs e revalida a disponibilidade de TODOS os itens. A operacao e atomica:
  // se qualquer item for invalido/indisponivel, nada e gravado e os arquivos
  // anexados ja copiados sao removidos.
  ipcMain.handle("rental:create", async (_e, data) => {
    const { errors, clean } = rentalRules.validateRentalPayload(data);
    if (errors.length) return fail("VALIDATION", errors.join(" "));
    const files = normalizeFilesPayload(data?.attachments);

    // Validacao previa dos anexos (extensao/tamanho) antes de tocar nos CSVs.
    for (const f of files) {
      const check = attachments.validateSource(f.path, f.name);
      if (!check.ok) return fail("VALIDATION", check.message);
    }

    let problem = null;
    let createdRentalId = null;

    try {
      await mutateRentalData(async (state) => {
        if (!state.agencies.some((a) => a.id === clean.agency_id)) {
          problem = fail("NOT_FOUND", "Agencia nao encontrada.");
          return null;
        }
        // Disponibilidade recalculada com dados frescos do disco, sob o lock.
        const occupancy = availability.occupancyFromItems(state.rentals, state.items, null);
        const issues = rentalRules.checkItemsAvailability(
          clean.items,
          state.materials,
          occupancy,
          clean.checkout_date,
          clean.expected_return_date
        );
        if (issues.length) {
          problem = fail("VALIDATION", rentalRules.availabilityMessage(issues));
          return null;
        }

        const rentalId = store.newId();
        createdRentalId = rentalId;
        const stamp = nowStamp();

        // Copia os anexos so depois de todas as validacoes. Se a copia falhar,
        // os arquivos ja copiados sao removidos e nada e gravado.
        let attachmentRows = [];
        try {
          attachmentRows = copyAttachmentFiles(rentalId, files, stamp);
        } catch (err) {
          attachments.removeRentalDir(settings.getDataDir(), rentalId);
          if (err && err.code === "ATTACH_VALIDATION") {
            problem = fail("VALIDATION", err.message);
            return null;
          }
          throw err;
        }

        const newItems = clean.items.map((it) => ({
          id: store.newId(),
          rental_id: rentalId,
          material_id: it.material_id,
          quantity: it.quantity,
          status: STATUS.RENTED,
          actual_return_date: "",
          adicionado_em: stamp,
          alterado_em: "",
        }));
        return {
          rentals: [
            ...state.rentals,
            {
              id: rentalId,
              agency_id: clean.agency_id,
              event_name: clean.event_name,
              process_number: clean.process_number,
              checkout_date: clean.checkout_date,
              expected_return_date: clean.expected_return_date,
              notes: clean.notes,
              adicionado_em: stamp,
              alterado_em: "",
            },
          ],
          items: [...state.items, ...newItems],
          attachments: [...state.attachments, ...attachmentRows],
        };
      });
    } catch (err) {
      // Falha na gravacao dos CSVs (apos a copia dos anexos): remove os
      // arquivos copiados para nao deixar anexos orfaos, e propaga o erro.
      if (createdRentalId) attachments.removeRentalDir(settings.getDataDir(), createdRentalId);
      throw err;
    }

    return problem || done();
  });

  // Edicao: dados gerais valem para o aluguel inteiro; itens sao reconciliados
  // individualmente (atualizados, incluidos ou removidos). Itens ja devolvidos
  // sao preservados como estao e nao podem ser alterados/removidos por aqui.
  ipcMain.handle("rental:update", async (_e, data) => {
    const { errors, clean } = rentalRules.validateRentalPayload(data);
    if (errors.length) return fail("VALIDATION", errors.join(" "));

    let problem = null;

    await mutateRentalData(async (state) => {
      const idx = state.rentals.findIndex((r) => r.id === data.id);
      if (idx === -1) {
        problem = fail("NOT_FOUND", "Aluguel nao encontrado (pode ter sido removido).");
        return null;
      }
      const current = state.rentals[idx];
      if (changedSinceBaseline(current, data._baseline, store.keysOf(SCHEMAS.rentals))) {
        problem = fail("CONFLICT", "Este aluguel foi alterado por outro usuario. Recarregue e tente novamente.");
        return null;
      }
      if (!state.agencies.some((a) => a.id === clean.agency_id)) {
        problem = fail("NOT_FOUND", "Agencia nao encontrada.");
        return null;
      }

      const existingItems = state.items.filter((it) => it.rental_id === data.id);
      const existingById = new Map(existingItems.map((it) => [it.id, it]));
      const stamp = nowStamp();

      // Reconciliacao dos itens enviados com os existentes.
      const nextItems = [];
      const keptIds = new Set();
      for (const it of clean.items) {
        const existing = it.id ? existingById.get(it.id) : null;
        if (existing) {
          keptIds.add(existing.id);
          if (existing.status === STATUS.RETURNED) {
            // Item devolvido: preservado como esta (historico imutavel aqui).
            nextItems.push(existing);
          } else {
            const changed =
              existing.material_id !== it.material_id ||
              Number(existing.quantity) !== it.quantity;
            nextItems.push({
              ...existing,
              material_id: it.material_id,
              quantity: it.quantity,
              alterado_em: changed ? stamp : existing.alterado_em,
            });
          }
        } else {
          nextItems.push({
            id: store.newId(),
            rental_id: data.id,
            material_id: it.material_id,
            quantity: it.quantity,
            status: STATUS.RENTED,
            actual_return_date: "",
            adicionado_em: stamp,
            alterado_em: "",
          });
        }
      }
      // Itens devolvidos ausentes do payload tambem sao preservados.
      for (const ex of existingItems) {
        if (ex.status === STATUS.RETURNED && !keptIds.has(ex.id)) nextItems.push(ex);
      }
      if (!nextItems.length) {
        problem = fail("VALIDATION", "O aluguel precisa ter pelo menos um material.");
        return null;
      }

      // Disponibilidade dos itens que ficarao ATIVOS, com dados frescos e
      // desconsiderando os proprios itens deste aluguel.
      const activeToValidate = nextItems
        .filter((it) => it.status === STATUS.RENTED)
        .map((it) => ({ material_id: it.material_id, quantity: Number(it.quantity) }));
      const occupancy = availability.occupancyFromItems(state.rentals, state.items, data.id);
      const issues = rentalRules.checkItemsAvailability(
        activeToValidate,
        state.materials,
        occupancy,
        clean.checkout_date,
        clean.expected_return_date
      );
      if (issues.length) {
        problem = fail("VALIDATION", rentalRules.availabilityMessage(issues));
        return null;
      }

      const nextRentals = [...state.rentals];
      nextRentals[idx] = {
        ...current,
        agency_id: clean.agency_id,
        event_name: clean.event_name,
        process_number: clean.process_number,
        checkout_date: clean.checkout_date,
        expected_return_date: clean.expected_return_date,
        notes: clean.notes,
        alterado_em: stamp,
      };

      return {
        rentals: nextRentals,
        items: [
          ...state.items.filter((it) => it.rental_id !== data.id),
          ...nextItems,
        ],
        attachments: state.attachments,
      };
    });

    return problem || done();
  });

  // Devolucao por item (parcial) ou total. payload:
  //   { id, item_ids?: string[], actual_return_date?: "YYYY-MM-DD" }
  // Sem item_ids, devolve todos os itens ativos (devolucao total).
  ipcMain.handle("rental:return", async (_e, payload) => {
    const id = typeof payload === "string" ? payload : payload?.id;
    const itemIds = Array.isArray(payload?.item_ids) ? payload.item_ids.map(String) : null;
    const providedDate = typeof payload === "object" ? payload?.actual_return_date : "";
    const returnDate = isValidDate(providedDate) ? providedDate : todayStr();

    let problem = null;

    await mutateRentalData(async (state) => {
      const rentalIdx = state.rentals.findIndex((r) => r.id === id);
      if (rentalIdx === -1) {
        problem = fail("NOT_FOUND", "Aluguel nao encontrado.");
        return null;
      }
      const ownItems = state.items.filter((it) => it.rental_id === id);
      const activeItems = ownItems.filter((it) => it.status === STATUS.RENTED);
      if (!activeItems.length) {
        problem = fail("VALIDATION", "Este aluguel ja foi totalmente devolvido.");
        return null;
      }

      const targets = itemIds
        ? activeItems.filter((it) => itemIds.includes(it.id))
        : activeItems;
      if (!targets.length) {
        problem = fail("VALIDATION", "Nenhum item pendente selecionado para devolucao.");
        return null;
      }

      const stamp = nowStamp();
      const targetIds = new Set(targets.map((it) => it.id));
      const nextItems = state.items.map((it) =>
        targetIds.has(it.id)
          ? { ...it, status: STATUS.RETURNED, actual_return_date: returnDate, alterado_em: stamp }
          : it
      );
      const nextRentals = [...state.rentals];
      nextRentals[rentalIdx] = { ...nextRentals[rentalIdx], alterado_em: stamp };

      return { rentals: nextRentals, items: nextItems, attachments: state.attachments };
    });

    return problem || done();
  });

  // Exclusao: remove cabecalho, itens, metadados de anexos e os arquivos
  // fisicos da pasta do aluguel.
  ipcMain.handle("rental:delete", async (_e, id) => {
    await mutateRentalData(async (state) => ({
      rentals: state.rentals.filter((r) => r.id !== id),
      items: state.items.filter((it) => it.rental_id !== id),
      attachments: state.attachments.filter((a) => a.rental_id !== id),
    }));
    attachments.removeRentalDir(settings.getDataDir(), id);
    return done();
  });

  // ------------------------------ Anexos -------------------------------------

  // Abre o dialogo de selecao de arquivos e retorna os escolhidos (caminho,
  // nome e tamanho). Nada e copiado ainda.
  ipcMain.handle("attachment:pick", async () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win, {
      title: "Selecionar anexos",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Arquivos permitidos", extensions: attachments.ALLOWED_EXTENSIONS },
        { name: "Todos os arquivos", extensions: ["*"] },
      ],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const files = res.filePaths.map((p) => {
      let size = 0;
      try {
        size = fs.statSync(p).size;
      } catch (_err) {}
      const name = path.basename(p);
      const check = attachments.validateSource(p, name);
      return { path: p, name, size, valid: check.ok, message: check.ok ? "" : check.message };
    });
    return done({ files });
  });

  // Adiciona anexos a um aluguel ja existente.
  ipcMain.handle("attachment:add", async (_e, payload) => {
    const rentalId = String(payload?.rental_id || "");
    const files = normalizeFilesPayload(payload?.files);
    if (!rentalId || !files.length) return fail("VALIDATION", "Nenhum arquivo selecionado.");

    for (const f of files) {
      const check = attachments.validateSource(f.path, f.name);
      if (!check.ok) return fail("VALIDATION", check.message);
    }

    let problem = null;
    let addedRows = [];

    try {
      await mutateRentalData(async (state) => {
        if (!state.rentals.some((r) => r.id === rentalId)) {
          problem = fail("NOT_FOUND", "Aluguel nao encontrado.");
          return null;
        }
        const stamp = nowStamp();
        try {
          addedRows = copyAttachmentFiles(rentalId, files, stamp);
        } catch (err) {
          if (err && err.code === "ATTACH_VALIDATION") {
            problem = fail("VALIDATION", err.message);
            return null;
          }
          throw err;
        }
        return {
          rentals: state.rentals,
          items: state.items,
          attachments: [...state.attachments, ...addedRows],
        };
      });
    } catch (err) {
      // Gravacao falhou apos a copia: remove os arquivos recem-copiados.
      const dataDir = settings.getDataDir();
      for (const row of addedRows) attachments.removeStoredFile(dataDir, row.rel_path);
      throw err;
    }

    if (problem) return problem;
    return done({ attachments: addedRows });
  });

  // Remove um anexo: apaga o registro e o arquivo fisico (a confirmacao e
  // feita na interface antes de chamar este handler).
  ipcMain.handle("attachment:remove", async (_e, attachmentId) => {
    let removedRelPath = null;
    let notFound = false;

    await mutateRentalData(async (state) => {
      const row = state.attachments.find((a) => a.id === attachmentId);
      if (!row) {
        notFound = true;
        return null;
      }
      removedRelPath = row.rel_path;
      return {
        rentals: state.rentals,
        items: state.items,
        attachments: state.attachments.filter((a) => a.id !== attachmentId),
      };
    });

    if (notFound) return fail("NOT_FOUND", "Anexo nao encontrado.");
    if (removedRelPath) attachments.removeStoredFile(settings.getDataDir(), removedRelPath);
    return done();
  });

  // Abre o arquivo anexado com o aplicativo padrao do sistema.
  ipcMain.handle("attachment:open", async (_e, attachmentId) => {
    ensureAllFiles();
    const rows = readEntity("attachments");
    const row = rows.find((a) => a.id === attachmentId);
    if (!row) return fail("NOT_FOUND", "Anexo nao encontrado.");
    const dataDir = settings.getDataDir();
    const abs = attachments.absolutePathOf(dataDir, row.rel_path);
    if (!abs || !fs.existsSync(abs)) {
      return fail(
        "MISSING",
        `O arquivo "${row.file_name}" nao foi encontrado na pasta de dados. Ele pode ter sido movido ou removido externamente.`
      );
    }
    const errMsg = await shell.openPath(abs);
    if (errMsg) return fail("OPEN_FAILED", `Nao foi possivel abrir o arquivo: ${errMsg}`);
    return done();
  });
}

module.exports = { registerIpc, ensureAllFiles, getLastWriteAt };
