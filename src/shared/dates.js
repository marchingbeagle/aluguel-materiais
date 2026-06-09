"use strict";

// =============================================================================
// Modulo CENTRALIZADO de datas.
//
// Regra geral do app:
//   - Formato INTERNO / de armazenamento (CSV): "YYYY-MM-DD" (ISO).
//   - Formato VISIVEL (formularios, tabelas, filtros, calendario, mensagens):
//     "DD/MM/YYYY" (pt-BR).
//
// Toda conversao, formatacao e validacao de datas deve passar por aqui, para
// evitar logica duplicada entre o processo principal e o renderer.
//
// O arquivo e UMD: no Node (main/tests) e exposto via module.exports; no
// navegador (renderer) e exposto como window.DateUtils.
// =============================================================================

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.DateUtils = api;
  }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function () {
  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  const BR_RE = /^\d{2}\/\d{2}\/\d{4}$/;

  // Valida se ano/mes/dia formam uma data real do calendario (rejeita 31/02,
  // 30/02, meses fora de 1..12 etc.). Nao usa new Date(string) por causa do
  // "rollover" do JavaScript (ex.: 2026-02-31 viraria 03/03).
  function isRealDate(year, month, day) {
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
      return false;
    }
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    const dt = new Date(Date.UTC(year, month - 1, day));
    return (
      dt.getUTCFullYear() === year &&
      dt.getUTCMonth() === month - 1 &&
      dt.getUTCDate() === day
    );
  }

  // Valida uma string no formato interno "YYYY-MM-DD" garantindo data real.
  function isValidISO(value) {
    if (typeof value !== "string" || !ISO_RE.test(value)) return false;
    const [y, m, d] = value.split("-").map(Number);
    return isRealDate(y, m, d);
  }

  // Valida uma string no formato visivel "DD/MM/YYYY" garantindo data real.
  function isValidBR(value) {
    if (typeof value !== "string" || !BR_RE.test(value)) return false;
    const [d, m, y] = value.split("/").map(Number);
    return isRealDate(y, m, d);
  }

  // "YYYY-MM-DD" -> "DD/MM/YYYY". Retorna "" quando a entrada e invalida.
  function isoToBR(iso) {
    if (!isValidISO(iso)) return "";
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  }

  // "DD/MM/YYYY" -> "YYYY-MM-DD". Retorna "" quando a entrada e invalida.
  function brToISO(br) {
    if (!isValidBR(br)) return "";
    const [d, m, y] = br.split("/");
    return `${y}-${m}-${d}`;
  }

  // Formata uma data ISO para exibicao; usa um texto alternativo quando vazia
  // ou invalida (padrao "-"), pratico para tabelas e listas.
  function formatBR(iso, fallback = "-") {
    const out = isoToBR(iso);
    return out || fallback;
  }

  return {
    ISO_RE,
    BR_RE,
    isRealDate,
    isValidISO,
    isValidBR,
    isoToBR,
    brToISO,
    formatBR,
  };
});
