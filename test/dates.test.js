"use strict";

const D = require("../src/shared/dates");

describe("dates.isValidISO", () => {
  test("aceita datas reais no formato YYYY-MM-DD", () => {
    expect(D.isValidISO("2026-06-08")).toBe(true);
    expect(D.isValidISO("2024-02-29")).toBe(true); // ano bissexto
  });

  test("rejeita formato incorreto", () => {
    expect(D.isValidISO("08/06/2026")).toBe(false);
    expect(D.isValidISO("2026-6-8")).toBe(false);
    expect(D.isValidISO("")).toBe(false);
    expect(D.isValidISO(null)).toBe(false);
    expect(D.isValidISO(undefined)).toBe(false);
  });

  test("rejeita datas inexistentes", () => {
    expect(D.isValidISO("2026-02-31")).toBe(false);
    expect(D.isValidISO("2026-02-30")).toBe(false);
    expect(D.isValidISO("2026-13-01")).toBe(false);
    expect(D.isValidISO("2026-00-10")).toBe(false);
    expect(D.isValidISO("2025-02-29")).toBe(false); // 2025 nao e bissexto
  });
});

describe("dates.isValidBR", () => {
  test("aceita datas reais no formato DD/MM/YYYY", () => {
    expect(D.isValidBR("08/06/2026")).toBe(true);
    expect(D.isValidBR("29/02/2024")).toBe(true);
  });

  test("rejeita datas inexistentes", () => {
    expect(D.isValidBR("31/02/2026")).toBe(false);
    expect(D.isValidBR("30/02/2026")).toBe(false);
    expect(D.isValidBR("01/13/2026")).toBe(false);
    expect(D.isValidBR("00/10/2026")).toBe(false);
    expect(D.isValidBR("29/02/2025")).toBe(false);
  });

  test("rejeita formato incorreto", () => {
    expect(D.isValidBR("2026-06-08")).toBe(false);
    expect(D.isValidBR("8/6/2026")).toBe(false);
    expect(D.isValidBR("")).toBe(false);
  });
});

describe("dates.isoToBR / brToISO (conversao bidirecional)", () => {
  test("ISO -> BR", () => {
    expect(D.isoToBR("2026-06-08")).toBe("08/06/2026");
    expect(D.isoToBR("2026-12-31")).toBe("31/12/2026");
  });

  test("BR -> ISO", () => {
    expect(D.brToISO("08/06/2026")).toBe("2026-06-08");
    expect(D.brToISO("31/12/2026")).toBe("2026-12-31");
  });

  test("ida e volta preserva o valor", () => {
    const iso = "2026-03-15";
    expect(D.brToISO(D.isoToBR(iso))).toBe(iso);
    const br = "15/03/2026";
    expect(D.isoToBR(D.brToISO(br))).toBe(br);
  });

  test("entrada invalida resulta em string vazia", () => {
    expect(D.isoToBR("2026-02-31")).toBe("");
    expect(D.isoToBR("nao-e-data")).toBe("");
    expect(D.brToISO("31/02/2026")).toBe("");
    expect(D.brToISO("texto")).toBe("");
  });
});

describe("dates.formatBR (exibicao)", () => {
  test("formata datas validas", () => {
    expect(D.formatBR("2026-06-08")).toBe("08/06/2026");
  });

  test("usa fallback para datas invalidas/ausentes", () => {
    expect(D.formatBR("")).toBe("-");
    expect(D.formatBR(null)).toBe("-");
    expect(D.formatBR("2026-02-31")).toBe("-");
    expect(D.formatBR("", "n/d")).toBe("n/d");
  });
});
