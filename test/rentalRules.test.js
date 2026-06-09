"use strict";

const rentalRules = require("../src/main/rentalRules");
const availability = require("../src/main/availability");

const MATERIALS = [
  { id: "balao", name: "Balao", total_quantity: 5 },
  { id: "portal", name: "Portal", total_quantity: 1 },
  { id: "wind", name: "Windbanner", total_quantity: 4 },
];

function basePayload(extra = {}) {
  return {
    agency_id: "ag1",
    event_name: "Feira do Agronegocio",
    checkout_date: "2026-06-10",
    expected_return_date: "2026-06-12",
    notes: "",
    items: [{ material_id: "balao", quantity: 1 }],
    ...extra,
  };
}

describe("rentalRules.validateRentalPayload", () => {
  test("aluguel valido com apenas um material", () => {
    const { errors, clean } = rentalRules.validateRentalPayload(basePayload());
    expect(errors).toEqual([]);
    expect(clean.items).toEqual([{ id: "", material_id: "balao", quantity: 1 }]);
    expect(clean.event_name).toBe("Feira do Agronegocio");
  });

  test("aluguel valido com varios materiais e quantidades diferentes", () => {
    const { errors, clean } = rentalRules.validateRentalPayload(
      basePayload({
        items: [
          { material_id: "balao", quantity: 1 },
          { material_id: "portal", quantity: 1 },
          { material_id: "wind", quantity: 3 },
        ],
      })
    );
    expect(errors).toEqual([]);
    expect(clean.items).toHaveLength(3);
    expect(clean.items[2]).toEqual({ id: "", material_id: "wind", quantity: 3 });
  });

  test("nome do evento e opcional e normalizado", () => {
    const { errors, clean } = rentalRules.validateRentalPayload(basePayload({ event_name: "  " }));
    expect(errors).toEqual([]);
    expect(clean.event_name).toBe("");
  });

  test("rejeita payload sem itens", () => {
    const { errors } = rentalRules.validateRentalPayload(basePayload({ items: [] }));
    expect(errors.join(" ")).toMatch(/pelo menos um material/i);
  });

  test("rejeita material duplicado entre itens", () => {
    const { errors } = rentalRules.validateRentalPayload(
      basePayload({
        items: [
          { material_id: "balao", quantity: 1 },
          { material_id: "balao", quantity: 2 },
        ],
      })
    );
    expect(errors.join(" ")).toMatch(/repetido/i);
  });

  test("rejeita quantidade menor que 1, zero, negativa e nao inteira", () => {
    for (const quantity of [0, -1, 0.5, "abc", null]) {
      const { errors } = rentalRules.validateRentalPayload(
        basePayload({ items: [{ material_id: "balao", quantity }] })
      );
      expect(errors.join(" ")).toMatch(/quantidade/i);
    }
  });

  test("rejeita item sem material selecionado", () => {
    const { errors } = rentalRules.validateRentalPayload(
      basePayload({ items: [{ material_id: "", quantity: 1 }] })
    );
    expect(errors.join(" ")).toMatch(/selecione um material/i);
  });

  test("rejeita datas invalidas e devolucao anterior a retirada", () => {
    expect(
      rentalRules.validateRentalPayload(basePayload({ checkout_date: "2026-02-31" })).errors.join(" ")
    ).toMatch(/retirada invalida/i);
    expect(
      rentalRules.validateRentalPayload(
        basePayload({ checkout_date: "2026-06-12", expected_return_date: "2026-06-10" })
      ).errors.join(" ")
    ).toMatch(/anterior a retirada/i);
  });

  test("rejeita agencia ausente", () => {
    const { errors } = rentalRules.validateRentalPayload(basePayload({ agency_id: "" }));
    expect(errors.join(" ")).toMatch(/agencia/i);
  });

  test("preserva o id de itens existentes (edicao)", () => {
    const { clean } = rentalRules.validateRentalPayload(
      basePayload({ items: [{ id: "it1", material_id: "balao", quantity: 2 }] })
    );
    expect(clean.items[0].id).toBe("it1");
  });
});

