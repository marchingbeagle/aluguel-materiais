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

  describe("migrateRentalsToItems (aluguel com um material -> cabecalho + itens)", () => {
    const OLD_HEADER =
      "id;id_material;id_agencia;quantidade;data_retirada;data_prevista_devolucao;data_devolucao;situacao;observacoes;adicionado_em;alterado_em";

    function writeOldRentals(filePath, rows) {
      fs.writeFileSync(filePath, `\uFEFF${[OLD_HEADER, ...rows].join("\n")}\n`, "utf8");
    }

    test("cada aluguel antigo vira um aluguel principal com o material como primeiro item", () => {
      const rentalsPath = path.join(tempDir, "alugueis.csv");
      const itemsPath = path.join(tempDir, "itens_aluguel.csv");
      writeOldRentals(rentalsPath, [
        "r1;m1;a1;2;2026-06-08;2026-06-09;;alugado;Obs do aluguel;2026-06-08 10:00:00;",
        "r2;m2;a2;1;2026-05-01;2026-05-02;2026-05-02;devolvido;;2026-05-01 09:00:00;2026-05-02 09:00:00",
      ]);

      const migrated = store.migrateRentalsToItems(
        rentalsPath,
        itemsPath,
        store.SCHEMAS.rentals,
        store.SCHEMAS.rentalItems
      );
      expect(migrated).toBe(true);

      const rentals = store.readAll(rentalsPath, store.SCHEMAS.rentals);
      const items = store.readAll(itemsPath, store.SCHEMAS.rentalItems);

      // Nenhum dado perdido: ids, agencia, datas e observacoes preservados.
      expect(rentals).toEqual([
        {
          id: "r1",
          agency_id: "a1",
          event_name: "",
          checkout_date: "2026-06-08",
          expected_return_date: "2026-06-09",
          notes: "Obs do aluguel",
          adicionado_em: "2026-06-08 10:00:00",
          alterado_em: "",
        },
        {
          id: "r2",
          agency_id: "a2",
          event_name: "",
          checkout_date: "2026-05-01",
          expected_return_date: "2026-05-02",
          notes: "",
          adicionado_em: "2026-05-01 09:00:00",
          alterado_em: "2026-05-02 09:00:00",
        },
      ]);
      // Material, quantidade, situacao e devolucao preservados no item.
      expect(items).toEqual([
        {
          id: "r1-i1",
          rental_id: "r1",
          material_id: "m1",
          quantity: 2,
          status: "alugado",
          actual_return_date: "",
          adicionado_em: "2026-06-08 10:00:00",
          alterado_em: "",
        },
        {
          id: "r2-i1",
          rental_id: "r2",
          material_id: "m2",
          quantity: 1,
          status: "devolvido",
          actual_return_date: "2026-05-02",
          adicionado_em: "2026-05-01 09:00:00",
          alterado_em: "2026-05-02 09:00:00",
        },
      ]);
    });

    test("cria um backup do arquivo antigo antes de regravar", () => {
      const rentalsPath = path.join(tempDir, "alugueis.csv");
      const itemsPath = path.join(tempDir, "itens_aluguel.csv");
      writeOldRentals(rentalsPath, ["r1;m1;a1;2;2026-06-08;2026-06-09;;alugado;;;"]);

      store.migrateRentalsToItems(rentalsPath, itemsPath, store.SCHEMAS.rentals, store.SCHEMAS.rentalItems);

      const backups = fs.readdirSync(tempDir).filter((f) => /^alugueis-backup-.*\.csv$/.test(f));
      expect(backups).toHaveLength(1);
      const backupContent = readWithoutBom(path.join(tempDir, backups[0]));
      expect(backupContent.split(/\r?\n/)[0]).toBe(OLD_HEADER);
      expect(backupContent).toContain("r1;m1;a1;2");
    });

    test("nao roda quando o arquivo ja esta no formato novo (idempotente)", () => {
      const rentalsPath = path.join(tempDir, "alugueis.csv");
      const itemsPath = path.join(tempDir, "itens_aluguel.csv");
      writeOldRentals(rentalsPath, ["r1;m1;a1;2;2026-06-08;2026-06-09;;alugado;;;"]);

      expect(
        store.migrateRentalsToItems(rentalsPath, itemsPath, store.SCHEMAS.rentals, store.SCHEMAS.rentalItems)
      ).toBe(true);
      // Segunda chamada: cabecalho ja novo, nada a fazer.
      expect(
        store.migrateRentalsToItems(rentalsPath, itemsPath, store.SCHEMAS.rentals, store.SCHEMAS.rentalItems)
      ).toBe(false);
      expect(store.readAll(itemsPath, store.SCHEMAS.rentalItems)).toHaveLength(1);
    });

    test("re-rodar apos falha parcial nao duplica itens (ids deterministicos)", () => {
      const rentalsPath = path.join(tempDir, "alugueis.csv");
      const itemsPath = path.join(tempDir, "itens_aluguel.csv");
      writeOldRentals(rentalsPath, ["r1;m1;a1;2;2026-06-08;2026-06-09;;alugado;;;"]);

      // Simula falha apos gravar os itens: o arquivo de itens ja existe com a
      // linha migrada, mas o alugueis.csv continua no formato antigo.
      store.writeAll(itemsPath, store.SCHEMAS.rentalItems, [
        {
          id: "r1-i1",
          rental_id: "r1",
          material_id: "m1",
          quantity: 2,
          status: "alugado",
          actual_return_date: "",
          adicionado_em: "",
          alterado_em: "",
        },
      ]);

      store.migrateRentalsToItems(rentalsPath, itemsPath, store.SCHEMAS.rentals, store.SCHEMAS.rentalItems);
      const items = store.readAll(itemsPath, store.SCHEMAS.rentalItems);
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe("r1-i1");
    });
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
