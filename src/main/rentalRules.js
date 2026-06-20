"use strict";

// Regras de negocio (puras) do aluguel com multiplos materiais.
//
// Validacao do payload (cabecalho + itens) e verificacao de disponibilidade de
// todos os itens no periodo. Sem I/O, para serem testadas isoladamente e
// reutilizadas pelos handlers IPC, sempre com dados frescos lidos sob o lock.

const dateUtils = require("../shared/dates");
const availability = require("./availability");

function parseIntStrict(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

// Valida e normaliza o payload completo de um aluguel.
// Retorna { errors, clean } onde clean.items = [{ id?, material_id, quantity }].
function validateRentalPayload(data) {
  const errors = [];

  const agencyId = String(data?.agency_id || "").trim();
  if (!agencyId) errors.push("Selecione uma agencia.");

  const checkout = data?.checkout_date;
  const expectedReturn = data?.expected_return_date;
  if (!dateUtils.isValidISO(checkout)) errors.push("Data de retirada invalida.");
  if (!dateUtils.isValidISO(expectedReturn)) errors.push("Data prevista de devolucao invalida.");
  if (
    dateUtils.isValidISO(checkout) &&
    dateUtils.isValidISO(expectedReturn) &&
    expectedReturn < checkout
  ) {
    errors.push("Devolucao prevista nao pode ser anterior a retirada.");
  }

  const rawItems = Array.isArray(data?.items) ? data.items : [];
  if (!rawItems.length) errors.push("Inclua pelo menos um material.");

  const items = [];
  const seen = new Set();
  rawItems.forEach((raw, idx) => {
    const label = `Item ${idx + 1}`;
    const materialId = String(raw?.material_id || "").trim();
    const quantity = parseIntStrict(raw?.quantity);
    if (!materialId) {
      errors.push(`${label}: selecione um material.`);
      return;
    }
    if (seen.has(materialId)) {
      errors.push(`${label}: material repetido. Ajuste a quantidade no item ja adicionado.`);
      return;
    }
    seen.add(materialId);
    if (quantity === null || quantity < 1) {
      errors.push(`${label}: quantidade deve ser um numero inteiro maior ou igual a 1.`);
      return;
    }
    items.push({
      id: raw?.id ? String(raw.id) : "",
      material_id: materialId,
      quantity,
    });
  });

  return {
    errors,
    clean: {
      agency_id: agencyId,
      event_name: String(data?.event_name || "").trim(),
      process_number: String(data?.process_number || "").trim(),
      checkout_date: checkout,
      expected_return_date: expectedReturn,
      notes: String(data?.notes || "").trim(),
      items,
    },
  };
}

// Verifica a disponibilidade de TODOS os itens no periodo, contra as linhas de
// ocupacao informadas (ja sem os itens do proprio aluguel, em edicao).
// Retorna a lista de problemas; lista vazia = todos os itens cabem no periodo.
function checkItemsAvailability(items, materials, occupancy, checkout, expectedReturn) {
  const materialById = new Map(materials.map((m) => [m.id, m]));
  const problems = [];
  for (const it of items) {
    const material = materialById.get(it.material_id);
    if (!material) {
      problems.push({ material_id: it.material_id, reason: "not_found", name: "(material removido)" });
      continue;
    }
    const available = availability.availabilityForPeriod(
      material.total_quantity,
      occupancy,
      it.material_id,
      checkout,
      expectedReturn,
      null
    );
    if (it.quantity > available) {
      problems.push({
        material_id: it.material_id,
        reason: "unavailable",
        name: material.name,
        requested: it.quantity,
        available: Math.max(0, available),
      });
    }
  }
  return problems;
}

// Mensagem unica e clara a partir dos problemas de disponibilidade.
function availabilityMessage(problems) {
  return problems
    .map((p) =>
      p.reason === "not_found"
        ? "Material nao encontrado (pode ter sido removido)."
        : `"${p.name}": solicitado ${p.requested}, disponivel ${p.available} no periodo.`
    )
    .join(" ");
}

module.exports = {
  validateRentalPayload,
  checkItemsAvailability,
  availabilityMessage,
};
