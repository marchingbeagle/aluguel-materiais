"use strict";

// Busca textual tolerante para uso no renderer e em testes.
// UMD: no Node exporta via module.exports; no navegador expõe window.SearchUtils.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.SearchUtils = api;
  }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function () {
  function normalizeText(value) {
    return String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("pt-BR")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function digitsOnly(value) {
    return String(value ?? "").replace(/\D/g, "");
  }

  function wordsOf(value) {
    const normalized = normalizeText(value);
    return normalized ? normalized.split(" ") : [];
  }

  function maxDistanceFor(term) {
    if (term.length <= 3) return 0;
    if (term.length <= 6) return 1;
    if (term.length <= 10) return 2;
    return 3;
  }

  function levenshteinWithin(a, b, limit) {
    if (a === b) return true;
    if (limit <= 0 || Math.abs(a.length - b.length) > limit) return false;

    let prev = new Array(b.length + 1);
    let curr = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;

    for (let i = 1; i <= a.length; i++) {
      curr[0] = i;
      let rowMin = curr[0];
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(
          prev[j] + 1,
          curr[j - 1] + 1,
          prev[j - 1] + cost
        );
        if (curr[j] < rowMin) rowMin = curr[j];
      }
      if (rowMin > limit) return false;
      [prev, curr] = [curr, prev];
    }
    return prev[b.length] <= limit;
  }

  function tokenMatches(term, candidate) {
    if (!term || !candidate) return false;
    if (candidate.includes(term)) return true;
    if (term.length >= 4 && term.includes(candidate)) return true;
    return levenshteinWithin(term, candidate, maxDistanceFor(term));
  }

  function fuzzyTextMatches(term, values) {
    const query = normalizeText(term);
    if (!query) return { match: true, score: 0 };

    const haystack = normalizeText(values.join(" "));
    if (!haystack) return { match: false, score: 0 };
    if (haystack.includes(query)) return { match: true, score: 500 };

    const queryWords = query.split(" ").filter(Boolean);
    const candidateWords = wordsOf(values.join(" "));
    if (!queryWords.length || !candidateWords.length) return { match: false, score: 0 };

    let score = 0;
    for (const q of queryWords) {
      const matched = candidateWords.some((word) => tokenMatches(q, word));
      if (!matched) return { match: false, score: 0 };
      score += 100 + Math.min(q.length, 12);
    }
    return { match: true, score };
  }

  function exactOrPartialScore(needle, haystack) {
    if (!needle || !haystack) return null;
    if (haystack === needle) return 1000;
    if (haystack.includes(needle)) return 900;
    return null;
  }

  function processNumberScore(query, processNumber) {
    const textScore = exactOrPartialScore(normalizeText(query), normalizeText(processNumber));
    const digitScore = exactOrPartialScore(digitsOnly(query), digitsOnly(processNumber));
    if (textScore === 1000 || digitScore === 1000) return 1000;
    if (textScore === 900 || digitScore === 900) return 900;
    return null;
  }

  function rentalTextValues(rental) {
    const materialNames = (rental?.items || []).map((it) => it.material_name);
    return [
      rental?.event_name,
      rental?.agency_name,
      rental?.agency_code,
      ...materialNames,
    ];
  }

  function rentalSearchScore(rental, term) {
    const query = String(term ?? "").trim();
    if (!query) return 0;

    const processScore = processNumberScore(query, String(rental?.process_number || ""));
    if (processScore !== null) return processScore;

    const textResult = fuzzyTextMatches(query, rentalTextValues(rental));
    return textResult.match ? textResult.score : -1;
  }

  return {
    normalizeText,
    digitsOnly,
    levenshteinWithin,
    fuzzyTextMatches,
    rentalSearchScore,
  };
});
