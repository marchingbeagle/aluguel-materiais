"use strict";

const crypto = require("crypto");
const Papa = require("papaparse");

const dateUtils = require("../shared/dates");

const TYPE_IN = "entrada";
const TYPE_OUT = "saida";

const PRODUCT_TEMPLATE_HEADERS = [
  "codigo_produto",
  "descricao",
  "categoria",
  "fornecedor",
  "estoque_minimo",
  "estoque_maximo",
  "observacoes",
];

const MOVEMENT_TEMPLATE_HEADERS = [
  "codigo_produto",
  "produto",
  "tipo",
  "data_movimentacao",
  "quantidade",
  "valor_unitario",
  "valor_transacao",
  "observacoes",
];

function normalizeHeader(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/["'()]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function text(value) {
  return String(value ?? "").trim();
}

function parseNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  let v = text(value);
  if (!v) return 0;
  v = v.replace(/\s/g, "").replace(/^R\$/i, "");
  if (v.includes(",") && v.includes(".")) v = v.replace(/\./g, "").replace(",", ".");
  else if (v.includes(",")) v = v.replace(",", ".");
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseIntNonNegative(value) {
  const n = parseNumber(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function excelSerialToISO(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0) return "";
  const ms = Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function parseDate(value) {
  if (typeof value === "number") return excelSerialToISO(value);
  const v = text(value);
  if (!v) return "";
  if (/^\d+(\.\d+)?$/.test(v)) return excelSerialToISO(Number(v));
  if (dateUtils.isValidISO(v)) return v;
  const fromBR = dateUtils.brToISO(v);
  return fromBR && dateUtils.isValidISO(fromBR) ? fromBR : "";
}

function normalizeType(value) {
  const v = normalizeHeader(value);
  if (["entrada", "entradas", "in", "e"].includes(v)) return TYPE_IN;
  if (["saida", "saidas", "sai_da", "out", "s"].includes(v)) return TYPE_OUT;
  return "";
}

function stockStatus(current, min, max) {
  const qty = Number(current) || 0;
  const minimum = Number(min) || 0;
  const maximum = Number(max) || 0;
  if (qty <= 0) return { key: "empty", label: "Sem estoque" };
  if (minimum > 0 && qty < minimum) return { key: "low", label: "Abaixo do minimo" };
  if (maximum >= 0 && qty > maximum) return { key: "excess", label: "Estoque excedente" };
  return { key: "ok", label: "Dentro da faixa" };
}

function movementSignedQuantity(movement) {
  const qty = Number(movement.quantity) || 0;
  return movement.type === TYPE_OUT ? -qty : qty;
}

function movementTotalValue(movement) {
  const total = parseNumber(movement.total_value);
  if (total > 0) return total;
  const unit = parseNumber(movement.unit_cost);
  const qty = parseNumber(movement.quantity);
  return unit > 0 && qty > 0 ? unit * qty : 0;
}

function emptyInventoryAgg() {
  return { current: 0, entries: 0, exits: 0, purchaseQty: 0, purchaseValue: 0, lastMovement: "" };
}

function ensureInventoryAgg(map, productId) {
  if (!map.has(productId)) map.set(productId, emptyInventoryAgg());
  return map.get(productId);
}

function applyMovementToInventory(agg, movement) {
  const qty = Number(movement.quantity) || 0;
  if (movement.type === TYPE_OUT) {
    agg.exits += qty;
    agg.current -= qty;
    return;
  }

  agg.entries += qty;
  agg.current += qty;
  const value = movementTotalValue(movement);
  if (value > 0) {
    agg.purchaseQty += qty;
    agg.purchaseValue += value;
  }
}

function updateLastMovement(agg, movementDate) {
  if (movementDate && (!agg.lastMovement || movementDate > agg.lastMovement)) {
    agg.lastMovement = movementDate;
  }
}

function buildInventory(products, movements) {
  const movementRows = Array.isArray(movements) ? movements : [];
  const byProduct = new Map();

  for (const m of movementRows) {
    const productId = text(m.product_id);
    if (!productId) continue;
    const agg = ensureInventoryAgg(byProduct, productId);
    applyMovementToInventory(agg, m);
    updateLastMovement(agg, m.movement_date);
  }

  return (Array.isArray(products) ? products : []).map((p) => {
    const agg = byProduct.get(p.id) || emptyInventoryAgg();
    const avgCost = agg.purchaseQty > 0 ? agg.purchaseValue / agg.purchaseQty : 0;
    const minStock = Number(p.min_stock) || 0;
    const maxStock = Number(p.max_stock) || 0;
    const status = stockStatus(agg.current, minStock, maxStock);
    return {
      ...p,
      current_stock: agg.current,
      entries: agg.entries,
      exits: agg.exits,
      avg_cost: avgCost,
      stock_value: agg.current * avgCost,
      last_movement_date: agg.lastMovement,
      status: status.key,
      status_label: status.label,
    };
  });
}

function buildStats(inventory, movements) {
  const rows = Array.isArray(inventory) ? inventory : [];
  const moveRows = Array.isArray(movements) ? movements : [];
  const byStatus = rows.reduce((acc, p) => {
    acc[p.status] = (acc[p.status] || 0) + 1;
    return acc;
  }, {});
  const totalStock = rows.reduce((sum, p) => sum + (Number(p.current_stock) || 0), 0);
  const totalValue = rows.reduce((sum, p) => sum + (Number(p.stock_value) || 0), 0);
  const month = new Date().toISOString().slice(0, 7);
  return {
    totalProducts: rows.length,
    totalStock,
    totalValue,
    lowProducts: (byStatus.low || 0) + (byStatus.empty || 0),
    excessProducts: byStatus.excess || 0,
    movementsThisMonth: moveRows.filter((m) => String(m.movement_date || "").slice(0, 7) === month).length,
    byStatus,
  };
}

function readCell(row, aliases) {
  for (const alias of aliases) {
    if (row[alias] !== undefined) return row[alias];
  }
  return "";
}

function normalizeRawRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row || {})) {
    out[normalizeHeader(key)] = value;
  }
  return out;
}

