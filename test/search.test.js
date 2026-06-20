"use strict";

const search = require("../src/shared/search");

function rental(extra = {}) {
  return {
    process_number: "FLUID-12345",
    event_name: "Campeonato Regional",
    agency_name: "Agencia Centro",
    agency_code: "007",
    items: [{ material_name: "Portal inflavel" }],
    ...extra,
  };
}

describe("SearchUtils.rentalSearchScore", () => {
  test("encontra aluguel por numero do processo como identificador direto", () => {
    expect(search.rentalSearchScore(rental(), "FLUID-12345")).toBe(1000);
    expect(search.rentalSearchScore(rental(), "12345")).toBe(1000);
  });

  test("ignora diferencas de maiusculas, minusculas e acentos", () => {
    expect(search.rentalSearchScore(rental(), "CAMPEONATO REGIONAL")).toBeGreaterThan(0);
    expect(search.rentalSearchScore(rental({ agency_name: "Agência Centro" }), "agencia centro")).toBeGreaterThan(0);
  });

  test("aceita pequenos erros de digitacao no nome do evento", () => {
    expect(search.rentalSearchScore(rental(), "CAMPENOATO")).toBeGreaterThan(0);
  });

  test("retorna -1 quando nao ha correspondencia textual nem aproximada", () => {
    expect(search.rentalSearchScore(rental(), "assembleia internacional")).toBe(-1);
  });
});
