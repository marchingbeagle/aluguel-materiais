"use strict";

const availability = require("../src/main/availability");

// Helper para criar um aluguel ativo com o minimo de campos relevantes.
let seq = 0;
function rental(materialId, checkout, expectedReturn, quantity, extra = {}) {
  seq += 1;
  return {
    id: extra.id || `r${seq}`,
    material_id: materialId,
    quantity,
    checkout_date: checkout,
    expected_return_date: expectedReturn,
    status: extra.status || "alugado",
    ...extra,
  };
}

describe("availability.overlaps", () => {
  test("intervalos disjuntos nao se sobrepoem", () => {
    expect(availability.overlaps("2026-06-01", "2026-06-05", "2026-06-06", "2026-06-10")).toBe(false);
  });

  test("regra inclusiva: periodos adjacentes (fim == inicio) se sobrepoem", () => {
    expect(availability.overlaps("2026-06-01", "2026-06-10", "2026-06-10", "2026-06-15")).toBe(true);
  });

  test("sobreposicao parcial", () => {
    expect(availability.overlaps("2026-06-01", "2026-06-10", "2026-06-08", "2026-06-20")).toBe(true);
  });
});

describe("availability.availabilityForPeriod", () => {
  const MAT = "m1";
  const TOTAL = 10;

  test("periodo sem alugueis sobrepostos: toda a quantidade disponivel", () => {
    const rentals = [rental(MAT, "2026-01-01", "2026-01-05", 4)];
    const av = availability.availabilityForPeriod(TOTAL, rentals, MAT, "2026-06-01", "2026-06-10", null);
    expect(av).toBe(10);
  });

  test("sobreposicao total: desconta as unidades reservadas", () => {
    const rentals = [rental(MAT, "2026-06-01", "2026-06-30", 4)];
    const av = availability.availabilityForPeriod(TOTAL, rentals, MAT, "2026-06-05", "2026-06-10", null);
    expect(av).toBe(6);
  });

  test("sobreposicao parcial: desconta as unidades reservadas no trecho comum", () => {
    const rentals = [rental(MAT, "2026-06-08", "2026-06-20", 3)];
    const av = availability.availabilityForPeriod(TOTAL, rentals, MAT, "2026-06-01", "2026-06-10", null);
    expect(av).toBe(7);
  });

  test("varios alugueis simultaneos: considera a maior ocupacao em um mesmo dia", () => {
    const rentals = [
      rental(MAT, "2026-06-01", "2026-06-10", 2), // ativo 1-10
      rental(MAT, "2026-06-05", "2026-06-15", 3), // ativo 5-15  -> pico 5-10 = 5
      rental(MAT, "2026-06-12", "2026-06-20", 4), // ativo 12-20 -> 12-15 com o segundo = 7
    ];
    // No periodo inteiro 1-20 o pico simultaneo e em 12-15: 3 + 4 = 7.
    const av = availability.availabilityForPeriod(TOTAL, rentals, MAT, "2026-06-01", "2026-06-20", null);
    expect(av).toBe(3); // 10 - 7
  });

  test("pico depende do periodo consultado", () => {
    const rentals = [
      rental(MAT, "2026-06-01", "2026-06-10", 2),
      rental(MAT, "2026-06-05", "2026-06-15", 3),
      rental(MAT, "2026-06-12", "2026-06-20", 4),
    ];
    // Consultando apenas 1-6, o pico simultaneo e 2 + 3 = 5.
    const av = availability.availabilityForPeriod(TOTAL, rentals, MAT, "2026-06-01", "2026-06-06", null);
    expect(av).toBe(5); // 10 - 5
  });

  test("alugueis adjacentes: a regra inclusiva conta o dia de fronteira", () => {
    const rentals = [
      rental(MAT, "2026-06-01", "2026-06-10", 6), // termina em 10
    ];
    // Novo periodo comeca exatamente em 10 -> ha sobreposicao no dia 10.
    const av = availability.availabilityForPeriod(TOTAL, rentals, MAT, "2026-06-10", "2026-06-15", null);
    expect(av).toBe(4); // 10 - 6
  });

  test("edicao: ignora o proprio registro no calculo", () => {
    const rentals = [
      rental(MAT, "2026-06-01", "2026-06-30", 4, { id: "self" }),
      rental(MAT, "2026-06-01", "2026-06-30", 3, { id: "other" }),
    ];
    const semExcluir = availability.availabilityForPeriod(TOTAL, rentals, MAT, "2026-06-05", "2026-06-10", null);
    expect(semExcluir).toBe(3); // 10 - (4 + 3)

    const ignorandoSelf = availability.availabilityForPeriod(TOTAL, rentals, MAT, "2026-06-05", "2026-06-10", "self");
    expect(ignorandoSelf).toBe(7); // 10 - 3 (apenas "other")
  });

  test("alugueis devolvidos nao ocupam o periodo", () => {
    const rentals = [
      rental(MAT, "2026-06-01", "2026-06-30", 5, { status: "devolvido", actual_return_date: "2026-06-02" }),
    ];
    const av = availability.availabilityForPeriod(TOTAL, rentals, MAT, "2026-06-05", "2026-06-10", null);
    expect(av).toBe(10);
  });

  test("alugueis de outros materiais nao afetam o calculo", () => {
    const rentals = [rental("outro", "2026-06-01", "2026-06-30", 8)];
    const av = availability.availabilityForPeriod(TOTAL, rentals, MAT, "2026-06-05", "2026-06-10", null);
    expect(av).toBe(10);
  });

  test("datas invalidas em registros existentes sao ignoradas", () => {
    const rentals = [
      rental(MAT, "", "2026-06-30", 5),
      rental(MAT, "2026-06-01", "data-ruim", 5),
      rental(MAT, "2026-06-01", "2026-06-30", 2),
    ];
    const av = availability.availabilityForPeriod(TOTAL, rentals, MAT, "2026-06-05", "2026-06-10", null);
    expect(av).toBe(8); // 10 - 2 (apenas o registro valido conta)
  });

  test("datas inexistentes (ex.: 2026-02-31) sao ignoradas no calculo", () => {
    const rentals = [
      rental(MAT, "2026-02-31", "2026-06-30", 5), // data de retirada inexistente
      rental(MAT, "2026-06-01", "2026-06-30", 3), // valido
    ];
    const av = availability.availabilityForPeriod(TOTAL, rentals, MAT, "2026-06-05", "2026-06-10", null);
    expect(av).toBe(7); // 10 - 3
  });

  test("material sem unidades (total 0) nunca tem disponibilidade", () => {
    const rentals = [];
    const av = availability.availabilityForPeriod(0, rentals, MAT, "2026-06-05", "2026-06-10", null);
    expect(av).toBe(0);
  });

  test("material totalmente reservado fica sem disponibilidade no periodo", () => {
    const rentals = [rental(MAT, "2026-06-01", "2026-06-30", TOTAL)];
    const av = availability.availabilityForPeriod(TOTAL, rentals, MAT, "2026-06-05", "2026-06-10", null);
    expect(av).toBe(0);
  });

  test("disponibilidade pode ficar negativa quando ja ha mais reservado que o total", () => {
    const rentals = [
      rental(MAT, "2026-06-01", "2026-06-30", 7),
      rental(MAT, "2026-06-01", "2026-06-30", 6),
    ];
    const av = availability.availabilityForPeriod(TOTAL, rentals, MAT, "2026-06-05", "2026-06-10", null);
    expect(av).toBe(-3); // 10 - 13 (o chamador trata o piso em 0 na mensagem)
  });
});

describe("availability.peakReserved", () => {
  test("retorna 0 quando nao ha alugueis sobrepostos", () => {
    const rentals = [rental("m1", "2026-01-01", "2026-01-02", 5)];
    expect(availability.peakReserved(rentals, "m1", "2026-06-01", "2026-06-10", null)).toBe(0);
  });
});