function parseCsvRows(csvText) {
  const raw = String(csvText || "").replace(/^\uFEFF/, "");
  const firstLine = raw.split(/\r?\n/, 1)[0] || "";
  const delimiter = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ";" : ",";
  const result = Papa.parse(raw, {
    header: true,
    delimiter,
    skipEmptyLines: "greedy",
    transformHeader: (h) => String(h || "").trim(),
  });
  return Array.isArray(result.data) ? result.data.map(normalizeRawRow) : [];
}

function productFromRaw(row, stamp) {
  const id = text(readCell(row, ["codigo_produto", "codigo_do_produto", "codigo", "id", "cod_produto"]));
  const name = text(readCell(row, ["descricao", "produto", "nome", "name"]));
  if (!id || !name) return null;
  return {
    id,
    name,
    category: text(readCell(row, ["categoria", "category"])),
    supplier: text(readCell(row, ["fornecedor", "supplier"])),
    min_stock: parseIntNonNegative(readCell(row, ["estoque_minimo", "minimo", "min_stock"])),
    max_stock: parseIntNonNegative(readCell(row, ["estoque_maximo", "maximo", "max_stock"])),
    notes: text(readCell(row, ["observacoes", "observacao", "notes"])),
    adicionado_em: stamp,
    alterado_em: "",
  };
}

function movementId(row, clean) {
  const explicit = text(readCell(row, ["id", "identificador"]));
  if (explicit) return explicit;
  const sig = [
    clean.product_id,
    clean.type,
    clean.movement_date,
    clean.quantity,
    clean.unit_cost,
    clean.total_value,
    clean.notes,
  ].join("|");
  return "mov-" + crypto.createHash("sha1").update(sig).digest("hex").slice(0, 16);
}

function movementFromRaw(row, stamp) {
  const productId = text(readCell(row, ["codigo_produto", "codigo_do_produto", "codigo", "id_produto", "product_id"]));
  const type = normalizeType(readCell(row, ["tipo", "entrada_saida", "entradas_saida", "entradas_saidas", "entrada_saida"]));
  const movementDate = parseDate(readCell(row, ["data_movimentacao", "data_da_movimentacao", "data", "movement_date"]));
  const quantity = parseIntNonNegative(readCell(row, ["quantidade", "qtd", "quantity"]));
  if (!productId || !type || !movementDate || quantity <= 0) return null;
  const unitCost = parseNumber(readCell(row, ["valor_unitario", "valor_de_compra_unitario", "preco_unitario", "unit_cost"]));
  const totalValue = parseNumber(readCell(row, ["valor_transacao", "valor_da_transacao", "valor_total", "total_value"]));
  const clean = {
    id: "",
    product_id: productId,
    type,
    movement_date: movementDate,
    quantity,
    unit_cost: unitCost,
    total_value: totalValue || (unitCost > 0 ? unitCost * quantity : 0),
    notes: text(readCell(row, ["observacoes", "observacao", "notes"])),
    adicionado_em: stamp,
    alterado_em: "",
  };
  clean.id = movementId(row, clean);
  return clean;
}

function parseProductsCsv(csvText, stamp) {
  return parseCsvRows(csvText).map((row) => productFromRaw(row, stamp)).filter(Boolean);
}

function parseMovementsCsv(csvText, stamp) {
  return parseCsvRows(csvText).map((row) => movementFromRaw(row, stamp)).filter(Boolean);
}

function templateCsv(kind) {
  const headers = kind === "movements" ? MOVEMENT_TEMPLATE_HEADERS : PRODUCT_TEMPLATE_HEADERS;
  const sample =
    kind === "movements"
      ? ["1", "Produto exemplo", "Entrada", "2026-01-31", "10", "2,50", "25,00", ""]
      : ["1", "Produto exemplo", "Categoria", "Fornecedor", "5", "100", ""];
  return "\uFEFF" + Papa.unparse({ fields: headers, data: [sample] }, { delimiter: ";" }) + "\n";
}

module.exports = {
  TYPE_IN,
  TYPE_OUT,
  normalizeHeader,
  parseNumber,
  parseDate,
  normalizeType,
  stockStatus,
  movementSignedQuantity,
  movementTotalValue,
  buildInventory,
  buildStats,
  parseProductsCsv,
  parseMovementsCsv,
  templateCsv,
};
