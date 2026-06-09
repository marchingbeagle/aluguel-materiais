"use strict";

// =============================================================================
// Modulo CENTRALIZADO de estado de formulario.
//
// Gera uma "fotografia" (snapshot) canonica dos campos de um formulario e
// permite comparar dois snapshots para detectar alteracoes nao salvas. A logica
// e pura (sem DOM) para ser reutilizada por todos os formularios e testada
// isoladamente.
//
// UMD: no Node (tests) via module.exports; no navegador via window.FormState.
// =============================================================================

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.FormState = api;
  }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function () {
  // Cria um snapshot canonico a partir de pares [chave, valor].
  // - Normaliza chave/valor para string.
  // - Ordena para que a ordem dos campos nao afete a comparacao.
  // - Usa JSON para evitar colisao de delimitadores (valores com "=" ou "\n").
  function createSnapshot(entries) {
    const list = Array.from(entries || [], ([key, value]) => {
      const k = key == null ? "" : String(key);
      const v = value == null ? "" : String(value);
      return JSON.stringify([k, v]);
    });
    list.sort();
    return list.join("\n");
  }

  // Indica se o estado atual difere do inicial. Quando nao ha estado inicial
  // registrado (null/undefined), considera-se que nao ha alteracao pendente.
  function isDirty(initialSnapshot, currentSnapshot) {
    if (initialSnapshot == null) return false;
    return initialSnapshot !== currentSnapshot;
  }

  return { createSnapshot, isDirty };
});