describe("rentalRules.checkItemsAvailability", () => {
  test("todos os itens disponiveis: nenhum problema", () => {
    const problems = rentalRules.checkItemsAvailability(
      [
        { material_id: "balao", quantity: 2 },
        { material_id: "wind", quantity: 4 },
      ],
      MATERIALS,
      [],
      "2026-06-10",
      "2026-06-12"
    );
    expect(problems).toEqual([]);
  });

  test("bloqueia a operacao inteira quando UM dos itens esta indisponivel", () => {
    // Portal (total 1) ja esta ocupado no periodo por outro aluguel.
    const occupancy = [
      {
        id: "x1",
        material_id: "portal",
        quantity: 1,
        status: "alugado",
        checkout_date: "2026-06-09",
        expected_return_date: "2026-06-11",
      },
    ];
    const problems = rentalRules.checkItemsAvailability(
      [
        { material_id: "balao", quantity: 1 },
        { material_id: "portal", quantity: 1 },
      ],
      MATERIALS,
      occupancy,
      "2026-06-10",
      "2026-06-12"
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      material_id: "portal",
      reason: "unavailable",
      requested: 1,
      available: 0,
    });
    expect(rentalRules.availabilityMessage(problems)).toMatch(/Portal.*solicitado 1.*disponivel 0/);
  });

  test("concorrencia: segunda reserva e recusada apos a primeira ocupar o estoque", () => {
    // Usuario A reservou 4 baloes (gravado em disco); usuario B rele os dados
    // sob o lock e tenta reservar 2 no mesmo periodo.
    const afterUserA = [
      {
        id: "a1",
        material_id: "balao",
        quantity: 4,
        status: "alugado",
        checkout_date: "2026-06-10",
        expected_return_date: "2026-06-12",
      },
    ];
    const problems = rentalRules.checkItemsAvailability(
      [{ material_id: "balao", quantity: 2 }],
      MATERIALS,
      afterUserA,
      "2026-06-10",
      "2026-06-12"
    );
    expect(problems).toHaveLength(1);
    expect(problems[0].available).toBe(1);
  });

  test("material removido gera problema claro", () => {
    const problems = rentalRules.checkItemsAvailability(
      [{ material_id: "nao-existe", quantity: 1 }],
      MATERIALS,
      [],
      "2026-06-10",
      "2026-06-12"
    );
    expect(problems[0].reason).toBe("not_found");
    expect(rentalRules.availabilityMessage(problems)).toMatch(/nao encontrado/i);
  });

  test("itens devolvidos nao ocupam o periodo", () => {
    const occupancy = availability.occupancyFromItems(
      [{ id: "r1", checkout_date: "2026-06-10", expected_return_date: "2026-06-12" }],
      [
        {
          id: "i1",
          rental_id: "r1",
          material_id: "portal",
          quantity: 1,
          status: "devolvido",
          actual_return_date: "2026-06-10",
        },
      ],
      null
    );
    const problems = rentalRules.checkItemsAvailability(
      [{ material_id: "portal", quantity: 1 }],
      MATERIALS,
      occupancy,
      "2026-06-10",
      "2026-06-12"
    );
    expect(problems).toEqual([]);
  });

  test("edicao: itens do proprio aluguel sao desconsiderados via occupancyFromItems", () => {
    const rentals = [
      { id: "r1", checkout_date: "2026-06-10", expected_return_date: "2026-06-12" },
      { id: "r2", checkout_date: "2026-06-10", expected_return_date: "2026-06-12" },
    ];
    const items = [
      { id: "i1", rental_id: "r1", material_id: "portal", quantity: 1, status: "alugado" },
      { id: "i2", rental_id: "r2", material_id: "balao", quantity: 2, status: "alugado" },
    ];
    // Editando r1: seus proprios itens nao contam contra a disponibilidade.
    const occupancy = availability.occupancyFromItems(rentals, items, "r1");
    const problems = rentalRules.checkItemsAvailability(
      [{ material_id: "portal", quantity: 1 }],
      MATERIALS,
      occupancy,
      "2026-06-10",
      "2026-06-12"
    );
    expect(problems).toEqual([]);
  });
});
