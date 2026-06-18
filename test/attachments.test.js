"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const attachments = require("../src/main/attachments");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("attachments", () => {
  let dataDir;
  let srcDir;

  beforeEach(() => {
    dataDir = makeTempDir("aluguel-anexos-data-");
    srcDir = makeTempDir("aluguel-anexos-src-");
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  function makeSource(name, content = "conteudo") {
    const p = path.join(srcDir, name);
    fs.writeFileSync(p, content, "utf8");
    return p;
  }

  describe("sanitizeFileName", () => {
    test("remove caracteres invalidos e normaliza a extensao", () => {
      expect(attachments.sanitizeFileName("relat?rio*final<v2>.PDF")).toBe("relat_rio_final_v2_.pdf");
    });

    test("remove diretorios do nome (sem path traversal)", () => {
      expect(attachments.sanitizeFileName("..\\..\\windows\\evil.pdf")).toBe("evil.pdf");
      expect(attachments.sanitizeFileName("../../etc/passwd.txt")).toBe("passwd.txt");
      expect(attachments.sanitizeFileName("C:\\Users\\erik\\nota.DOCX")).toBe("nota.docx");
      expect(attachments.sanitizeFileName("pasta\\subpasta/foto.JPG")).toBe("foto.jpg");
    });

    test("protege nomes reservados do Windows e nomes vazios", () => {
      expect(attachments.sanitizeFileName("CON.txt")).toBe("_CON.txt");
      expect(attachments.sanitizeFileName("")).toBe("arquivo");
      expect(attachments.sanitizeFileName("...")).toBe("arquivo");
    });

    test("limita nomes muito longos preservando a extensao", () => {
      const longo = "a".repeat(200) + ".pdf";
      const out = attachments.sanitizeFileName(longo);
      expect(out.endsWith(".pdf")).toBe(true);
      expect(out.length).toBeLessThanOrEqual(90);
    });
  });

  describe("absolutePathOf", () => {
    test("resolve caminhos relativos validos dentro da pasta de dados", () => {
      const abs = attachments.absolutePathOf(dataDir, "anexos/alugueis/r1/doc.pdf");
      expect(abs).toBe(path.join(dataDir, "anexos", "alugueis", "r1", "doc.pdf"));
    });

    test("rejeita caminhos absolutos e com '..'", () => {
      expect(attachments.absolutePathOf(dataDir, "C:\\Windows\\system32")).toBeNull();
      expect(attachments.absolutePathOf(dataDir, "C:Windows\\system32")).toBeNull();
      expect(attachments.absolutePathOf(dataDir, "\\\\servidor\\share\\doc.pdf")).toBeNull();
      expect(attachments.absolutePathOf(dataDir, "/tmp/doc.pdf")).toBeNull();
      expect(attachments.absolutePathOf(dataDir, "anexos/../../fora.txt")).toBeNull();
      expect(attachments.absolutePathOf(dataDir, "")).toBeNull();
    });
  });

  describe("validateSource", () => {
    test("aceita extensao permitida dentro do limite de tamanho", () => {
      const src = makeSource("orcamento.pdf");
      const res = attachments.validateSource(src, "orcamento.pdf");
      expect(res.ok).toBe(true);
      expect(res.size).toBeGreaterThan(0);
    });

    test("rejeita extensao nao permitida", () => {
      const src = makeSource("virus.exe");
      const res = attachments.validateSource(src, "virus.exe");
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/nao permitido/i);
    });

    test("rejeita arquivo de origem inexistente", () => {
      const res = attachments.validateSource(path.join(srcDir, "sumiu.pdf"), "sumiu.pdf");
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/nao encontrado/i);
    });
  });

  describe("copyIntoStore", () => {
    test("copia para anexos/alugueis/<id>/ e grava caminho relativo com '/'", () => {
      const src = makeSource("contrato.pdf", "PDF!");
      const out = attachments.copyIntoStore(dataDir, "r1", src, "contrato.pdf");

      expect(out.relPath).toBe("anexos/alugueis/r1/contrato.pdf");
      expect(out.fileName).toBe("contrato.pdf");
      expect(path.isAbsolute(out.relPath)).toBe(false);
      const abs = attachments.absolutePathOf(dataDir, out.relPath);
      expect(fs.readFileSync(abs, "utf8")).toBe("PDF!");
    });

    test("nao sobrescreve arquivos de mesmo nome (sufixo numerado)", () => {
      const a = makeSource("foto.png", "primeira");
      const b = makeSource("foto2.png", "segunda");
      const out1 = attachments.copyIntoStore(dataDir, "r1", a, "foto.png");
      const out2 = attachments.copyIntoStore(dataDir, "r1", b, "foto.png");

      expect(out1.relPath).toBe("anexos/alugueis/r1/foto.png");
      expect(out2.relPath).toBe("anexos/alugueis/r1/foto (2).png");
      // O nome original e preservado para exibicao em ambos.
      expect(out2.fileName).toBe("foto.png");
      expect(fs.readFileSync(attachments.absolutePathOf(dataDir, out1.relPath), "utf8")).toBe("primeira");
      expect(fs.readFileSync(attachments.absolutePathOf(dataDir, out2.relPath), "utf8")).toBe("segunda");
    });

    test("rejeita extensao nao permitida sem criar nada", () => {
      const src = makeSource("script.exe");
      expect(() => attachments.copyIntoStore(dataDir, "r1", src, "script.exe")).toThrow(/nao permitido/i);
      expect(fs.existsSync(path.join(dataDir, "anexos", "alugueis", "r1"))).toBe(false);
    });
  });

  describe("copyAllIntoStore (tudo-ou-nada)", () => {
    test("falha em um arquivo remove os ja copiados (sem anexos parciais)", () => {
      const ok = makeSource("plano.pdf");
      const bad = path.join(srcDir, "inexistente.pdf"); // origem ausente -> falha

      expect(() =>
        attachments.copyAllIntoStore(dataDir, "r1", [
          { path: ok, name: "plano.pdf" },
          { path: bad, name: "inexistente.pdf" },
        ])
      ).toThrow(/nao encontrado/i);

      // O primeiro arquivo (copiado antes da falha) foi removido.
      expect(fs.existsSync(path.join(dataDir, "anexos", "alugueis", "r1", "plano.pdf"))).toBe(false);
    });

    test("copia todos quando validos", () => {
      const a = makeSource("a.pdf");
      const b = makeSource("b.png");
      const out = attachments.copyAllIntoStore(dataDir, "r2", [
        { path: a, name: "a.pdf" },
        { path: b, name: "b.png" },
      ]);
      expect(out).toHaveLength(2);
      expect(attachments.storedFileExists(dataDir, out[0].relPath)).toBe(true);
      expect(attachments.storedFileExists(dataDir, out[1].relPath)).toBe(true);
    });
  });

  describe("remocao e arquivos ausentes", () => {
    test("removeStoredFile apaga o arquivo e poda a pasta vazia", () => {
      const src = makeSource("nota.txt");
      const out = attachments.copyIntoStore(dataDir, "r1", src, "nota.txt");
      attachments.removeStoredFile(dataDir, out.relPath);

      expect(attachments.storedFileExists(dataDir, out.relPath)).toBe(false);
      expect(fs.existsSync(path.join(dataDir, "anexos", "alugueis", "r1"))).toBe(false);
    });

    test("removeStoredFile tolera arquivo ja ausente", () => {
      expect(() => attachments.removeStoredFile(dataDir, "anexos/alugueis/r9/nada.pdf")).not.toThrow();
    });

    test("storedFileExists detecta arquivo removido externamente", () => {
      const src = makeSource("foto.jpg");
      const out = attachments.copyIntoStore(dataDir, "r1", src, "foto.jpg");
      expect(attachments.storedFileExists(dataDir, out.relPath)).toBe(true);

      fs.unlinkSync(attachments.absolutePathOf(dataDir, out.relPath));
      expect(attachments.storedFileExists(dataDir, out.relPath)).toBe(false);
    });

    test("removeRentalDir apaga a pasta inteira do aluguel (rollback/exclusao)", () => {
      const src = makeSource("doc.pdf");
      attachments.copyIntoStore(dataDir, "r1", src, "doc.pdf");
      attachments.removeRentalDir(dataDir, "r1");
      expect(fs.existsSync(path.join(dataDir, "anexos", "alugueis", "r1"))).toBe(false);
    });
  });
});
