"use strict";

// =============================================================================
// Modulo de analise do Painel.
//
// Funcoes PURAS (sem DOM) que recebem o snapshot { materials, agencies, rentals,
// today } ja carregado e um contexto de filtros, e devolvem um objeto com todas
// as metricas, series, segmentos, funil, cohorts, anomalias, recomendacoes etc.
// usados pela interface.
//
// Dominio: as "agencias" sao tratadas como os "usuarios" e os "materiais" como o
// "produto". Os "eventos" sao os alugueis (data_retirada = momento do evento).
//
// Exposto como window.Analytics (carregado antes de app.js).
// =============================================================================

(function () {
  const STATUS = { RENTED: "alugado", RETURNED: "devolvido" };
  const DAY_MS = 86400000;

  // ----------------------------- Datas (puro) -------------------------------

  const pad2 = (n) => String(n).padStart(2, "0");
  const toISO = (d) =>
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  function parseISO(s) {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(s + "T00:00:00");
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  function addDaysISO(iso, n) {
    const d = parseISO(iso);
    return d ? toISO(addDays(d, n)) : iso;
  }

  // Diferenca em dias entre duas datas ISO (b - a). Null se alguma invalida.
  function diffDaysISO(a, b) {
    const da = parseISO(a);
    const db = parseISO(b);
    if (!da || !db) return null;
    return Math.round((db - da) / DAY_MS);
  }

  function monthKey(iso) {
    return iso && iso.length >= 7 ? iso.slice(0, 7) : "";
  }

  function monthLabel(key) {
    if (!key || key.length < 7) return "Sem data";
    const [y, m] = key.split("-");
    const meses = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
    return `${meses[Number(m) - 1] || "?"}/${y.slice(2)}`;
  }

  function median(nums) {
    if (!nums.length) return 0;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function quantile(sortedAsc, q) {
    if (!sortedAsc.length) return 0;
    const pos = (sortedAsc.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sortedAsc[base + 1] !== undefined) {
      return sortedAsc[base] + rest * (sortedAsc[base + 1] - sortedAsc[base]);
    }
    return sortedAsc[base];
  }

  // ----------------------------- Periodo ------------------------------------

  // Resolve o periodo de analise a partir do preset (ou de from/to custom).
  // Devolve { from, to } em ISO (inclusivos) e os limites do periodo anterior
  // de mesmo tamanho (prevFrom/prevTo) quando aplicavel.
  function resolvePeriod(filters, rentals, today) {
    const todayD = parseISO(today) || new Date();
    const toDefault = toISO(todayD);
    let from = filters.from || "";
    let to = filters.to || "";
    const preset = filters.preset || "custom";

    if (preset !== "custom") {
      to = toDefault;
      if (preset === "month") {
        from = `${todayD.getFullYear()}-${pad2(todayD.getMonth() + 1)}-01`;
      } else if (preset === "last30") {
        from = toISO(addDays(todayD, -29));
      } else if (preset === "last90") {
        from = toISO(addDays(todayD, -89));
      } else if (preset === "year") {
        from = `${todayD.getFullYear()}-01-01`;
      } else if (preset === "all") {
        const dates = rentals
          .map((r) => r.checkout_date)
          .filter((d) => parseISO(d))
          .sort();
        from = dates[0] || toISO(addDays(todayD, -365));
      }
    }

    if (!parseISO(from)) from = toISO(addDays(todayD, -29));
    if (!parseISO(to)) to = toDefault;
    if (from > to) [from, to] = [to, from];

    let prevFrom = null;
    let prevTo = null;
    if (preset !== "all") {
      const span = diffDaysISO(from, to);
      if (span !== null) {
        prevTo = addDaysISO(from, -1);
        prevFrom = addDaysISO(prevTo, -span);
      }
    }

    return { from, to, prevFrom, prevTo, preset };
  }

  function inRange(iso, from, to) {
    return iso && iso >= from && iso <= to;
  }

  // ----------------------------- Filtragem ----------------------------------

  // Aplica filtros de agencia/material/situacao a uma lista de alugueis.
  // O filtro de periodo NAO e aplicado aqui (cada metrica decide a janela).
  function applyEntityFilters(rentals, filters) {
    return rentals.filter((r) => {
      if (filters.agencyId && r.agency_id !== filters.agencyId) return false;
      if (filters.materialId && r.material_id !== filters.materialId) return false;
      if (filters.status) {
        if (filters.status === "overdue") {
          if (!r.overdue) return false;
        } else if (r.status !== filters.status) {
          return false;
        }
      }
      return true;
    });
  }

  // ----------------------------- Delta --------------------------------------

  function delta(value, prev) {
    if (prev === null || prev === undefined) {
      return { value, prev: null, abs: null, pct: null, dir: "flat" };
    }
    const abs = value - prev;
    const pct = prev === 0 ? (value === 0 ? 0 : null) : (abs / prev) * 100;
    const dir = abs > 0.0001 ? "up" : abs < -0.0001 ? "down" : "flat";
    return { value, prev, abs, pct, dir };
  }

  // ----------------------------- Buckets de tempo ---------------------------

  // Define a granularidade do eixo de tempo conforme o tamanho do periodo.
  function chooseGranularity(from, to) {
    const span = diffDaysISO(from, to) || 0;
    if (span <= 31) return "day";
    if (span <= 168) return "week";
    return "month";
  }

  // Gera buckets [{ key, label, from, to }] cobrindo [from, to].
  function buildBuckets(from, to, gran) {
    const buckets = [];
    let cursor = parseISO(from);
    const end = parseISO(to);
    if (!cursor || !end) return buckets;

    if (gran === "day") {
      while (cursor <= end) {
        const iso = toISO(cursor);
        buckets.push({ key: iso, label: iso.slice(8) + "/" + iso.slice(5, 7), from: iso, to: iso });
        cursor = addDays(cursor, 1);
      }
    } else if (gran === "week") {
      while (cursor <= end) {
        const startIso = toISO(cursor);
        const endD = addDays(cursor, 6);
        const endIso = toISO(endD > end ? end : endD);
        buckets.push({
          key: startIso,
          label: startIso.slice(8) + "/" + startIso.slice(5, 7),
          from: startIso,
          to: endIso,
        });
        cursor = addDays(cursor, 7);
      }
    } else {
      cursor = new Date(end.getFullYear(), 0, 1) > cursor ? cursor : cursor;
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
      while (cursor <= end) {
        const k = `${cursor.getFullYear()}-${pad2(cursor.getMonth() + 1)}`;
        const lastDay = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
        buckets.push({
          key: k,
          label: monthLabel(k),
          from: `${k}-01`,
          to: toISO(lastDay > end ? end : lastDay),
        });
        cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      }
    }
    return buckets;
  }

  function bucketIndexFor(iso, buckets) {
    for (let i = 0; i < buckets.length; i++) {
      if (iso >= buckets[i].from && iso <= buckets[i].to) return i;
    }
    return -1;
  }

  // ----------------------------- Helpers de aluguel -------------------------

  // Janela "para fora" de um aluguel: [checkout, retorno efetivo]. Para itens
  // ainda alugados, usa hoje como fim corrente.
  function rentalOutInterval(r, today) {
    const start = r.checkout_date;
    let end = r.actual_return_date && parseISO(r.actual_return_date)
      ? r.actual_return_date
      : today;
    if (!parseISO(start)) return null;
    if (!parseISO(end) || end < start) end = start;
    return { start, end };
  }

  // Sobreposicao (em dias) de um intervalo com [from, to].
  function overlapDays(start, end, from, to) {
    const s = start > from ? start : from;
    const e = end < to ? end : to;
    const d = diffDaysISO(s, e);
    return d === null ? 0 : Math.max(0, d + 1);
  }

  // =========================================================================
  // Calculo principal
  // =========================================================================

  function compute(data, filters) {
    const today = data.today || toISO(new Date());
    const materials = data.materials || [];
    const agencies = data.agencies || [];
    const allRentals = data.rentals || [];

    const period = resolvePeriod(filters, allRentals, today);

    const materialById = new Map(materials.map((m) => [m.id, m]));
    const agencyById = new Map(agencies.map((a) => [a.id, a]));

    const matching = applyEntityFilters(allRentals, filters);

    // ----- Perfis + segmentos (usados apenas pelos insights) -----
    const profilesAll = computeAgencyProfiles(matching, agencies, agencyById, today);
    const segments = computeSegments(profilesAll);
    const profiles = segments.agencies;

    // ----- Conjuntos por janela -----
    const inPeriod = matching.filter((r) => inRange(r.checkout_date, period.from, period.to));
    const inPrev =
      period.prevFrom && period.prevTo
        ? matching.filter((r) => inRange(r.checkout_date, period.prevFrom, period.prevTo))
        : null;

    // ----- KPIs -----
    const kpis = computeKpis(matching, inPeriod, inPrev, period, today);

    // ----- Series de tendencia -----
    const trends = computeTrends(matching, period, today);

    // sparklines: usa as series por bucket (preenche o KPI)
    kpis.sparks = {
      rentals: trends.rentals,
      unitsOut: trends.unitsOut,
      activeAgencies: trends.activeAgencies,
      overdue: trends.overdueRate,
    };

    // ----- Engajamento da base de agencias (base fixa) -----
    const engagement = computeEngagement(profiles, inPeriod);

    // ----- Sazonalidade (mes x dia da semana) -----
    const seasonality = computeSeasonality(matching);

    // ----- Top agencias no periodo -----
    const topAgencies = computeTopAgencies(inPeriod, agencyById);

    // ----- Desempenho de materiais -----
    const materialsPerf = computeMaterials(matching, inPeriod, materials, materialById, period, today);

    // ----- Operacional (churn, ativos, proximas devolucoes) -----
    const churnRisk = profiles
      .filter((p) => p.activated && p.atRisk)
      .sort((a, b) => b.riskScore - a.riskScore);

    const activeRentals = matching
      .filter((r) => r.status === STATUS.RENTED)
      .sort((a, b) => (a.expected_return_date || "").localeCompare(b.expected_return_date || ""));

    const upcomingReturns = activeRentals
      .filter((r) => {
        const d = diffDaysISO(today, r.expected_return_date);
        return d !== null && d >= 0 && d <= 7;
      })
      .slice(0, 12);

    // ----- Anomalias -----
    const anomalies = computeAnomalies(matching, period, today);

    // ----- Recomendacoes + narrativa -----
    const insights = buildInsights({
      kpis,
      churnRisk,
      materialsPerf,
      segments,
      anomalies,
      period,
    });
    const narrative = buildNarrative(kpis, period);

    return {
      period,
      filters,
      counts: {
        agencies: agencies.length,
        materials: materials.length,
        rentalsTotal: allRentals.length,
        rentalsMatching: matching.length,
        rentalsInPeriod: inPeriod.length,
      },
      kpis,
      trends,
      engagement,
      seasonality,
      segments,
      topAgencies,
      materials: materialsPerf,
      ops: { activeRentals, churnRisk, upcomingReturns },
      anomalies,
      insights,
      narrative,
    };
  }

  // ----------------------------- KPIs ---------------------------------------

  function periodMetrics(rentals, today) {
    const agencies = new Set();
    let units = 0;
    for (const r of rentals) {
      agencies.add(r.agency_id);
      units += Number(r.quantity) || 0;
    }
    return { rentals: rentals.length, units, activeAgencies: agencies.size };
  }

  // Taxa de atraso considerando alugueis cuja devolucao PREVISTA cai na janela.
  function lateRate(rentals, from, to, today) {
    const due = rentals.filter((r) => inRange(r.expected_return_date, from, to));
    if (!due.length) return { rate: 0, due: 0, late: 0 };
    let late = 0;
    for (const r of due) {
      const lateReturn =
        r.actual_return_date && r.actual_return_date > r.expected_return_date;
      const stillOut =
        r.status === STATUS.RENTED && r.expected_return_date < today;
      if (lateReturn || stillOut) late++;
    }
    return { rate: (late / due.length) * 100, due: due.length, late };
  }

  // Duracao media (dias) dos alugueis devolvidos dentro da janela.
  function avgDuration(rentals, from, to) {
    const returned = rentals.filter(
      (r) => r.status === STATUS.RETURNED && inRange(r.actual_return_date, from, to)
    );
    const durations = returned
      .map((r) => diffDaysISO(r.checkout_date, r.actual_return_date))
      .filter((d) => d !== null && d >= 0);
    return durations.length ? median(durations) : 0;
  }

  function computeKpis(matching, inPeriod, inPrev, period, today) {
    const cur = periodMetrics(inPeriod, today);
    const prev = inPrev ? periodMetrics(inPrev, today) : null;

    const curLate = lateRate(matching, period.from, period.to, today);
    const prevLate =
      period.prevFrom && period.prevTo
        ? lateRate(matching, period.prevFrom, period.prevTo, today)
        : null;

    const curDur = avgDuration(matching, period.from, period.to);
    const prevDur =
      period.prevFrom && period.prevTo
        ? avgDuration(matching, period.prevFrom, period.prevTo)
        : null;

    return {
      rentals: delta(cur.rentals, prev ? prev.rentals : null),
      unitsOut: delta(cur.units, prev ? prev.units : null),
      activeAgencies: delta(cur.activeAgencies, prev ? prev.activeAgencies : null),
      overdueRate: delta(round1(curLate.rate), prevLate ? round1(prevLate.rate) : null),
      avgDuration: delta(round1(curDur), prevDur !== null ? round1(prevDur) : null),
      lateDetail: curLate,
    };
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  // ----------------------------- Tendencias ---------------------------------

  function computeTrends(matching, period, today) {
    const gran = chooseGranularity(period.from, period.to);
    const buckets = buildBuckets(period.from, period.to, gran);
    const n = buckets.length;

    const rentals = new Array(n).fill(0);
    const unitsOut = new Array(n).fill(0);
    const agencySets = Array.from({ length: n }, () => new Set());

    for (const r of matching) {
      if (!inRange(r.checkout_date, period.from, period.to)) continue;
      const idx = bucketIndexFor(r.checkout_date, buckets);
      if (idx < 0) continue;
      rentals[idx] += 1;
      unitsOut[idx] += Number(r.quantity) || 0;
      agencySets[idx].add(r.agency_id);
    }
    const activeAgencies = agencySets.map((s) => s.size);

    // Periodo anterior (mesma quantidade de buckets) para overlay.
    let prevRentals = null;
    if (period.prevFrom && period.prevTo) {
      const prevBuckets = buildBuckets(period.prevFrom, period.prevTo, gran);
      const pn = prevBuckets.length;
      prevRentals = new Array(Math.max(pn, n)).fill(0);
      for (const r of matching) {
        if (!inRange(r.checkout_date, period.prevFrom, period.prevTo)) continue;
        const idx = bucketIndexFor(r.checkout_date, prevBuckets);
        if (idx >= 0) prevRentals[idx] += 1;
      }
      prevRentals = prevRentals.slice(0, n);
    }

    // Taxa de atraso por bucket (devolucao prevista no bucket).
    const overdueRate = buckets.map((b) => round1(lateRate(matching, b.from, b.to, today).rate));

    return {
      gran,
      labels: buckets.map((b) => b.label),
      rentals,
      prevRentals,
      unitsOut,
      activeAgencies,
      overdueRate,
    };
  }

  // ----------------------------- Perfis de agencia --------------------------

  function computeAgencyProfiles(matching, agencies, agencyById, today) {
    const byAgency = new Map();
    for (const r of matching) {
      if (!byAgency.has(r.agency_id)) byAgency.set(r.agency_id, []);
      byAgency.get(r.agency_id).push(r);
    }

    const profiles = [];
    for (const a of agencies) {
      const rs = (byAgency.get(a.id) || []).filter((r) => parseISO(r.checkout_date));
      rs.sort((x, y) => x.checkout_date.localeCompare(y.checkout_date));
      const dates = rs.map((r) => r.checkout_date);
      const frequency = rs.length;
      const quantity = rs.reduce((s, r) => s + (Number(r.quantity) || 0), 0);
      const firstRental = dates[0] || "";
      const lastRental = dates[dates.length - 1] || "";
      const recencyDays = lastRental ? diffDaysISO(lastRental, today) : null;

      // Intervalo tipico entre alugueis (mediana dos gaps).
      const gaps = [];
      for (let i = 1; i < dates.length; i++) {
        const g = diffDaysISO(dates[i - 1], dates[i]);
        if (g !== null && g >= 0) gaps.push(g);
      }
      const medianInterval = gaps.length ? median(gaps) : null;

      // Score de risco: ha quanto tempo sem alugar vs cadencia tipica.
      const expectedInterval = medianInterval || 45;
      let riskScore = 0;
      if (recencyDays !== null) riskScore = recencyDays / expectedInterval;
      const activated = frequency >= 1;
      const atRisk =
        activated && recencyDays !== null && recencyDays > 21 && riskScore >= 1.5;

      profiles.push({
        id: a.id,
        code: a.code || "",
        name: a.name || "(sem nome)",
        frequency,
        quantity,
        firstRental,
        lastRental,
        recencyDays,
        medianInterval,
        expectedInterval,
        riskScore: Math.round(riskScore * 100) / 100,
        activated,
        atRisk,
      });
    }
    return profiles;
  }

  // ----------------------------- Segmentos RFM ------------------------------

  function computeSegments(profiles) {
    const activated = profiles.filter((p) => p.activated);
    const freqs = activated.map((p) => p.frequency).sort((a, b) => a - b);
    const p66 = quantile(freqs, 0.66);
    const med = quantile(freqs, 0.5);

    const tierDefs = [
      { name: "Campea", color: "#16a34a" },
      { name: "Leal", color: "#41a812" },
      { name: "Ocasional", color: "#f59e0b" },
      { name: "Em risco", color: "#f97316" },
      { name: "Dormente", color: "#9ca3af" },
      { name: "Nunca alugou", color: "#cbd5e1" },
    ];

    function classify(p) {
      if (!p.activated) return "Nunca alugou";
      const rec = p.recencyDays === null ? 9999 : p.recencyDays;
      if (rec > 90) return "Dormente";
      if (rec > 45 && p.frequency >= med) return "Em risco";
      if (rec <= 45 && p.frequency >= p66) return "Campea";
      if (rec <= 45 && p.frequency >= med) return "Leal";
      return "Ocasional";
    }

    const counts = new Map(tierDefs.map((t) => [t.name, 0]));
    const enriched = profiles.map((p) => {
      const tier = classify(p);
      counts.set(tier, (counts.get(tier) || 0) + 1);
      return { ...p, tier };
    });

    const tiers = tierDefs
      .map((t) => ({ ...t, count: counts.get(t.name) || 0 }))
      .filter((t) => t.count > 0);

    return { tiers, tierDefs, agencies: enriched, thresholds: { p66, med } };
  }

  // ----------------------------- Engajamento --------------------------------

  // Distribui a base fixa de agencias em faixas mutuamente exclusivas (somam o
  // total cadastrado): ativas no periodo, ativas recentemente (fora do periodo,
  // <= 90 dias), dormentes (> 90 dias) e que nunca alugaram.
  function computeEngagement(profiles, inPeriod) {
    const activeSet = new Set(inPeriod.map((r) => r.agency_id));
    let ativas = 0;
    let recentes = 0;
    let dormentes = 0;
    let nunca = 0;
    for (const p of profiles) {
      if (!p.activated) {
        nunca++;
      } else if (activeSet.has(p.id)) {
        ativas++;
      } else if (p.recencyDays !== null && p.recencyDays > 90) {
        dormentes++;
      } else {
        recentes++;
      }
    }
    const total = profiles.length || 1;
    const items = [
      { key: "ativas", label: "Ativas no periodo", value: ativas, color: "#16a34a" },
      { key: "recentes", label: "Ativas recentemente", value: recentes, color: "#41a812" },
      { key: "dormentes", label: "Dormentes (>90d)", value: dormentes, color: "#f59e0b" },
      { key: "nunca", label: "Nunca alugaram", value: nunca, color: "#cbd5e1" },
    ].map((it) => ({ ...it, pct: Math.round((it.value / total) * 100) }));
    return { total: profiles.length, items };
  }

  // ----------------------------- Sazonalidade -------------------------------

  // Contagem de reservas (data de retirada) por dia da semana x mes do ano,
  // agregando todos os anos. Util para planejar picos sazonais de eventos.
  function computeSeasonality(matching) {
    const weekdays = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sab", "Dom"];
    const months = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
    const grid = Array.from({ length: 7 }, () => new Array(12).fill(0));
    let max = 0;
    let total = 0;
    for (const r of matching) {
      const d = parseISO(r.checkout_date);
      if (!d) continue;
      const wd = (d.getDay() + 6) % 7; // segunda = 0
      const mo = d.getMonth();
      grid[wd][mo] += 1;
      total += 1;
      if (grid[wd][mo] > max) max = grid[wd][mo];
    }
    return { weekdays, months, grid, max, total };
  }

  // ----------------------------- Top agencias -------------------------------

  function computeTopAgencies(inPeriod, agencyById, limit = 8) {
    const groups = new Map();
    for (const r of inPeriod) {
      const key = r.agency_id || `__sem__${r.agency_name}`;
      let g = groups.get(key);
      if (!g) {
        const a = agencyById.get(r.agency_id);
        g = {
          code: (a?.code || r.agency_code || "").trim(),
          name: a?.name || r.agency_name || "(agencia removida)",
          bookings: 0,
          quantity: 0,
        };
        groups.set(key, g);
      }
      g.bookings += 1;
      g.quantity += Number(r.quantity) || 0;
    }
    return Array.from(groups.values())
      .sort(
        (a, b) =>
          b.bookings - a.bookings ||
          b.quantity - a.quantity ||
          a.name.localeCompare(b.name, "pt-BR")
      )
      .slice(0, limit);
  }

  // ----------------------------- Materiais ----------------------------------

  function computeMaterials(matching, inPeriod, materials, materialById, period, today) {
    const periodDays = (diffDaysISO(period.from, period.to) || 0) + 1;

    const demand = new Map(); // material_id -> { bookings, units }
    for (const r of inPeriod) {
      let d = demand.get(r.material_id);
      if (!d) {
        d = { bookings: 0, units: 0 };
        demand.set(r.material_id, d);
      }
      d.bookings += 1;
      d.units += Number(r.quantity) || 0;
    }

    // Unit-days para fora no periodo (para utilizacao).
    const unitDays = new Map();
    for (const r of matching) {
      const interval = rentalOutInterval(r, today);
      if (!interval) continue;
      if (interval.end < period.from || interval.start > period.to) continue;
      const days = overlapDays(interval.start, interval.end, period.from, period.to);
      const qty = Number(r.quantity) || 0;
      unitDays.set(r.material_id, (unitDays.get(r.material_id) || 0) + days * qty);
    }

    const list = materials.map((m) => {
      const total = Number(m.total_quantity) || 0;
      const d = demand.get(m.id) || { bookings: 0, units: 0 };
      const capacityUnitDays = total * periodDays;
      const utilizationPct = capacityUnitDays
        ? Math.min(100, Math.round((100 * (unitDays.get(m.id) || 0)) / capacityUnitDays))
        : 0;
      return {
        id: m.id,
        name: m.name,
        color: m.color || "",
        total,
        bookings: d.bookings,
        units: d.units,
        utilizationPct,
      };
    });

    const ranking = [...list].sort((a, b) => b.units - a.units || b.bookings - a.bookings);
    const idle = list
      .filter((m) => m.total > 0 && m.bookings === 0)
      .sort((a, b) => b.total - a.total);
    const stockoutRisk = list
      .filter((m) => m.total > 0 && m.utilizationPct >= 80)
      .sort((a, b) => b.utilizationPct - a.utilizationPct);

    return { ranking, idle, stockoutRisk, list, periodDays };
  }

  // ----------------------------- Anomalias ----------------------------------

  function computeAnomalies(matching, period, today) {
    const out = [];

    // Serie semanal das ultimas ~26 semanas (independe do filtro de periodo,
    // mas respeita agencia/material/situacao).
    const weeks = 26;
    const start = addDaysISO(today, -7 * weeks + 1);
    const buckets = buildBuckets(start, today, "week");
    const counts = new Array(buckets.length).fill(0);
    for (const r of matching) {
      if (!inRange(r.checkout_date, start, today)) continue;
      const idx = bucketIndexFor(r.checkout_date, buckets);
      if (idx >= 0) counts[idx] += 1;
    }
    if (counts.length >= 4) {
      const hist = counts.slice(0, -1);
      const last = counts[counts.length - 1];
      const mean = hist.reduce((s, v) => s + v, 0) / hist.length;
      const variance = hist.reduce((s, v) => s + (v - mean) ** 2, 0) / hist.length;
      const std = Math.sqrt(variance);
      if (std > 0 && Math.abs(last - mean) > 2 * std) {
        out.push({
          type: last > mean ? "spike" : "drop",
          severity: last > mean ? "info" : "warn",
          title: last > mean ? "Pico de alugueis" : "Queda de alugueis",
          text: `A semana atual registrou ${last} aluguel(eis), ${
            last > mean ? "acima" : "abaixo"
          } do esperado (~${Math.round(mean)} +/- ${Math.round(std)}).`,
        });
      }
    }

    // Surto de atrasos: periodo atual vs anterior.
    if (period.prevFrom && period.prevTo) {
      const cur = lateRate(matching, period.from, period.to, today).rate;
      const prev = lateRate(matching, period.prevFrom, period.prevTo, today).rate;
      if (cur - prev >= 15 && cur >= 20) {
        out.push({
          type: "overdue",
          severity: "warn",
          title: "Surto de atrasos",
          text: `Taxa de atraso subiu para ${round1(cur)}% (era ${round1(prev)}% no periodo anterior).`,
        });
      }
    }

    return out;
  }

  // ----------------------------- Recomendacoes ------------------------------

  function buildInsights(ctx) {
    const out = [];
    const { kpis, churnRisk, materialsPerf, segments, anomalies } = ctx;

    if (churnRisk.length) {
      const names = churnRisk.slice(0, 3).map((c) => c.name).join(", ");
      out.push({
        type: "warn",
        title: `${churnRisk.length} agencia(s) em risco de churn`,
        text: `Sem alugar ha mais tempo que o habitual (ex.: ${names}). Considere um contato de reativacao.`,
      });
    }

    const idle = materialsPerf.idle || [];
    if (idle.length) {
      const names = idle.slice(0, 3).map((m) => m.name).join(", ");
      out.push({
        type: "info",
        title: `${idle.length} material(is) sem uso no periodo`,
        text: `Capital parado em estoque (ex.: ${names}). Avalie realocar ou divulgar.`,
        action: "Ver materiais",
        target: "materials",
      });
    }

    const risk = materialsPerf.stockoutRisk || [];
    if (risk.length) {
      const top = risk[0];
      out.push({
        type: "warn",
        title: `${risk.length} material(is) perto da capacidade`,
        text: `${top.name} esta com ${top.utilizationPct}% de utilizacao. Risco de falta em picos de demanda.`,
        action: "Ver materiais",
        target: "materials",
      });
    }

    if (kpis.overdueRate.value >= 25) {
      out.push({
        type: "warn",
        title: `Taxa de atraso em ${kpis.overdueRate.value}%`,
        text: "Muitas devolucoes fora do prazo. Reforce lembretes de devolucao.",
        action: "Ver atrasados",
        target: "overdue",
      });
    }

    const dormant = (segments.tiers || []).find((t) => t.name === "Dormente");
    if (dormant && dormant.count >= 3) {
      out.push({
        type: "info",
        title: `${dormant.count} agencia(s) dormentes`,
        text: "Sem atividade ha mais de 90 dias. Uma campanha de reengajamento pode trazer parte de volta.",
      });
    }

    for (const a of anomalies) {
      out.push({ type: a.severity, title: a.title, text: a.text });
    }

    if (!out.length) {
      out.push({
        type: "ok",
        title: "Tudo sob controle",
        text: "Nenhum alerta relevante no periodo selecionado.",
      });
    }
    return out;
  }

  function buildNarrative(kpis, period) {
    const parts = [];
    const r = kpis.rentals;
    if (r.pct !== null && r.prev !== null) {
      const dir = r.dir === "up" ? "aumentaram" : r.dir === "down" ? "cairam" : "ficaram estaveis";
      parts.push(`Os alugueis ${dir} ${fmtPct(r.pct)} vs o periodo anterior`);
    } else {
      parts.push(`${r.value} aluguel(eis) no periodo`);
    }
    const ag = kpis.activeAgencies;
    if (ag.value) parts.push(`${ag.value} agencia(s) ativa(s)`);
    if (kpis.overdueRate.value) parts.push(`taxa de atraso de ${kpis.overdueRate.value}%`);
    return parts.join("; ") + ".";
  }

  function fmtPct(p) {
    const s = Math.abs(Math.round(p));
    return `${p >= 0 ? "+" : "-"}${s}%`;
  }

  // ----------------------------- Export -------------------------------------

  window.Analytics = {
    compute,
    resolvePeriod,
    helpers: { parseISO, toISO, diffDaysISO, addDaysISO, monthLabel, median },
  };
})();
