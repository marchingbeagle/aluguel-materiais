"use strict";

// Calculo de disponibilidade de um material considerando o PERIODO de um novo
// aluguel (data de retirada ate a data prevista de devolucao), e nao apenas a
// quantidade disponivel no momento atual.
//
// Funcoes puras e sem dependencias para facilitar o teste unitario e o reuso
// entre o processo principal (validacao) e a interface (exibicao).

const dateUtils = require("../shared/dates");

const STATUS_RENTED = "alugado";

// Validacao centralizada (rejeita datas inexistentes como 2026-02-31).
function isValidDate(str) {
  return dateUtils.isValidISO(str);
}

// Duas faixas de datas (YYYY-MM-DD) se sobrepoem quando, de forma inclusiva:
//   inicio_a <= fim_b  E  fim_a >= inicio_b
// A comparacao lexicografica de strings YYYY-MM-DD equivale a ordem cronologica.
function overlaps(startA, endA, startB, endB) {
  return startA <= endB && endA >= startB;
}

// Filtra os alugueis ATIVOS de um material que se sobrepoem ao intervalo
// informado, ignorando opcionalmente o proprio aluguel (edicao) e registros
// com datas invalidas.
function overlappingRentals(rentals, materialId, checkout, expectedReturn, excludeId) {
  return rentals.filter(
    (r) =>
      r.material_id === materialId &&
      r.status === STATUS_RENTED &&
      (excludeId == null || r.id !== excludeId) &&
      isValidDate(r.checkout_date) &&
      isValidDate(r.expected_return_date) &&
      overlaps(r.checkout_date, r.expected_return_date, checkout, expectedReturn)
  );
}

// Maior quantidade simultaneamente reservada em qualquer dia do intervalo.
//
// A ocupacao so AUMENTA no dia de retirada de um aluguel; entre retiradas ela
// permanece constante ou diminui. Logo, o pico no intervalo [checkout,
// expectedReturn] ocorre no proprio inicio do intervalo (alugueis que ja
// estavam em curso) ou no dia de retirada de algum aluguel que comeca dentro
// dele. Basta avaliar a ocupacao nesses dias candidatos.
function peakReserved(rentals, materialId, checkout, expectedReturn, excludeId) {
  const relevant = overlappingRentals(rentals, materialId, checkout, expectedReturn, excludeId);
  if (!relevant.length) return 0;

  const candidateDays = new Set([checkout]);
  for (const r of relevant) {
    if (r.checkout_date >= checkout && r.checkout_date <= expectedReturn) {
      candidateDays.add(r.checkout_date);
    }
  }

  let peak = 0;
  for (const day of candidateDays) {
    let sum = 0;
    for (const r of relevant) {
      if (r.checkout_date <= day && day <= r.expected_return_date) {
        sum += Number(r.quantity) || 0;
      }
    }
    if (sum > peak) peak = sum;
  }
  return peak;
}

// Disponibilidade do material durante TODO o intervalo:
//   total - maior ocupacao simultanea no periodo.
function availabilityForPeriod(totalQuantity, rentals, materialId, checkout, expectedReturn, excludeId) {
  const total = Number(totalQuantity) || 0;
  const peak = peakReserved(rentals, materialId, checkout, expectedReturn, excludeId);
  return total - peak;
}

module.exports = {
  STATUS_RENTED,
  isValidDate,
  overlaps,
  overlappingRentals,
  peakReserved,
  availabilityForPeriod,
};
