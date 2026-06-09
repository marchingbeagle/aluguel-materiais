"use strict";

const FormState = require("../src/shared/formState");

// Simula a leitura dos campos de um formulario como pares [chave, valor],
// equivalente ao que o renderer extrai do DOM.
function snap(fields) {
  return FormState.createSnapshot(Object.entries(fields));
}

describe("formState.createSnapshot", () => {
  test("formularios iguais geram o mesmo snapshot", () => {
    const a = snap({ name: "Joao", qty: "2", color: "#fff" });
    const b = snap({ name: "Joao", qty: "2", color: "#fff" });
    expect(a).toBe(b);
  });

  test("ordem dos campos nao afeta o snapshot", () => {
    const a = snap({ name: "Joao", qty: "2" });
    const b = FormState.createSnapshot([
      ["qty", "2"],
      ["name", "Joao"],
    ]);
    expect(a).toBe(b);
  });

  test("valores com '=' ou quebras de linha nao colidem", () => {
    const a = FormState.createSnapshot([["notes", "a=b"]]);
    const b = FormState.createSnapshot([["notes", "a"], ["b", ""]]);
    expect(a).not.toBe(b);
  });

  test("normaliza nulos/indefinidos para vazio", () => {
    const a = snap({ obs: "" });
    const b = FormState.createSnapshot([["obs", null]]);
    const c = FormState.createSnapshot([["obs", undefined]]);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });
});

describe("formState.isDirty", () => {
  test("sem baseline (null) nunca esta sujo", () => {
    expect(FormState.isDirty(null, snap({ name: "x" }))).toBe(false);
    expect(FormState.isDirty(undefined, snap({ name: "x" }))).toBe(false);
  });

  test("formulario inalterado nao esta sujo", () => {
    const inicial = snap({ name: "Joao", qty: "1", aceito: "0" });
    const atual = snap({ name: "Joao", qty: "1", aceito: "0" });
    expect(FormState.isDirty(inicial, atual)).toBe(false);
  });

  test("alterar um campo marca como sujo", () => {
    const inicial = snap({ name: "Joao", qty: "1" });
    const atual = snap({ name: "Joao", qty: "2" });
    expect(FormState.isDirty(inicial, atual)).toBe(true);
  });

  test("alterar e restaurar o valor inicial remove o estado sujo", () => {
    const inicial = snap({ name: "Joao", qty: "1" });
    const alterado = snap({ name: "Joao", qty: "5" });
    const restaurado = snap({ name: "Joao", qty: "1" });
    expect(FormState.isDirty(inicial, alterado)).toBe(true);
    expect(FormState.isDirty(inicial, restaurado)).toBe(false);
  });

  test("checkbox marcado/desmarcado conta como alteracao", () => {
    const inicial = snap({ usarPadrao: "1" });
    const desmarcado = snap({ usarPadrao: "0" });
    const remarcado = snap({ usarPadrao: "1" });
    expect(FormState.isDirty(inicial, desmarcado)).toBe(true);
    expect(FormState.isDirty(inicial, remarcado)).toBe(false);
  });

  test("escolha de material (campo oculto) conta como alteracao", () => {
    const inicial = snap({ checkout_date: "2026-06-08", material_id: "" });
    const comMaterial = snap({ checkout_date: "2026-06-08", material_id: "m1" });
    expect(FormState.isDirty(inicial, comMaterial)).toBe(true);
  });

  test("alterar datas marca como sujo", () => {
    const inicial = snap({ checkout_date: "2026-06-08", rentalCheckoutBR: "08/06/2026" });
    const atual = snap({ checkout_date: "2026-06-10", rentalCheckoutBR: "10/06/2026" });
    expect(FormState.isDirty(inicial, atual)).toBe(true);
  });
});
