"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Papa = require("papaparse");

// Delimitador dos CSV. Ponto-e-virgula e o padrao do Excel em pt-BR.
const DELIMITER = ";";
// BOM UTF-8: ajuda o Excel a abrir os arquivos com acentuacao correta.
const BOM = "\uFEFF";

// Esquema de cada arquivo. "key" e o nome interno usado no codigo (em ingles);
// "header" e o nome da coluna gravado no CSV (em portugues). A ordem aqui e a
// ordem das colunas no arquivo.
const TIMESTAMP_COLUMNS = [
  { key: "adicionado_em", header: "adicionado_em" },
  { key: "alterado_em", header: "alterado_em" },
];

const SCHEMAS = {
  materials: [
    { key: "id", header: "id" },
    { key: "name", header: "nome" },
    { key: "description", header: "descricao" },
    { key: "total_quantity", header: "quantidade_total" },
    { key: "notes", header: "observacoes" },
    { key: "color", header: "cor" },
    ...TIMESTAMP_COLUMNS,
  ],
  agencies: [
    { key: "id", header: "id" },
    { key: "code", header: "codigo" },
    { key: "name", header: "nome" },
    { key: "contact_person", header: "contato" },
    { key: "phone", header: "telefone" },
    { key: "email", header: "email" },
    { key: "notes", header: "observacoes" },
    ...TIMESTAMP_COLUMNS,
  ],
  // Dados gerais do aluguel (cabecalho). Os materiais ficam em itens_aluguel.csv.
  rentals: [
    { key: "id", header: "id" },
    { key: "agency_id", header: "id_agencia" },
    { key: "event_name", header: "nome_evento" },
    { key: "process_number", header: "numero_processo" },
    { key: "checkout_date", header: "data_retirada" },
    { key: "expected_return_date", header: "data_prevista_devolucao" },
    { key: "notes", header: "observacoes" },
    ...TIMESTAMP_COLUMNS,
  ],
  // Itens (materiais) de cada aluguel. Situacao/devolucao controladas por item,
  // permitindo devolucao parcial.
  rentalItems: [
    { key: "id", header: "id" },
    { key: "rental_id", header: "id_aluguel" },
    { key: "material_id", header: "id_material" },
    { key: "quantity", header: "quantidade" },
    { key: "status", header: "situacao" },
    { key: "actual_return_date", header: "data_devolucao" },
    ...TIMESTAMP_COLUMNS,
  ],
  // Metadados dos anexos. O arquivo fisico fica em anexos/alugueis/<id_aluguel>/,
  // e caminho_relativo e sempre relativo a pasta de dados (nunca absoluto).
  attachments: [
    { key: "id", header: "id" },
    { key: "rental_id", header: "id_aluguel" },
    { key: "file_name", header: "nome_original" },
    { key: "rel_path", header: "caminho_relativo" },
    { key: "size", header: "tamanho_bytes" },
    ...TIMESTAMP_COLUMNS,
  ],
  stockProducts: [
    { key: "id", header: "codigo_produto" },
    { key: "name", header: "descricao" },
    { key: "category", header: "categoria" },
    { key: "supplier", header: "fornecedor" },
    { key: "min_stock", header: "estoque_minimo" },
    { key: "max_stock", header: "estoque_maximo" },
    { key: "notes", header: "observacoes" },
    ...TIMESTAMP_COLUMNS,
  ],
  stockMovements: [
    { key: "id", header: "id" },
    { key: "product_id", header: "codigo_produto" },
    { key: "type", header: "tipo" },
    { key: "movement_date", header: "data_movimentacao" },
    { key: "quantity", header: "quantidade" },
    { key: "unit_cost", header: "valor_unitario" },
    { key: "total_value", header: "valor_transacao" },
    { key: "notes", header: "observacoes" },
    ...TIMESTAMP_COLUMNS,
  ],
};

// Esquema do alugueis.csv da versao anterior (um material por aluguel).
// Usado apenas pela migracao para o modelo com itens.
const LEGACY_RENTALS_SCHEMA = [
  { key: "id", header: "id" },
  { key: "material_id", header: "id_material" },
  { key: "agency_id", header: "id_agencia" },
  { key: "quantity", header: "quantidade" },
  { key: "checkout_date", header: "data_retirada" },
  { key: "expected_return_date", header: "data_prevista_devolucao" },
  { key: "actual_return_date", header: "data_devolucao" },
  { key: "status", header: "situacao" },
  { key: "notes", header: "observacoes" },
  ...TIMESTAMP_COLUMNS,
];

// Cabecalhos das versoes antigas (delimitador virgula, nomes em ingles).
// Usado apenas pela migracao. Mapeia header_antigo -> key interna.
const LEGACY_HEADER_TO_KEY = {
  id: "id",
  name: "name",
  description: "description",
  total_quantity: "total_quantity",
  notes: "notes",
  color: "color",
  contact_person: "contact_person",
  phone: "phone",
  email: "email",
  material_id: "material_id",
  agency_id: "agency_id",
  quantity: "quantity",
  checkout_date: "checkout_date",
  expected_return_date: "expected_return_date",
  actual_return_date: "actual_return_date",
  status: "status",
};

