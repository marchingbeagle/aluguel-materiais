"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const store = require("../src/main/csvStore");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aluguel-materiais-"));
}

function readWithoutBom(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
}

describe("csvStore", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("creates a CSV file with BOM, Portuguese headers, and semicolon delimiter", () => {
    const filePath = path.join(tempDir, "nested", "materiais.csv");

    store.ensureFile(filePath, store.SCHEMAS.materials);

    const content = fs.readFileSync(filePath, "utf8");
    const firstLine = content.replace(/^\uFEFF/, "").split(/\r?\n/)[0];

    expect(content.charCodeAt(0)).toBe(0xfeff);
    expect(firstLine).toBe("id;nome;descricao;quantidade_total;observacoes;cor;adicionado_em;alterado_em");
  });

  test("writes and reads rows while preserving fields and converting numeric values", () => {
    const filePath = path.join(tempDir, "materiais.csv");

    store.writeAll(filePath, store.SCHEMAS.materials, [
      {
        id: "m1",
        name: "Banner",
        description: "Banner; grande",
        total_quantity: "12",
        notes: null,
        color: "#ffffff",
        adicionado_em: "2026-06-01 10:00:00",
        alterado_em: "",
      },
    ]);

    const content = readWithoutBom(filePath);
    const rows = store.readAll(filePath, store.SCHEMAS.materials);

    expect(content).toContain('"Banner; grande"');
    expect(rows).toEqual([
      {
        id: "m1",
        name: "Banner",
        description: "Banner; grande",
        total_quantity: 12,
        notes: "",
        color: "#ffffff",
        adicionado_em: "2026-06-01 10:00:00",
        alterado_em: "",
      },
    ]);
  });

  test("ignores rows without id and converts invalid numeric fields to zero", () => {
    const filePath = path.join(tempDir, "materiais.csv");
    const csv = [
      "id;nome;descricao;quantidade_total;observacoes;cor;adicionado_em;alterado_em",
      ";Sem id;;99;;;;",
      "m1;Balao;;abc;;;;",
    ].join("\n");
    fs.writeFileSync(filePath, `\uFEFF${csv}\n`, "utf8");

    expect(store.readAll(filePath, store.SCHEMAS.materials)).toEqual([
      {
        id: "m1",
        name: "Balao",
        description: "",
        total_quantity: 0,
        notes: "",
        color: "",
        adicionado_em: "",
        alterado_em: "",
      },
    ]);
  });

  test("migrates legacy comma-delimited CSV files to the current schema", () => {
    const oldPath = path.join(tempDir, "materials.csv");
    const newPath = path.join(tempDir, "materiais.csv");
    fs.writeFileSync(
      oldPath,
      [
        "id,name,description,total_quantity,notes,color",
        "m1,Banner,Grande,7,Observacao,#123456",
      ].join("\n"),
      "utf8"
    );

    const migrated = store.migrateLegacy(oldPath, newPath, store.SCHEMAS.materials);

    expect(migrated).toBe(true);
    expect(fs.existsSync(oldPath)).toBe(true);
    expect(readWithoutBom(newPath).split(/\r?\n/)[0]).toBe(
      "id;nome;descricao;quantidade_total;observacoes;cor;adicionado_em;alterado_em"
    );
    expect(store.readAll(newPath, store.SCHEMAS.materials)).toEqual([
      {
        id: "m1",
        name: "Banner",
        description: "Grande",
        total_quantity: 7,
        notes: "Observacao",
        color: "#123456",
        adicionado_em: "",
        alterado_em: "",
      },
    ]);
  });

  test("reconciles an outdated schema without losing valid rows", () => {
    const filePath = path.join(tempDir, "agencias.csv");
    const csv = [
      "id;nome;contato;telefone;email;observacoes;adicionado_em;alterado_em",
      "a1;Agencia Centro;Ana;1111;ana@example.com;Obs;2026-06-01 10:00:00;",
    ].join("\n");
    fs.writeFileSync(filePath, `\uFEFF${csv}\n`, "utf8");

    const reconciled = store.reconcileSchema(filePath, store.SCHEMAS.agencies);

    expect(reconciled).toBe(true);
    expect(readWithoutBom(filePath).split(/\r?\n/)[0]).toBe(
      "id;codigo;nome;contato;telefone;email;observacoes;adicionado_em;alterado_em"
    );
    expect(store.readAll(filePath, store.SCHEMAS.agencies)).toEqual([
      {
        id: "a1",
        code: "",
        name: "Agencia Centro",
        contact_person: "Ana",
        phone: "1111",
        email: "ana@example.com",
        notes: "Obs",
        adicionado_em: "2026-06-01 10:00:00",
        alterado_em: "",
      },
    ]);
  });
});