// Colunas numericas (por key interna), convertidas para Number na leitura.
const NUMERIC_FIELDS = new Set(["total_quantity", "quantity", "size", "min_stock", "max_stock", "unit_cost", "total_value"]);

function headersOf(schema) {
  return schema.map((c) => c.header);
}

function keysOf(schema) {
  return schema.map((c) => c.key);
}

function headerLine(schema) {
  return Papa.unparse([headersOf(schema)], { delimiter: DELIMITER }) + "\n";
}

// Cria o arquivo com cabecalho caso ele nao exista.
function ensureFile(filePath, schema) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, BOM + headerLine(schema), "utf8");
  }
}

// Le e converte um arquivo CSV em uma lista de objetos com keys internas.
// Tolera linhas malformadas, colunas faltando/sobrando e arquivo inexistente.
function readAll(filePath, schema) {
  if (!fs.existsSync(filePath)) return [];

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  // Remove BOM que o Excel costuma inserir.
  raw = raw.replace(/^\uFEFF/, "");
  if (!raw.trim()) return [];

  const result = Papa.parse(raw, {
    header: true,
    delimiter: DELIMITER,
    skipEmptyLines: "greedy",
    transformHeader: (h) => String(h || "").trim(),
  });

  const rows = Array.isArray(result.data) ? result.data : [];

  return rows
    .map((row) => normalizeRow(row, schema))
    .filter((row) => row !== null);
}

// Converte uma linha lida (chaveada pelo header do CSV) em objeto com keys internas.
function normalizeRow(row, schema) {
  if (!row || typeof row !== "object") return null;

  const out = {};
  for (const col of schema) {
    let value = row[col.header];
    value = value === undefined || value === null ? "" : String(value).trim();

    if (NUMERIC_FIELDS.has(col.key)) {
      const num = Number(value);
      out[col.key] = Number.isFinite(num) ? num : 0;
    } else {
      out[col.key] = value;
    }
  }

  // Linha sem id e considerada lixo e descartada.
  if (!out.id) return null;
  return out;
}

// Gravacao atomica: escreve em arquivo temporario e renomeia por cima.
// Evita arquivos truncados/corrompidos caso a escrita seja interrompida.
function writeAll(filePath, schema, rows) {
  const headers = headersOf(schema);
  // PapaParse cuida do escape automatico de valores que contenham o
  // delimitador, aspas ou quebras de linha.
  const csv = Papa.unparse(
    {
      fields: headers,
      data: rows.map((r) => schema.map((c) => (r[c.key] === undefined || r[c.key] === null ? "" : r[c.key]))),
    },
    { delimiter: DELIMITER }
  );

  const body = csv.endsWith("\n") ? csv : csv + "\n";
  const content = BOM + body;
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, content, "utf8");
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Em alguns sistemas/cloud o rename por cima pode falhar; tenta limpar o tmp.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Se a limpeza falhar, o erro original de rename continua sendo propagado.
    }
    throw err;
  }
}

function valueFromLegacyRow(row, col) {
  for (const [oldHeader, key] of Object.entries(LEGACY_HEADER_TO_KEY)) {
    if (key === col.key && row[oldHeader] !== undefined) return row[oldHeader];
  }
  return "";
}

function normalizeLegacyRow(row, schema) {
  if (!row || typeof row !== "object") return null;

  const out = {};
  for (const col of schema) {
    const value = valueFromLegacyRow(row, col);
    out[col.key] = value === undefined || value === null ? "" : String(value).trim();
  }

  out.adicionado_em = "";
  out.alterado_em = "";
  return out.id ? out : null;
}

// Migra um arquivo do formato antigo (virgula + cabecalhos em ingles) para o
// novo arquivo (ponto-e-virgula + cabecalhos em portugues + colunas de data).
// So roda quando o arquivo novo ainda nao existe e o antigo existe.
// O arquivo antigo e preservado como backup implicito.
function migrateLegacy(oldPath, newPath, schema) {
  if (fs.existsSync(newPath) || !fs.existsSync(oldPath)) return false;

  let raw;
  try {
    raw = fs.readFileSync(oldPath, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return false;
  }

  const result = Papa.parse(raw, {
    header: true,
    delimiter: ",",
    skipEmptyLines: "greedy",
    transformHeader: (h) => String(h || "").trim(),
  });

  const legacyRows = Array.isArray(result.data) ? result.data : [];
  const rows = legacyRows.map((row) => normalizeLegacyRow(row, schema)).filter(Boolean);

  writeAll(newPath, schema, rows);
  return true;
}

// Migra o alugueis.csv da versao anterior (um material por linha) para o novo
// modelo: dados gerais em alugueis.csv + materiais em itens_aluguel.csv.
//
// Deteccao: o cabecalho antigo contem a coluna "id_material". So roda nesse
// caso, entao e seguro chamar em toda inicializacao.
//
// Garantias:
//   - O id do aluguel e preservado (o registro antigo vira o cabecalho).
//   - O material vira o primeiro item, com id deterministico "<id>-i1"
//     (re-rodar a migracao apos uma falha parcial nao duplica itens).
//   - O arquivo antigo e copiado como backup antes de qualquer gravacao.
//   - Os itens sao gravados antes do novo alugueis.csv: se o processo cair no
//     meio, o arquivo antigo continua intacto e a migracao roda de novo.
function migrateRentalsToItems(rentalsPath, itemsPath, rentalsSchema, itemsSchema) {
  if (!fs.existsSync(rentalsPath)) return false;
  const header = readHeaderLine(rentalsPath);
  if (!header || !header.includes("id_material")) return false;

  const legacyRows = readAll(rentalsPath, LEGACY_RENTALS_SCHEMA);

  // Backup do arquivo original (preserva os dados antigos intactos).
  const dir = path.dirname(rentalsPath);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  let backupPath = path.join(dir, `alugueis-backup-${stamp}.csv`);
  for (let n = 2; fs.existsSync(backupPath); n++) {
    backupPath = path.join(dir, `alugueis-backup-${stamp}-${n}.csv`);
  }
  fs.copyFileSync(rentalsPath, backupPath);

  const rentals = [];
  const items = [];
  for (const old of legacyRows) {
    rentals.push({
      id: old.id,
      agency_id: old.agency_id,
      event_name: "",
      process_number: "",
      checkout_date: old.checkout_date,
      expected_return_date: old.expected_return_date,
      notes: old.notes,
      adicionado_em: old.adicionado_em,
      alterado_em: old.alterado_em,
    });
    items.push({
      id: `${old.id}-i1`,
      rental_id: old.id,
      material_id: old.material_id,
      quantity: old.quantity,
      status: old.status || "alugado",
      actual_return_date: old.actual_return_date,
      adicionado_em: old.adicionado_em,
      alterado_em: old.alterado_em,
    });
  }

  // Preserva itens ja existentes de outros alugueis (caso raro de arquivo de
  // itens criado antes da migracao), sem duplicar os que serao regravados.
  let existingItems = [];
  if (fs.existsSync(itemsPath)) {
    const migratedIds = new Set(items.map((it) => it.id));
    existingItems = readAll(itemsPath, itemsSchema).filter((it) => !migratedIds.has(it.id));
  }

  writeAll(itemsPath, itemsSchema, [...existingItems, ...items]);
  writeAll(rentalsPath, rentalsSchema, rentals);
  return true;
}

// Le apenas a primeira linha (cabecalho) do arquivo, sem carregar tudo.
function readHeaderLine(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  raw = raw.replace(/^\uFEFF/, "");
  const firstLine = raw.split(/\r?\n/, 1)[0] || "";
  if (!firstLine.trim()) return [];
  const parsed = Papa.parse(firstLine, { delimiter: DELIMITER });
  const fields = Array.isArray(parsed.data) && parsed.data.length ? parsed.data[0] : [];
  return fields.map((h) => String(h || "").trim());
}

// Reconcilia o cabecalho de um arquivo ja no formato novo com o schema atual.
// Se faltarem colunas (ex.: "codigo") ou houver colunas removidas (ex.: "categoria"),
// rele de forma tolerante e regrava com o schema novo. Nenhum dado e perdido:
// colunas ausentes viram "" e colunas desconhecidas sao ignoradas.
// Retorna true quando o arquivo foi reescrito.
function reconcileSchema(filePath, schema) {
  if (!fs.existsSync(filePath)) return false;
  const existing = readHeaderLine(filePath);
  if (existing === null) return false;

  const expected = headersOf(schema);
  const sameHeaders =
    existing.length === expected.length && existing.every((h, i) => h === expected[i]);
  if (sameHeaders) return false;

  const rows = readAll(filePath, schema);
  writeAll(filePath, schema, rows);
  return true;
}

// Assinatura simples do estado do arquivo (mtime + tamanho) para detectar
// mudancas externas sem reler todo o conteudo.
function fileSignature(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
}

function newId() {
  // Cronologicamente ordenavel + sufixo aleatorio para evitar colisoes entre PCs.
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

module.exports = {
  SCHEMAS,
  LEGACY_RENTALS_SCHEMA,
  DELIMITER,
  headersOf,
  keysOf,
  ensureFile,
  readAll,
  writeAll,
  migrateLegacy,
  migrateRentalsToItems,
  reconcileSchema,
  fileSignature,
  newId,
};
