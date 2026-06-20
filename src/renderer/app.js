"use strict";

// Estado em memoria com o ultimo snapshot carregado do processo principal.
let data = {
  materials: [],
  agencies: [],
  rentals: [],
  stockProducts: [],
  stockMovements: [],
  stockStats: {},
  stats: {},
  today: "",
};
let currentView = "dashboard";

const tableSort = {
  materials: { key: "name", dir: "asc" },
  agencies: { key: "code", dir: "asc" },
  rentals: { key: "checkout_date", dir: "desc" },
  stockPurchase: { key: "needed", dir: "desc" },
  stockProducts: { key: "needed", dir: "desc" },
  stockMovements: { key: "movement_date", dir: "desc" },
};

// Estado do calendario.
let calMode = "month"; // "month" | "week"
let calRef = new Date();

// Cor de destaque padrao usada quando um material nao tem cor personalizada.
const DEFAULT_MATERIAL_COLOR = "#41a812";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ----------------------------- Utilidades -----------------------------

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Exibicao de datas: converte o valor interno (YYYY-MM-DD) para DD/MM/YYYY.
// Toda a logica de datas e centralizada em window.DateUtils (src/shared/dates.js).
function fmtDate(iso) {
  return DateUtils.formatBR(iso, "-");
}

function normalizeForSort(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return value;
  const text = String(value).trim();
  const asNumber = Number(text);
  if (text !== "" && Number.isFinite(asNumber)) return asNumber;
  return text.toLocaleLowerCase("pt-BR");
}

function compareValues(a, b) {
  const av = normalizeForSort(a);
  const bv = normalizeForSort(b);
  if (typeof av === "number" && typeof bv === "number") return av - bv;
  return String(av).localeCompare(String(bv), "pt-BR", { numeric: true, sensitivity: "base" });
}

function sortRows(rows, table, valueOf) {
  const state = tableSort[table];
  if (!state) return rows;
  return rows.sort((a, b) => {
    const cmp = compareValues(valueOf(a, state.key), valueOf(b, state.key));
    return state.dir === "desc" ? -cmp : cmp;
  });
}

function setTableSort(table, key, defaultDir = "asc") {
  const current = tableSort[table] || { key: "", dir: defaultDir };
  tableSort[table] = current.key === key
    ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
    : { key, dir: defaultDir };
}

function renderSortIndicators() {
  $$("[data-sort-table][data-sort-key]").forEach((th) => {
    const state = tableSort[th.dataset.sortTable];
    const active = state && state.key === th.dataset.sortKey;
    th.classList.toggle("sort-active", !!active);
    th.dataset.sortDir = active ? state.dir : "";
    th.setAttribute("aria-sort", active ? (state.dir === "asc" ? "ascending" : "descending") : "none");
  });
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvNumber(value) {
  const n = Number(value) || 0;
  return String(n).replace(".", ",");
}

function downloadCsv(fileName, headers, rows) {
  const csv = "\uFEFF" + [
    headers.map(csvEscape).join(";"),
    ...rows.map((row) => row.map(csvEscape).join(";")),
  ].join("\n") + "\n";
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ----------------------------- Entrada de datas (DD/MM/YYYY) -----------------------------

// Aplica a mascara dd/mm/aaaa enquanto o usuario digita (apenas digitos).
function maskBRDate(el) {
  const digits = el.value.replace(/\D/g, "").slice(0, 8);
  let out = digits;
  if (digits.length > 4) out = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
  else if (digits.length > 2) out = `${digits.slice(0, 2)}/${digits.slice(2)}`;
  el.value = out;
}

// Flag para evitar loop de sincronizacao entre o texto BR e o input nativo de
// data: enquanto o usuario digita no campo BR, ignoramos o eco do input nativo.
let syncingFromBR = false;

// Sincroniza o campo visivel (BR) com o input de data nativo (ISO), que carrega
// o "name" do formulario e e lido pelos filtros. Dispara eventos no nativo para
// que os listeners existentes (que observam o campo ISO) continuem funcionando.
function syncNativeFromBR(visible, native) {
  if (!native) return;
  const iso = DateUtils.brToISO(visible.value);
  const hasText = visible.value.trim().length > 0;
  visible.classList.toggle("invalid", hasText && !iso);
  if (native.value !== iso) {
    syncingFromBR = true;
    native.value = iso;
    native.dispatchEvent(new Event("input", { bubbles: true }));
    native.dispatchEvent(new Event("change", { bubbles: true }));
    syncingFromBR = false;
  }
}

// Define (ou limpa) um par de campos de data: ajusta o input nativo (ISO) e o
// visivel (BR). Usado ao limpar filtros.
function setBRDateField(targetId, iso) {
  const native = document.getElementById(targetId);
  const visible = document.querySelector(`input.date-br[data-target="${targetId}"]`);
  if (native) native.value = iso || "";
  if (visible) {
    visible.value = DateUtils.isoToBR(iso || "");
    visible.classList.remove("invalid");
  }
}

// Liga todos os campos de data dentro de um container (filtros, formularios).
// Cada campo tem: input.date-br (texto DD/MM/YYYY) + input.date-native
// (type=date, guarda o ISO) + botao .date-pick-btn (abre o calendario).
function initDateInputs(root) {
  const scope = root || document;
  scope.querySelectorAll("input.date-br").forEach((visible) => {
    if (visible.dataset.bound === "1") return;
    visible.dataset.bound = "1";
    const native = document.getElementById(visible.dataset.target);

    // Inicializa o texto visivel a partir do valor ISO ja presente no nativo.
    if (native && native.value) visible.value = DateUtils.isoToBR(native.value);

    // Digitacao manual no campo BR -> atualiza o nativo (ISO).
    visible.addEventListener("input", () => {
      maskBRDate(visible);
      syncNativeFromBR(visible, native);
    });
    visible.addEventListener("blur", () => syncNativeFromBR(visible, native));

    // Selecao no calendario nativo -> atualiza o texto BR (sem sobrescrever o
    // que o usuario esta digitando, graças a flag syncingFromBR).
    if (native) {
      const reflect = () => {
        if (syncingFromBR) return;
        visible.value = DateUtils.isoToBR(native.value);
        visible.classList.remove("invalid");
      };
      native.addEventListener("input", reflect);
      native.addEventListener("change", reflect);
    }
  });

  // Botao do calendario: abre o seletor nativo moderno.
  scope.querySelectorAll(".date-pick-btn").forEach((btn) => {
    if (btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      const native = document.getElementById(btn.dataset.pick);
      if (!native) return;
      try {
        if (typeof native.showPicker === "function") native.showPicker();
        else native.focus();
      } catch (_err) {
        native.focus();
      }
    });
  });
}

// Nome da agencia prefixado pelo codigo (quando existir), ex.: "01 - Agencia X".
function agencyLabel(r) {
  const code = String(r.agency_code || "").trim();
  return code ? `${code} - ${r.agency_name}` : r.agency_name;
}

function toast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  $("#toasts").appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.3s";
    setTimeout(() => el.remove(), 300);
  }, type === "error" ? 5000 : 3000);
}

function setSync(state) {
  const dot = $("#syncDot");
  const label = $("#syncLabel");
  dot.className = "sync-dot" + (state === "busy" ? " busy" : state === "error" ? " error" : "");
  label.textContent = state === "busy" ? "Atualizando..." : state === "error" ? "Sem acesso" : "Sincronizado";
}

// Trata o resultado padrao { ok, code, message } dos handlers de escrita.
async function handleResult(promise, successMsg) {
  try {
    const res = await promise;
    if (res && res.ok === false) {
      toast(res.message || "Operacao nao concluida.", res.code === "CONFLICT" ? "warn" : "error");
      if (res.code === "CONFLICT" || res.code === "NOT_FOUND") await loadAll();
      return res;
    }
    if (successMsg) toast(successMsg, "success");
    await loadAll();
    return res || { ok: true };
  } catch (err) {
    toast("Erro: " + (err?.message || err), "error");
    return { ok: false };
  }
}

// ----------------------------- Modal -----------------------------

let modalSubmitHandler = null;
// Snapshot do estado inicial do formulario (para detectar alteracoes nao
// salvas). null = nenhum formulario aberto / sem baseline.
let modalInitialSnapshot = null;

// Captura o estado atual de todos os campos do formulario do modal. Considera
// textos, datas, seletores, numeros, checkboxes/radios e campos ocultos (ex.: a
// escolha de material), usando name ou id como chave.
function snapshotModal() {
  const entries = [];
  $$("#modalBody input, #modalBody select, #modalBody textarea").forEach((el, i) => {
    const key = el.name || el.id || `__field${i}`;
    const value =
      el.type === "checkbox" || el.type === "radio" ? (el.checked ? "1" : "0") : (el.value ?? "");
    entries.push([key, value]);
  });
  return FormState.createSnapshot(entries);
}

// Registra o estado atual como "limpo" (sem alteracoes pendentes).
function markModalPristine() {
  modalInitialSnapshot = snapshotModal();
}

// Ha alteracoes nao salvas em relacao ao estado inicial?
function isModalDirty() {
  return FormState.isDirty(modalInitialSnapshot, snapshotModal());
}

function openModal(title, bodyHtml, onSubmit, submitLabel = "Salvar") {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = bodyHtml;
  enhanceRequiredLabels($("#modalBody"));
  $("#modalSubmit").textContent = submitLabel;
  $("#modalError").classList.add("hidden");
  modalSubmitHandler = onSubmit;
  $("#modal").classList.remove("hidden");
  // Baseline do estado inicial logo apos renderizar os campos.
  markModalPristine();
  const first = $("#modalBody input, #modalBody select, #modalBody textarea");
  if (first) first.focus();
}

function closeModal() {
  $("#modal").classList.add("hidden");
  $("#modalCancel").hidden = false;
  $("#modalSubmit").textContent = "Salvar";
  modalSubmitHandler = null;
  modalInitialSnapshot = null;
}

// Solicitacao centralizada de fechamento: todas as formas de sair do modal
// (clicar fora, botao fechar, cancelar, Esc) passam por aqui. So pede
// confirmacao quando ha alteracoes nao salvas.
let discardDialogOpen = false;
function requestCloseModal() {
  if ($("#modal").classList.contains("hidden")) return;
  if (discardDialogOpen) return; // evita dialogos duplicados
  if (!isModalDirty()) {
    closeModal();
    return;
  }
  discardDialogOpen = true;
  confirmDialog(
    "Voce possui alteracoes nao salvas. Deseja fechar e descarta-las?",
    () => {
      discardDialogOpen = false;
      closeModal();
    },
    {
      title: "Descartar alteracoes?",
      okLabel: "Descartar e fechar",
      cancelLabel: "Continuar editando",
      focus: "cancel", // foco inicial na acao segura
      onCancel: () => {
        discardDialogOpen = false;
      },
    }
  );
}

function showModalError(msg) {
  const el = $("#modalError");
  el.textContent = msg;
  el.classList.remove("hidden");
}

function confirmDialog(
  message,
  onOk,
  { title = "Confirmar exclusao", okLabel = "Excluir", cancelLabel = "Cancelar", focus = "cancel", onCancel = null } = {}
) {
  $("#confirmTitle").textContent = title;
  $("#confirmMessage").textContent = message;
  $("#confirmOk").textContent = okLabel;
  $("#confirmCancel").textContent = cancelLabel;
  $("#confirm").classList.remove("hidden");
  const ok = $("#confirmOk");
  const cancel = $("#confirmCancel");
  const close = () => {
    $("#confirm").classList.add("hidden");
    ok.removeEventListener("click", okFn);
    cancel.removeEventListener("click", cancelFn);
  };
  const okFn = async () => {
    close();
    await onOk();
  };
  const cancelFn = async () => {
    close();
    if (onCancel) await onCancel();
  };
  ok.addEventListener("click", okFn);
  cancel.addEventListener("click", cancelFn);
  (focus === "ok" ? ok : cancel).focus();
}

function openDetailModal(title, bodyHtml) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = bodyHtml;
  $("#modalSubmit").textContent = "Fechar";
  $("#modalCancel").hidden = true;
  $("#modalError").classList.add("hidden");
  modalSubmitHandler = async () => ({ ok: true });
  $("#modal").classList.remove("hidden");
  markModalPristine();
  $("#modalSubmit").focus();
}

function enhanceRequiredLabels(root = document) {
  root.querySelectorAll("input[required], select[required], textarea[required]").forEach((field) => {
    const id = field.id;
    let label = id ? root.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    if (!label) {
      const wrapper = field.closest(".field, .date-field, .rental-item-row, .return-item");
      label = wrapper?.querySelector("label");
    }
    if (!label) return;
    label.classList.add("required-label");
    label.textContent = label.textContent.replace(/\s*\*+\s*$/, "").trim();
  });
}

function detailButton(detail, label = "Ver detalhes") {
  return `<button type="button" class="btn btn-sm btn-ghost btn-detail" data-detail="${escapeHtml(detail)}">${escapeHtml(label)}</button>`;
}

function detailTable(headers, rows, emptyText = "Nenhum dado para detalhar.") {
  if (!rows.length) return `<p class="opp-empty detail-empty">${escapeHtml(emptyText)}</p>`;
  return `<div class="table-wrap detail-table-wrap">
    <table class="detail-table">
      <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody>
    </table>
  </div>`;
}

function currentDashboardResult() {
  if (!window.Analytics) return null;
  readDashFilters();
  return window.Analytics.compute(
    {
      materials: data.materials,
      agencies: data.agencies,
      rentals: data.rentalEntries || [],
      today: data.today,
    },
    dashFilters
  );
}

// Le os campos nomeados do formulario do modal.
function formValues() {
  const out = {};
  $$("#modalBody [name]").forEach((el) => {
    out[el.name] = el.value;
  });
  return out;
}

// ----------------------------- Carregamento -----------------------------

async function loadAll() {
  try {
    setSync("busy");
    data = await window.api.loadAll();
    renderAll();
    setSync("ok");
  } catch (err) {
    setSync("error");
    toast("Falha ao carregar dados: " + (err?.message || err), "error");
  }
}

function renderAll() {
  renderDashboard();
  renderMaterials();
  renderStock();
  renderAgencies();
  renderRentals();
  renderCalendar();
  renderSortIndicators();
}

// ----------------------------- Painel (analitico) -----------------------------

// Estado dos filtros do painel.
const dashFilters = {
  preset: "last30",
  from: "",
  to: "",
  agencyId: "",
  materialId: "",
  status: "",
};

// Instancias do Chart.js (recriadas a cada render para evitar vazamentos).
const dashCharts = {};

const fmtInt = (n) => Number(n || 0).toLocaleString("pt-BR");
const fmtMoney = (n) => Number(n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function chartReady() {
  return typeof Chart !== "undefined";
}

function upsertChart(key, canvasId, config) {
  if (!chartReady()) return;
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (dashCharts[key]) {
    try {
      dashCharts[key].destroy();
    } catch (_e) {}
  }
  dashCharts[key] = new Chart(canvas.getContext("2d"), config);
}

function readDashFilters() {
  dashFilters.preset = $("#fltPreset")?.value || "last30";
  dashFilters.from = $("#fltFrom")?.value || "";
  dashFilters.to = $("#fltTo")?.value || "";
  dashFilters.agencyId = $("#fltAgency")?.value || "";
  dashFilters.materialId = $("#fltMaterial")?.value || "";
  dashFilters.status = $("#fltStatus")?.value || "";
}

// Popula os selects de agencia/material mantendo a selecao atual.
let dashSelectsSig = "";
function populateDashSelects() {
  const sig = `${data.agencies.length}:${data.materials.length}`;
  if (sig === dashSelectsSig) return;
  dashSelectsSig = sig;

  const agSel = $("#fltAgency");
  if (agSel) {
    const cur = agSel.value;
    agSel.innerHTML =
      `<option value="">Todas</option>` +
      data.agencies
        .map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.code ? a.code + " - " : "")}${escapeHtml(a.name)}</option>`)
        .join("");
    agSel.value = cur;
  }

  const matSel = $("#fltMaterial");
  if (matSel) {
    const cur = matSel.value;
    matSel.innerHTML =
      `<option value="">Todos</option>` +
      [...data.materials]
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
        .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`)
        .join("");
    matSel.value = cur;
  }
}

function renderDashboard() {
  if (!window.Analytics) return;
  populateDashSelects();
  readDashFilters();

  // Mostra/oculta o intervalo personalizado.
  const custom = $("#fltCustomRange");
  if (custom) custom.hidden = dashFilters.preset !== "custom";

  // O painel analisa as entradas planas (uma por item de aluguel); as metricas
  // de "alugueis" deduplicam pelo rental_id dentro do proprio Analytics.
  const result = window.Analytics.compute(
    {
      materials: data.materials,
      agencies: data.agencies,
      rentals: data.rentalEntries || [],
      today: data.today,
    },
    dashFilters
  );

  $("#dashNarrative").textContent = result.narrative || "";
  const lbl = $("#fltPeriodLabel");
  if (lbl) lbl.textContent = `${fmtDate(result.period.from)} - ${fmtDate(result.period.to)}`;

  renderKpis(result);
  renderInsights(result);
  renderTrendCharts(result);
  renderEngagement(result);
  renderSeasonality(result);
  renderTopAgenciesTable(result);
  renderMaterialPerf(result);
  renderActiveRentals(result);
}

// ----------------------------- KPIs -----------------------------

// Mini grafico em SVG (sem dependencia) para os cartoes de KPI.
function sparkline(values, color) {
  const vals = (values || []).filter((v) => Number.isFinite(v));
  if (vals.length < 2) return "";
  const w = 120;
  const h = 30;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const step = w / (vals.length - 1);
  const pts = vals
    .map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`)
    .join(" ");
  return `<svg class="kpi-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;
}

function deltaChip(d, { suffix = "", inverse = false } = {}) {
  if (!d || d.prev === null || d.prev === undefined) {
    return `<span class="kpi-sub">sem comparacao</span>`;
  }
  const arrow = d.dir === "up" ? "&#9650;" : d.dir === "down" ? "&#9660;" : "&#8211;";
  const cls = `kpi-delta ${d.dir}${inverse ? " inverse" : ""}`;
  let label;
  if (d.pct === null) label = `${d.abs >= 0 ? "+" : ""}${fmtInt(Math.round(d.abs))}${suffix}`;
  else label = `${d.pct >= 0 ? "+" : ""}${Math.round(d.pct)}%`;
  return `<span class="${cls}">${arrow} ${label}</span><span class="kpi-sub">vs anterior</span>`;
}

function kpiCard({ label, value, delta, suffix = "", inverse = false, spark, sub, detail }) {
  const detailAttrs = detail ? ` role="button" tabindex="0" data-detail="${escapeHtml(detail)}" title="Ver detalhes"` : "";
  return `<div class="kpi${detail ? " kpi-clickable" : ""}"${detailAttrs}>
    <span class="kpi-label">${escapeHtml(label)}</span>
    <span class="kpi-value">${value}</span>
    <div class="kpi-foot">${sub ? `<span class="kpi-sub">${escapeHtml(sub)}</span>` : deltaChip(delta, { suffix, inverse })}</div>
    ${spark || ""}
  </div>`;
}

function renderKpis(result) {
  const k = result.kpis;
  const grid = $("#kpiGrid");
  if (!grid) return;
  grid.innerHTML = [
    kpiCard({
      label: "Alugueis no periodo",
      value: fmtInt(k.rentals.value),
      delta: k.rentals,
      spark: sparkline(k.sparks.rentals, "#41a812"),
      detail: "dash-kpi-rentals",
    }),
    kpiCard({
      label: "Unidades em uso",
      value: fmtInt(k.unitsOut.value),
      delta: k.unitsOut,
      spark: sparkline(k.sparks.unitsOut, "#0ea5e9"),
      detail: "dash-kpi-units",
    }),
    kpiCard({
      label: "Agencias ativas",
      value: fmtInt(k.activeAgencies.value),
      delta: k.activeAgencies,
      spark: sparkline(k.sparks.activeAgencies, "#8b5cf6"),
      detail: "dash-kpi-agencies",
    }),
    kpiCard({
      label: "Taxa de atraso",
      value: `${k.overdueRate.value}%`,
      delta: k.overdueRate,
      inverse: true,
      spark: sparkline(k.sparks.overdue, "#f59e0b"),
      detail: "dash-kpi-overdue",
    }),
    kpiCard({
      label: "Duracao media",
      value: `${k.avgDuration.value} d`,
      delta: k.avgDuration,
      suffix: " d",
      inverse: true,
      detail: "dash-kpi-duration",
    }),
  ].join("");
}

// ----------------------------- Insights -----------------------------

function renderInsights(result) {
  const grid = $("#insightsGrid");
  if (!grid) return;
  const items = result.insights || [];
  $("#insightsCount").textContent = items.length ? `${items.length} alerta(s)` : "";
  grid.innerHTML = items
    .map(
      (it) => `<div class="insight ${escapeHtml(it.type || "info")}">
        <span class="insight-title">${escapeHtml(it.title)}</span>
        <span class="insight-text">${escapeHtml(it.text)}</span>
        ${it.target ? `<button type="button" class="btn btn-sm btn-ghost insight-action" data-insight="${escapeHtml(it.target)}">${escapeHtml(it.action || "Ver")}</button>` : ""}
      </div>`
    )
    .join("");
}

// ----------------------------- Graficos de tendencia -----------------------------

function renderTrendCharts(result) {
  if (!chartReady()) return;
  const t = result.trends;

  const rentalDatasets = [
    {
      label: "Alugueis",
      data: t.rentals,
      borderColor: "#41a812",
      backgroundColor: "rgba(65, 168, 18, 0.15)",
      fill: true,
      tension: 0.3,
      pointRadius: 2,
    },
  ];
  if (t.prevRentals) {
    rentalDatasets.push({
      label: "Periodo anterior",
      data: t.prevRentals,
      borderColor: "#9ca3af",
      borderDash: [5, 4],
      fill: false,
      tension: 0.3,
      pointRadius: 0,
    });
  }
  upsertChart("rentals", "chartRentals", {
    type: "line",
    data: { labels: t.labels, datasets: rentalDatasets },
    options: baseChartOptions(),
  });

  upsertChart("units", "chartUnits", {
    type: "bar",
    data: {
      labels: t.labels,
      datasets: [
        {
          type: "bar",
          label: "Unidades em uso",
          data: t.unitsOut,
          backgroundColor: "rgba(14, 165, 233, 0.45)",
          borderRadius: 4,
          yAxisID: "y",
        },
        {
          type: "line",
          label: "Taxa de atraso (%)",
          data: t.overdueRate,
          borderColor: "#f59e0b",
          backgroundColor: "#f59e0b",
          tension: 0.3,
          pointRadius: 2,
          yAxisID: "y1",
        },
      ],
    },
    options: {
      ...baseChartOptions(),
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 } },
        y1: {
          beginAtZero: true,
          position: "right",
          grid: { drawOnChartArea: false },
          ticks: { callback: (v) => v + "%" },
          max: 100,
        },
      },
    },
  });
}

function baseChartOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: true, labels: { boxWidth: 12, font: { size: 11 } } },
      tooltip: { enabled: true },
    },
    scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
  };
}

// ----------------------------- Engajamento da base -----------------------------

function renderEngagement(result) {
  const el = $("#engagement");
  if (!el) return;
  const eng = result.engagement || { total: 0, items: [] };
  if (!eng.total) {
    el.innerHTML = `<p class="opp-empty">Nenhuma agencia cadastrada.</p>`;
    return;
  }
  const max = Math.max(...eng.items.map((i) => i.value), 1);
  el.innerHTML =
    `<p class="eng-total">${fmtInt(eng.total)} agencias cadastradas</p>` +
    eng.items
      .map(
        (i) => `<div class="funnel-step">
        <div class="funnel-meta">
          <span class="funnel-name"><span class="seg-swatch" style="background:${i.color}"></span> ${escapeHtml(i.label)}</span>
          <span class="funnel-val">${fmtInt(i.value)} (${i.pct}%)</span>
        </div>
        <div class="funnel-track"><div class="funnel-fill" style="width:${Math.max(2, Math.round((i.value / max) * 100))}%;background:${i.color}"></div></div>
      </div>`
      )
      .join("");
}

// ----------------------------- Sazonalidade (heatmap) -----------------------------

function heatColor(intensity) {
  if (!intensity) return "#f1f5f0";
  const t = Math.min(1, intensity);
  const light = [232, 245, 224];
  const dark = [50, 135, 13];
  const mix = light.map((l, i) => Math.round(l + (dark[i] - l) * t));
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

function renderSeasonality(result) {
  const el = $("#seasonality");
  if (!el) return;
  const s = result.seasonality || { weekdays: [], months: [], grid: [], max: 0, total: 0 };
  if (!s.total) {
    el.innerHTML = `<p class="opp-empty">Sem reservas para analisar sazonalidade.</p>`;
    el.style.gridTemplateColumns = "";
    return;
  }
  el.style.gridTemplateColumns = `40px repeat(${s.months.length}, 1fr)`;

  const header = [`<div class="cohort-cell cohort-head"></div>`];
  for (const m of s.months) header.push(`<div class="cohort-cell cohort-head">${escapeHtml(m)}</div>`);

  const body = s.weekdays
    .map((wd, wi) => {
      const cells = [`<div class="cohort-cell cohort-label">${escapeHtml(wd)}</div>`];
      for (let mi = 0; mi < s.months.length; mi++) {
        const v = s.grid[wi][mi];
        const intensity = s.max ? v / s.max : 0;
        const fg = intensity >= 0.55 ? "#fff" : "var(--text)";
        cells.push(
          `<div class="cohort-cell" title="${escapeHtml(wd)} / ${escapeHtml(s.months[mi])}: ${v}" style="background:${heatColor(intensity)};color:${fg}">${v || ""}</div>`
        );
      }
      return cells.join("");
    })
    .join("");

  el.innerHTML = header.join("") + body;
}

function destroyChart(key) {
  if (dashCharts[key]) {
    try {
      dashCharts[key].destroy();
    } catch (_e) {}
    delete dashCharts[key];
  }
}

// ----------------------------- Top agencias -----------------------------

function renderTopAgenciesTable(result) {
  const tbody = $("#top-agencies tbody");
  if (!tbody) return;
  const rows = result.topAgencies || [];
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="4">Nenhuma reserva no periodo selecionado.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map(
      (g) => `<tr>
        <td>${escapeHtml(g.code) || "-"}</td>
        <td>${escapeHtml(g.name)}</td>
        <td>${fmtInt(g.bookings)}</td>
        <td>${fmtInt(g.quantity)}</td>
      </tr>`
    )
    .join("");
}

// ----------------------------- Materiais -----------------------------

function renderMaterialPerf(result) {
  if (!chartReady()) return;
  const ranking = (result.materials?.ranking || []).filter((m) => m.units > 0 || m.bookings > 0).slice(0, 10);
  if (!ranking.length) {
    destroyChart("materials");
    return;
  }
  const colors = ranking.map((m) => m.color || "#41a812");
  upsertChart("materials", "chartMaterials", {
    type: "bar",
    data: {
      labels: ranking.map((m) => m.name),
      datasets: [
        {
          label: "Unidades alugadas",
          data: ranking.map((m) => m.units),
          backgroundColor: colors,
          borderRadius: 4,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            afterLabel: (ctx) => {
              const m = ranking[ctx.dataIndex];
              return `Utilizacao: ${m.utilizationPct}%  |  Reservas: ${m.bookings}`;
            },
          },
        },
      },
      scales: { x: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
}

// ----------------------------- Operacional -----------------------------

function renderActiveRentals(result) {
  const tbody = $("#dashboard-active tbody");
  if (!tbody) return;
  const active = result.ops?.activeRentals || [];
  $("#activeCount").textContent = active.length ? `${fmtInt(active.length)} ativo(s)` : "";
  if (!active.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Nenhum aluguel ativo.</td></tr>`;
    return;
  }
  tbody.innerHTML = active
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.material_name)}</td>
        <td>${escapeHtml(agencyLabel(r))}</td>
        <td>${escapeHtml(r.quantity)}</td>
        <td>${fmtDate(r.checkout_date)}</td>
        <td>${fmtDate(r.expected_return_date)}</td>
        <td>${r.overdue ? '<span class="badge badge-overdue">Atrasado</span>' : '<span class="badge badge-rented">No prazo</span>'}</td>
      </tr>`
    )
    .join("");
}

// ----------------------------- Detalhes de dashboards -----------------------------

function detailIntro(text) {
  return `<p class="muted detail-intro">${escapeHtml(text)}</p>`;
}

function dashboardRentalsRows(result) {
  const rows = data.rentalEntries || [];
  const from = result.period?.from || "";
  const to = result.period?.to || "";
  return rows.filter((r) => {
    if (dashFilters.agencyId && r.agency_id !== dashFilters.agencyId) return false;
    if (dashFilters.materialId && r.material_id !== dashFilters.materialId) return false;
    if (dashFilters.status === "overdue" && !r.overdue) return false;
    else if (dashFilters.status && dashFilters.status !== "overdue" && r.status !== dashFilters.status) return false;
    if (from && (!r.checkout_date || r.checkout_date < from)) return false;
    if (to && (!r.checkout_date || r.checkout_date > to)) return false;
    return true;
  });
}

function openDashboardDetail(kind) {
  const result = currentDashboardResult();
  if (!result) return toast("Nao foi possivel montar os detalhes do painel.", "error");
  const t = result.trends || {};
  const periodText = `${fmtDate(result.period?.from)} - ${fmtDate(result.period?.to)}`;
  const rentalRows = dashboardRentalsRows(result);
  const rentalDetailRows = rentalRows.map((r) => [
    escapeHtml(fmtDate(r.checkout_date)),
    escapeHtml(r.event_name || "-"),
    escapeHtml(agencyLabel(r)),
    escapeHtml(r.material_name || "-"),
    escapeHtml(r.quantity || 0),
    r.overdue ? '<span class="badge badge-overdue">Atrasado</span>' : escapeHtml(r.status || "-"),
  ]);

  const handlers = {
    "dash-kpi-rentals": () => ({
      title: "Alugueis no periodo",
      body: detailIntro(`Registros considerados no periodo ${periodText}.`) +
        detailTable(["Retirada", "Evento", "Agencia", "Material", "Qtd", "Situacao"], rentalDetailRows),
    }),
    "dash-kpi-units": () => ({
      title: "Unidades em uso",
      body: detailIntro(`Itens alugados considerados no periodo ${periodText}.`) +
        detailTable(["Retirada", "Evento", "Agencia", "Material", "Qtd", "Situacao"], rentalDetailRows),
    }),
    "dash-kpi-agencies": () => ({
      title: "Agencias ativas",
      body: detailIntro(`Agencias com reservas no periodo ${periodText}.`) +
        detailTable(
          ["Codigo", "Agencia", "Reservas", "Qtd. total"],
          (result.topAgencies || []).map((g) => [
            escapeHtml(g.code || "-"),
            escapeHtml(g.name),
            escapeHtml(fmtInt(g.bookings)),
            escapeHtml(fmtInt(g.quantity)),
          ])
        ),
    }),
    "dash-kpi-overdue": () => ({
      title: "Atrasos no periodo",
      body: detailIntro(`Itens atrasados dentro dos filtros atuais.`) +
        detailTable(["Retirada", "Evento", "Agencia", "Material", "Qtd", "Situacao"], rentalDetailRows.filter((row) => String(row[5]).includes("Atrasado"))),
    }),
    "dash-kpi-duration": () => ({
      title: "Duracao media",
      body: detailIntro("Alugueis devolvidos usados para calcular a duracao media.") +
        detailTable(["Retirada", "Evento", "Agencia", "Material", "Qtd", "Situacao"], rentalDetailRows.filter((row) => String(row[5]).includes("devolvido"))),
    }),
    "dash-trend-rentals": () => ({
      title: "Alugueis ao longo do tempo",
      body: detailIntro(`Serie exibida no grafico para ${periodText}.`) +
        detailTable(
          ["Periodo", "Alugueis", "Periodo anterior"],
          (t.labels || []).map((label, i) => [
            escapeHtml(label),
            escapeHtml(fmtInt(t.rentals?.[i] || 0)),
            escapeHtml(t.prevRentals ? fmtInt(t.prevRentals[i] || 0) : "-"),
          ])
        ),
    }),
    "dash-trend-units": () => ({
      title: "Unidades em uso e atrasos",
      body: detailIntro(`Serie exibida no grafico para ${periodText}.`) +
        detailTable(
          ["Periodo", "Unidades em uso", "Taxa de atraso"],
          (t.labels || []).map((label, i) => [
            escapeHtml(label),
            escapeHtml(fmtInt(t.unitsOut?.[i] || 0)),
            escapeHtml(`${t.overdueRate?.[i] || 0}%`),
          ])
        ),
    }),
    "dash-engagement": () => ({
      title: "Engajamento das agencias",
      body: detailIntro("Distribuicao das agencias por recencia de uso.") +
        detailTable(
          ["Faixa", "Agencias", "% da base"],
          (result.engagement?.items || []).map((i) => [
            escapeHtml(i.label),
            escapeHtml(fmtInt(i.value)),
            escapeHtml(`${i.pct}%`),
          ])
        ),
    }),
    "dash-seasonality": () => {
      const s = result.seasonality || {};
      const rows = [];
      (s.weekdays || []).forEach((wd, wi) => {
        (s.months || []).forEach((month, mi) => {
          const value = s.grid?.[wi]?.[mi] || 0;
          if (value) rows.push([escapeHtml(wd), escapeHtml(month), escapeHtml(fmtInt(value))]);
        });
      });
      return {
        title: "Sazonalidade das reservas",
        body: detailIntro("Celulas com reservas no mapa dia x mes.") + detailTable(["Dia", "Mes", "Reservas"], rows),
      };
    },
    "dash-top-agencies": () => ({
      title: "Agencias com mais reservas",
      body: detailIntro(`Ranking completo no periodo ${periodText}.`) +
        detailTable(
          ["Codigo", "Agencia", "Reservas", "Qtd. total"],
          (result.topAgencies || []).map((g) => [
            escapeHtml(g.code || "-"),
            escapeHtml(g.name),
            escapeHtml(fmtInt(g.bookings)),
            escapeHtml(fmtInt(g.quantity)),
          ])
        ),
    }),
    "dash-active-rentals": () => ({
      title: "Alugueis ativos",
      body: detailIntro("Itens atualmente ativos dentro dos filtros do painel.") +
        detailTable(
          ["Material", "Agencia", "Qtd", "Retirada", "Prev. devolucao", "Situacao"],
          (result.ops?.activeRentals || []).map((r) => [
            escapeHtml(r.material_name),
            escapeHtml(agencyLabel(r)),
            escapeHtml(r.quantity),
            escapeHtml(fmtDate(r.checkout_date)),
            escapeHtml(fmtDate(r.expected_return_date)),
            r.overdue ? '<span class="badge badge-overdue">Atrasado</span>' : '<span class="badge badge-rented">No prazo</span>',
          ])
        ),
    }),
    "dash-materials": () => ({
      title: "Demanda e utilizacao de materiais",
      body: detailIntro(`Ranking de materiais no periodo ${periodText}.`) +
        detailTable(
          ["Material", "Reservas", "Unidades", "Utilizacao"],
          (result.materials?.ranking || []).map((m) => [
            escapeHtml(m.name),
            escapeHtml(fmtInt(m.bookings)),
            escapeHtml(fmtInt(m.units)),
            escapeHtml(`${m.utilizationPct}%`),
          ])
        ),
    }),
  };
  const detail = handlers[kind]?.();
  if (detail) openDetailModal(detail.title, detail.body);
}

function stockDashboardProducts() {
  return filteredStockProducts({
    searchId: "#stockDashSearch",
    categoryId: "#stockDashCategoryFilter",
    supplierId: "#stockDashSupplierFilter",
  });
}

function stockProductDetailRows(products) {
  return products.map((p) => [
    `<span class="mono">${escapeHtml(p.id)}</span>`,
    escapeHtml(p.name),
    escapeHtml(p.category || "-"),
    escapeHtml(p.supplier || "-"),
    escapeHtml(fmtInt(p.current_stock)),
    escapeHtml(fmtInt(p.min_stock)),
    escapeHtml(fmtInt(purchaseNeeded(p))),
    escapeHtml(fmtMoney(p.stock_value)),
    stockStatusBadge(p),
  ]);
}

function openStockDashboardDetail(kind) {
  const products = stockDashboardProducts();
  const statusLabels = {
    ok: "Dentro da faixa",
    low: "Abaixo do minimo",
    empty: "Sem estoque",
    excess: "Excedente",
  };
  const productHeaders = ["Codigo", "Produto", "Categoria", "Fornecedor", "Atual", "Min.", "Comprar", "Valor", "Situacao"];
  if (kind === "stock-products-filtered") {
    return openDetailModal(
      "Produtos filtrados",
      detailIntro("Produtos considerados nos indicadores atuais do dashboard de estoque.") +
        detailTable(productHeaders, stockProductDetailRows(products))
    );
  }
  if (kind === "stock-purchase") {
    const rows = products.filter((p) => purchaseNeeded(p) > 0).sort((a, b) => purchaseNeeded(b) - purchaseNeeded(a));
    return openDetailModal(
      "Comprar para atingir o estoque minimo",
      detailIntro("Produtos abaixo do estoque minimo, com quantidade sugerida de compra.") +
        detailTable(productHeaders, stockProductDetailRows(rows))
    );
  }
  if (kind === "stock-excess") {
    const rows = products.filter((p) => p.status === "excess");
    return openDetailModal(
      "Produtos excedentes",
      detailIntro("Produtos acima do estoque maximo definido.") +
        detailTable(productHeaders, stockProductDetailRows(rows))
    );
  }
  if (kind === "stock-status") {
    const counts = products.reduce((acc, p) => {
      const key = p.status || "sem_status";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return openDetailModal(
      "Situacao do estoque",
      detailIntro("Resumo por situacao e lista completa de produtos filtrados.") +
        detailTable(["Situacao", "Produtos"], Object.entries(counts).map(([k, v]) => [escapeHtml(statusLabels[k] || k), escapeHtml(fmtInt(v))])) +
        `<h4 class="detail-subtitle">Produtos</h4>` +
        detailTable(productHeaders, stockProductDetailRows(products))
    );
  }
  if (kind === "stock-category") {
    const byCategory = new Map();
    for (const p of products) {
      const cat = p.category || "Sem categoria";
      const cur = byCategory.get(cat) || { products: 0, units: 0, value: 0 };
      cur.products += 1;
      cur.units += Number(p.current_stock) || 0;
      cur.value += Number(p.stock_value) || 0;
      byCategory.set(cat, cur);
    }
    const rows = Array.from(byCategory.entries())
      .sort((a, b) => b[1].units - a[1].units)
      .map(([cat, info]) => [
        escapeHtml(cat),
        escapeHtml(fmtInt(info.products)),
        escapeHtml(fmtInt(info.units)),
        escapeHtml(fmtMoney(info.value)),
      ]);
    return openDetailModal(
      "Estoque por categoria",
      detailIntro("Totais agrupados pelas categorias dos produtos filtrados.") +
        detailTable(["Categoria", "Produtos", "Unidades", "Valor estimado"], rows)
    );
  }
}

function openDetail(kind) {
  if (!kind) return;
  if (kind.startsWith("stock-")) return openStockDashboardDetail(kind);
  return openDashboardDetail(kind);
}

// ----------------------------- Filtros / interacoes do painel -----------------------------

function resetDashFilters() {
  $("#fltPreset").value = "last30";
  setBRDateField("fltFrom", "");
  setBRDateField("fltTo", "");
  $("#fltAgency").value = "";
  $("#fltMaterial").value = "";
  $("#fltStatus").value = "";
  renderDashboard();
}

// Acoes dos cartoes de insight: leva o usuario ao contexto relevante.
function handleInsightAction(target) {
  if (target === "materials") {
    switchView("materials");
  } else if (target === "overdue") {
    switchView("rentals");
    const sel = $("#rentalStatusFilter");
    if (sel) {
      sel.value = "overdue";
      renderRentals();
    }
  }
  // churn e segments ja estao visiveis no proprio painel.
}

// ----------------------------- Materiais -----------------------------

function renderMaterials() {
  const term = $("#materialSearch").value.trim().toLowerCase();

  const rows = data.materials.filter((m) => {
    return !term ||
      m.name.toLowerCase().includes(term) ||
      (m.description || "").toLowerCase().includes(term);
  });
  sortRows(rows, "materials", (m, key) => {
    if (key === "available") return m.available;
    if (key === "rented") return m.rented;
    if (key === "total_quantity") return m.total_quantity;
    return m[key] || "";
  });

  const tbody = $("#materials-table tbody");
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">Nenhum material encontrado.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((m) => {
      const swatchColor = m.color || DEFAULT_MATERIAL_COLOR;
      return `<tr>
        <td><span class="swatch" style="background:${escapeHtml(swatchColor)}" title="${escapeHtml(m.color ? swatchColor : "Cor padrao")}"></span>${escapeHtml(m.name)}</td>
        <td>${escapeHtml(m.total_quantity)}</td>
        <td>${escapeHtml(m.rented)}</td>
        <td>${escapeHtml(m.notes) || "-"}</td>
        <td class="col-actions">
          <button class="btn-link" data-edit-material="${m.id}">Editar</button>
          <button class="btn-link danger" data-del-material="${m.id}">Excluir</button>
        </td>
      </tr>`;
    })
    .join("");
  renderSortIndicators();
}

function materialFormHtml(m = {}) {
  return `
    <div class="form-grid">
      <div class="field full">
        <label>Nome *</label>
        <input name="name" value="${escapeHtml(m.name)}" required />
      </div>
      <div class="field">
        <label>Quantidade total *</label>
        <input name="total_quantity" type="number" min="0" step="1" value="${escapeHtml(m.total_quantity ?? 0)}" required />
      </div>
      <div class="field full">
        <label>Descricao</label>
        <input name="description" value="${escapeHtml(m.description)}" />
      </div>
      <div class="field">
        <label>Cor no calendario</label>
        <div class="color-field">
          <input name="color" id="materialColor" type="color" value="${escapeHtml(m.color || DEFAULT_MATERIAL_COLOR)}" />
          <label class="color-default">
            <input type="checkbox" id="materialNoColor" ${m.color ? "" : "checked"} />
            Usar cor padrao
          </label>
        </div>
      </div>
      <div class="field full">
        <label>Observacoes</label>
        <textarea name="notes">${escapeHtml(m.notes)}</textarea>
      </div>
    </div>`;
}

function openMaterialForm(material) {
  const editing = !!material;
  openModal(
    editing ? "Editar material" : "Novo material",
    materialFormHtml(material || {}),
    async () => {
      const v = formValues();
      const payload = { ...v };
      // Quando "usar cor padrao" esta marcado, grava cor vazia (calendario usa o accent).
      if ($("#materialNoColor")?.checked) payload.color = "";
      if (editing) {
        payload.id = material.id;
        payload._baseline = material;
        return await handleResult(window.api.updateMaterial(payload), "Material atualizado.");
      }
      return await handleResult(window.api.createMaterial(payload), "Material criado.");
    }
  );

  // Liga/desliga o seletor de cor conforme a opcao de cor padrao.
  const colorInput = $("#materialColor");
  const noColor = $("#materialNoColor");
  if (colorInput && noColor) {
    const sync = () => {
      colorInput.disabled = noColor.checked;
      colorInput.classList.toggle("is-disabled", noColor.checked);
    };
    noColor.addEventListener("change", sync);
    sync();
  }
}

// ----------------------------- Estoque -----------------------------

function stockStatusBadge(p) {
  const cls =
    p.status === "empty" || p.status === "low"
      ? "badge-overdue"
      : p.status === "excess"
        ? "badge-partial"
        : "badge-ok";
  return `<span class="badge ${cls}">${escapeHtml(p.status_label || "-")}</span>`;
}

function purchaseNeeded(p) {
  return Math.max(0, (Number(p.min_stock) || 0) - (Number(p.current_stock) || 0));
}

function stockFilterOptions(field) {
  return [...new Set((data.stockProducts || []).map((p) => String(p[field] || "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
}

function syncStockSelect(sel, values, placeholder = "Todos") {
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML =
    `<option value="">${escapeHtml(placeholder)}</option>` +
    values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
  sel.value = values.includes(prev) ? prev : "";
}

function populateStockFilterOptions() {
  const categories = stockFilterOptions("category");
  const suppliers = stockFilterOptions("supplier");
  syncStockSelect($("#stockDashCategoryFilter"), categories, "Todas");
  syncStockSelect($("#stockProductCategoryFilter"), categories, "Todas");
  syncStockSelect($("#stockMovementCategoryFilter"), categories, "Todas");
  syncStockSelect($("#stockDashSupplierFilter"), suppliers, "Todos");
  syncStockSelect($("#stockProductSupplierFilter"), suppliers, "Todos");

  const products = (data.stockProducts || [])
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .map((p) => ({ value: p.id, label: `${p.id} - ${p.name}` }));
  const productSel = $("#stockMovementProductFilter");
  if (productSel) {
    const prev = productSel.value;
    productSel.innerHTML =
      '<option value="">Todos</option>' +
      products.map((p) => `<option value="${escapeHtml(p.value)}">${escapeHtml(p.label)}</option>`).join("");
    productSel.value = products.some((p) => p.value === prev) ? prev : "";
  }
}

function filteredStockProducts({ searchId, categoryId, supplierId, statusId }) {
  const term = ($(searchId)?.value || "").trim().toLowerCase();
  const category = $(categoryId)?.value || "";
  const supplier = $(supplierId)?.value || "";
  const status = $(statusId)?.value || "";
  return (data.stockProducts || []).filter((p) => {
    const needed = purchaseNeeded(p);
    if (category && p.category !== category) return false;
    if (supplier && p.supplier !== supplier) return false;
    if (status === "needs_purchase" && needed <= 0) return false;
    else if (status && status !== "needs_purchase" && p.status !== status) return false;
    return !term ||
      p.id.toLowerCase().includes(term) ||
      p.name.toLowerCase().includes(term) ||
      (p.category || "").toLowerCase().includes(term) ||
      (p.supplier || "").toLowerCase().includes(term) ||
      (p.notes || "").toLowerCase().includes(term);
  });
}

function movementTypeBadge(type) {
  return type === "saida"
    ? '<span class="badge badge-overdue">Saida</span>'
    : '<span class="badge badge-ok">Entrada</span>';
}

function renderStock() {
  renderStockDashboard();
  renderStockProducts();
  renderStockMovements();
}

function renderStockDashboard() {
  populateStockFilterOptions();
  renderStockKpis();
  renderStockCharts();
  renderPurchaseAlerts();
}

function renderStockKpis() {
  const products = filteredStockProducts({
    searchId: "#stockDashSearch",
    categoryId: "#stockDashCategoryFilter",
    supplierId: "#stockDashSupplierFilter",
  });
  const totalStock = products.reduce((sum, p) => sum + (Number(p.current_stock) || 0), 0);
  const totalValue = products.reduce((sum, p) => sum + (Number(p.stock_value) || 0), 0);
  const needsPurchase = products.filter((p) => purchaseNeeded(p) > 0);
  const purchaseUnits = needsPurchase.reduce((sum, p) => sum + purchaseNeeded(p), 0);
  const excess = products.filter((p) => p.status === "excess").length;
  const grid = $("#stockKpiGrid");
  if (!grid) return;
  grid.innerHTML = [
    kpiCard({ label: "Produtos filtrados", value: fmtInt(products.length), sub: "cadastros visiveis", detail: "stock-products-filtered" }),
    kpiCard({ label: "Comprar agora", value: fmtInt(needsPurchase.length), sub: `${fmtInt(purchaseUnits)} unidade(s) para minimo`, detail: "stock-purchase" }),
    kpiCard({ label: "Unidades em estoque", value: fmtInt(totalStock), sub: "saldo atual", detail: "stock-products-filtered" }),
    kpiCard({ label: "Valor estimado", value: fmtMoney(totalValue), sub: "preco medio de compra", detail: "stock-products-filtered" }),
    kpiCard({ label: "Excedentes", value: fmtInt(excess), sub: "acima do maximo", detail: "stock-excess" }),
  ].join("");
}

function renderStockCharts() {
  if (!chartReady()) return;
  const products = filteredStockProducts({
    searchId: "#stockDashSearch",
    categoryId: "#stockDashCategoryFilter",
    supplierId: "#stockDashSupplierFilter",
  });
  const statusLabels = {
    ok: "Dentro da faixa",
    low: "Abaixo do minimo",
    empty: "Sem estoque",
    excess: "Excedente",
  };
  const statusColors = {
    ok: "#41a812",
    low: "#ef4444",
    empty: "#991b1b",
    excess: "#f59e0b",
  };
  const byStatus = products.reduce((acc, p) => {
    acc[p.status] = (acc[p.status] || 0) + 1;
    return acc;
  }, {});
  const statusEntries = Object.entries(byStatus).filter(([, v]) => v > 0);
  if (statusEntries.length) {
    upsertChart("stockStatus", "chartStockStatus", {
      type: "doughnut",
      data: {
        labels: statusEntries.map(([k]) => statusLabels[k] || k),
        datasets: [{ data: statusEntries.map(([, v]) => v), backgroundColor: statusEntries.map(([k]) => statusColors[k] || "#94a3b8") }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } },
    });
  } else {
    destroyChart("stockStatus");
  }

  const byCategory = new Map();
  for (const p of products) {
    const cat = p.category || "Sem categoria";
    byCategory.set(cat, (byCategory.get(cat) || 0) + (Number(p.current_stock) || 0));
  }
  const cats = Array.from(byCategory.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (cats.length) {
    upsertChart("stockCategory", "chartStockCategory", {
      type: "bar",
      data: {
        labels: cats.map(([k]) => k),
        datasets: [{ label: "Unidades", data: cats.map(([, v]) => v), backgroundColor: "rgba(14, 165, 233, 0.45)", borderRadius: 4 }],
      },
      options: { ...baseChartOptions(), indexAxis: "y" },
    });
  } else {
    destroyChart("stockCategory");
  }
}

function renderPurchaseAlerts() {
  const rows = filteredStockProducts({
    searchId: "#stockDashSearch",
    categoryId: "#stockDashCategoryFilter",
    supplierId: "#stockDashSupplierFilter",
  })
    .filter((p) => purchaseNeeded(p) > 0);
  sortRows(rows, "stockPurchase", stockProductSortValue);
  const count = $("#purchaseAlertCount");
  if (count) count.textContent = `${fmtInt(rows.length)} item(ns)`;
  const tbody = $("#stock-purchase-table tbody");
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">Nenhum produto abaixo do estoque minimo nos filtros atuais.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((p) => {
      const needed = purchaseNeeded(p);
      return `<tr>
        <td><span class="mono">${escapeHtml(p.id)}</span> - ${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.category) || "-"}</td>
        <td>${fmtInt(p.current_stock)}</td>
        <td>${fmtInt(p.min_stock)}</td>
        <td><strong class="stock-buy">${fmtInt(needed)}</strong></td>
        <td>${fmtDate(p.last_movement_date)}</td>
        <td class="col-actions">
          <button class="btn-link" data-edit-stock-product="${escapeHtml(p.id)}">Editar</button>
          <button class="btn-link" data-nav-target="stock-movements" data-product-filter="${escapeHtml(p.id)}">Movimentar</button>
        </td>
      </tr>`;
    })
    .join("");
  renderSortIndicators();
}

function renderStockProducts() {
  populateStockFilterOptions();
  const sortSelect = $("#stockProductSort");
  if (sortSelect && Array.from(sortSelect.options).some((opt) => opt.value === tableSort.stockProducts.key)) {
    sortSelect.value = tableSort.stockProducts.key;
  }
  const rows = getFilteredSortedStockProducts();
  const tbody = $("#stock-products-table tbody");
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="11">Nenhum produto encontrado.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map(
      (p) => `<tr>
        <td class="mono">${escapeHtml(p.id)}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.category) || "-"}</td>
        <td>${escapeHtml(p.supplier) || "-"}</td>
        <td>${fmtInt(p.current_stock)}</td>
        <td>${fmtInt(p.min_stock)}</td>
        <td>${purchaseNeeded(p) ? `<strong class="stock-buy">${fmtInt(purchaseNeeded(p))}</strong>` : "-"}</td>
        <td>${fmtInt(p.max_stock)}</td>
        <td>${fmtMoney(p.stock_value)}</td>
        <td>${stockStatusBadge(p)}</td>
        <td class="col-actions">
          <button class="btn-link" data-edit-stock-product="${escapeHtml(p.id)}">Editar</button>
          <button class="btn-link danger" data-del-stock-product="${escapeHtml(p.id)}">Excluir</button>
        </td>
      </tr>`
    )
    .join("");
  renderSortIndicators();
}

function getFilteredStockMovements() {
  populateStockFilterOptions();
  const term = ($("#stockMovementSearch")?.value || "").trim().toLowerCase();
  const productId = $("#stockMovementProductFilter")?.value || "";
  const category = $("#stockMovementCategoryFilter")?.value || "";
  const type = $("#stockMovementTypeFilter")?.value || "";
  const from = $("#stockMovementFrom")?.value || "";
  const to = $("#stockMovementTo")?.value || "";
  const productById = new Map((data.stockProducts || []).map((p) => [p.id, p]));
  return (data.stockMovements || []).filter((m) => {
    const p = productById.get(m.product_id);
    if (productId && m.product_id !== productId) return false;
    if (category && (p?.category || "") !== category) return false;
    if (type && m.type !== type) return false;
    if (from && (!m.movement_date || m.movement_date < from)) return false;
    if (to && (!m.movement_date || m.movement_date > to)) return false;
    return !term ||
      (m.product_name || "").toLowerCase().includes(term) ||
      (m.product_id || "").toLowerCase().includes(term) ||
      (p?.category || "").toLowerCase().includes(term) ||
      (m.notes || "").toLowerCase().includes(term);
  });
}

function stockProductSortValue(p, key) {
  if (key === "needed") return purchaseNeeded(p);
  if (key === "current_stock") return p.current_stock;
  if (key === "min_stock") return p.min_stock;
  if (key === "max_stock") return p.max_stock;
  if (key === "stock_value") return p.stock_value;
  if (key === "status") return p.status_label;
  return p[key] || "";
}

function stockMovementSortValue(m, key) {
  const productById = new Map((data.stockProducts || []).map((p) => [p.id, p]));
  const p = productById.get(m.product_id);
  if (key === "product") return m.product_name;
  if (key === "category") return p?.category || "";
  if (key === "quantity") return m.quantity;
  if (key === "unit_cost") return m.unit_cost;
  if (key === "total_value") return m.total_value;
  return m[key] || "";
}

function getFilteredSortedStockProducts() {
  const rows = filteredStockProducts({
    searchId: "#stockProductSearch",
    categoryId: "#stockProductCategoryFilter",
    supplierId: "#stockProductSupplierFilter",
    statusId: "#stockProductStatusFilter",
  });
  return sortRows(rows, "stockProducts", stockProductSortValue);
}

function getFilteredSortedStockMovements() {
  const rows = getFilteredStockMovements();
  return sortRows(rows, "stockMovements", stockMovementSortValue);
}

function renderStockMovements() {
  const productById = new Map((data.stockProducts || []).map((p) => [p.id, p]));
  const rows = getFilteredSortedStockMovements();
  const tbody = $("#stock-movements-table tbody");
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="9">Nenhuma movimentacao encontrada.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((m) => {
      const p = productById.get(m.product_id);
      return `<tr>
        <td>${fmtDate(m.movement_date)}</td>
        <td><span class="mono">${escapeHtml(m.product_id)}</span> - ${escapeHtml(m.product_name)}</td>
        <td>${escapeHtml(p?.category || "") || "-"}</td>
        <td>${movementTypeBadge(m.type)}</td>
        <td>${fmtInt(m.quantity)}</td>
        <td>${fmtMoney(m.unit_cost)}</td>
        <td>${fmtMoney(m.total_value)}</td>
        <td>${escapeHtml(m.notes) || "-"}</td>
        <td class="col-actions">
          <button class="btn-link" data-edit-stock-movement="${escapeHtml(m.id)}">Editar</button>
          <button class="btn-link danger" data-del-stock-movement="${escapeHtml(m.id)}">Excluir</button>
        </td>
      </tr>`;
    })
    .join("");
  renderSortIndicators();
}

function stockProductFormHtml(p = {}) {
  const editing = !!p.id;
  return `
    <div class="form-grid">
      <div class="field">
        <label>Codigo do produto *</label>
        <input name="id" value="${escapeHtml(p.id)}" ${editing ? "readonly" : ""} required />
      </div>
      <div class="field">
        <label>Categoria</label>
        <input name="category" value="${escapeHtml(p.category)}" />
      </div>
      <div class="field full">
        <label>Descricao *</label>
        <input name="name" value="${escapeHtml(p.name)}" required />
      </div>
      <div class="field">
        <label>Fornecedor</label>
        <input name="supplier" value="${escapeHtml(p.supplier)}" />
      </div>
      <div class="field">
        <label>Estoque minimo *</label>
        <input name="min_stock" type="number" min="0" step="1" value="${escapeHtml(p.min_stock ?? 0)}" required />
      </div>
      <div class="field">
        <label>Estoque maximo *</label>
        <input name="max_stock" type="number" min="0" step="1" value="${escapeHtml(p.max_stock ?? 0)}" required />
      </div>
      <div class="field full">
        <label>Observacoes</label>
        <textarea name="notes">${escapeHtml(p.notes)}</textarea>
      </div>
    </div>`;
}

function openStockProductForm(product) {
  const editing = !!product;
  openModal(
    editing ? "Editar produto" : "Novo produto",
    stockProductFormHtml(product || {}),
    async () => {
      const payload = formValues();
      if (editing) {
        payload.id = product.id;
        payload._baseline = product;
        return await handleResult(window.api.updateStockProduct(payload), "Produto atualizado.");
      }
      return await handleResult(window.api.createStockProduct(payload), "Produto criado.");
    }
  );
}

function stockMovementFormHtml(m = {}) {
  const productOptions = (data.stockProducts || [])
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === m.product_id ? "selected" : ""}>${escapeHtml(p.id)} - ${escapeHtml(p.name)}</option>`)
    .join("");
  return `
    <div class="form-grid">
      <div class="field full">
        <label>Produto *</label>
        <select name="product_id" required>
          <option value="">Selecione...</option>
          ${productOptions}
        </select>
      </div>
      <div class="field">
        <label>Tipo *</label>
        <select name="type" required>
          <option value="entrada" ${m.type === "entrada" ? "selected" : ""}>Entrada</option>
          <option value="saida" ${m.type === "saida" ? "selected" : ""}>Saida</option>
        </select>
      </div>
      <div class="field">
        ${brDateField({ label: "Data da movimentacao *", name: "movement_date", baseId: "stockMovementDate", iso: m.movement_date || data.today, required: true })}
      </div>
      <div class="field">
        <label>Quantidade *</label>
        <input name="quantity" type="number" min="1" step="1" value="${escapeHtml(m.quantity ?? 1)}" required />
      </div>
      <div class="field">
        <label>Valor unitario</label>
        <input name="unit_cost" inputmode="decimal" value="${escapeHtml(m.unit_cost || "")}" placeholder="0,00" />
      </div>
      <div class="field">
        <label>Valor da transacao</label>
        <input name="total_value" inputmode="decimal" value="${escapeHtml(m.total_value || "")}" placeholder="Calculado se vazio" />
      </div>
      <div class="field full">
        <label>Observacoes</label>
        <textarea name="notes">${escapeHtml(m.notes)}</textarea>
      </div>
    </div>`;
}

function openStockMovementForm(movement) {
  if (!(data.stockProducts || []).length) return toast("Cadastre um produto antes.", "warn");
  const editing = !!movement;
  openModal(
    editing ? "Editar movimentacao" : "Nova movimentacao",
    stockMovementFormHtml(movement || {}),
    async () => {
      const payload = formValues();
      if (!DateUtils.isValidISO(payload.movement_date)) {
        showModalError("Informe uma data valida (dd/mm/aaaa).");
        return { ok: false };
      }
      if (editing) {
        payload.id = movement.id;
        payload._baseline = movement;
        return await handleResult(window.api.updateStockMovement(payload), "Movimentacao atualizada.");
      }
      return await handleResult(window.api.createStockMovement(payload), "Movimentacao registrada.");
    },
    editing ? "Salvar" : "Registrar"
  );
  initDateInputs($("#modalBody"));
  markModalPristine();
}

function applyStockProductSortSelect() {
  const key = $("#stockProductSort")?.value || "needed";
  tableSort.stockProducts = {
    key,
    dir: ["needed", "current_stock", "min_stock", "max_stock", "stock_value"].includes(key) ? "desc" : "asc",
  };
  renderStockProducts();
}

function exportStockProductsReport() {
  const rows = getFilteredSortedStockProducts();
  downloadCsv(
    `relatorio_produtos_estoque_${data.today || "hoje"}.csv`,
    ["codigo_produto", "descricao", "categoria", "fornecedor", "estoque_atual", "estoque_minimo", "comprar", "estoque_maximo", "valor_estoque", "situacao", "ultima_movimentacao", "observacoes"],
    rows.map((p) => [
      p.id,
      p.name,
      p.category,
      p.supplier,
      p.current_stock,
      p.min_stock,
      purchaseNeeded(p),
      p.max_stock,
      csvNumber(p.stock_value),
      p.status_label,
      p.last_movement_date,
      p.notes,
    ])
  );
  toast("Relatorio de produtos baixado.", "success");
}

function exportStockMovementsReport() {
  const productById = new Map((data.stockProducts || []).map((p) => [p.id, p]));
  const rows = getFilteredSortedStockMovements();
  downloadCsv(
    `relatorio_entradas_saidas_${data.today || "hoje"}.csv`,
    ["data_movimentacao", "codigo_produto", "produto", "categoria", "tipo", "quantidade", "valor_unitario", "valor_transacao", "observacoes"],
    rows.map((m) => {
      const p = productById.get(m.product_id);
      return [
        m.movement_date,
        m.product_id,
        m.product_name,
        p?.category || "",
        m.type === "saida" ? "Saida" : "Entrada",
        m.quantity,
        csvNumber(m.unit_cost),
        csvNumber(m.total_value),
        m.notes,
      ];
    })
  );
  toast("Relatorio de entradas e saidas baixado.", "success");
}

// ----------------------------- Agencias -----------------------------

function renderAgencies() {
  const term = $("#agencySearch").value.trim().toLowerCase();
  const rows = data.agencies.filter((a) => {
    return !term ||
      a.name.toLowerCase().includes(term) ||
      (a.code || "").toLowerCase().includes(term) ||
      (a.contact_person || "").toLowerCase().includes(term) ||
      (a.email || "").toLowerCase().includes(term) ||
      (a.phone || "").toLowerCase().includes(term);
  });
  sortRows(rows, "agencies", (a, key) => a[key] || "");

  const tbody = $("#agencies-table tbody");
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">Nenhuma agencia encontrada.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map(
      (a) => `<tr>
        <td>${escapeHtml(a.code) || "-"}</td>
        <td>${escapeHtml(a.name)}</td>
        <td>${escapeHtml(a.contact_person) || "-"}</td>
        <td>${escapeHtml(a.phone) || "-"}</td>
        <td>${escapeHtml(a.email) || "-"}</td>
        <td>${escapeHtml(a.notes) || "-"}</td>
        <td class="col-actions">
          <button class="btn-link" data-edit-agency="${a.id}">Editar</button>
          <button class="btn-link danger" data-del-agency="${a.id}">Excluir</button>
        </td>
      </tr>`
    )
    .join("");
  renderSortIndicators();
}

function agencyFormHtml(a = {}) {
  return `
    <div class="form-grid">
      <div class="field">
        <label>Codigo *</label>
        <input name="code" value="${escapeHtml(a.code)}" inputmode="numeric" pattern="\\d+" placeholder="Ex.: 01, 02, 03" required />
      </div>
      <div class="field">
        <label>Nome *</label>
        <input name="name" value="${escapeHtml(a.name)}" required />
      </div>
      <div class="field">
        <label>Pessoa de contato</label>
        <input name="contact_person" value="${escapeHtml(a.contact_person)}" />
      </div>
      <div class="field">
        <label>Telefone</label>
        <input name="phone" value="${escapeHtml(a.phone)}" />
      </div>
      <div class="field full">
        <label>E-mail</label>
        <input name="email" type="email" value="${escapeHtml(a.email)}" />
      </div>
      <div class="field full">
        <label>Observacoes</label>
        <textarea name="notes">${escapeHtml(a.notes)}</textarea>
      </div>
    </div>`;
}

function openAgencyForm(agency) {
  const editing = !!agency;
  openModal(
    editing ? "Editar agencia" : "Nova agencia",
    agencyFormHtml(agency || {}),
    async () => {
      const v = formValues();
      const payload = { ...v };
      if (editing) {
        payload.id = agency.id;
        payload._baseline = agency;
        return await handleResult(window.api.updateAgency(payload), "Agencia atualizada.");
      }
      return await handleResult(window.api.createAgency(payload), "Agencia criada.");
    }
  );
}

// ----------------------------- Alugueis -----------------------------

// Mantem as opcoes de um <select> sincronizadas com os dados, preservando a
// selecao atual quando ainda for valida.
function syncSelectOptions(sel, placeholder, items) {
  const prev = sel.value;
  const opts = items.map((it) => `<option value="${escapeHtml(it.value)}">${escapeHtml(it.label)}</option>`).join("");
  sel.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` + opts;
  sel.value = items.some((it) => String(it.value) === prev) ? prev : "";
}

// Badge da situacao derivada do aluguel (a partir dos itens).
function rentalBadge(r) {
  if (r.status === "devolvido") return '<span class="badge badge-ok">Devolvido</span>';
  if (r.overdue) return '<span class="badge badge-overdue">Atrasado</span>';
  if (r.status === "parcial") return '<span class="badge badge-partial">Parcial</span>';
  return '<span class="badge badge-rented">Alugado</span>';
}

// Lista compacta dos materiais de um aluguel para a tabela.
function rentalItemsCell(r) {
  return (r.items || [])
    .map((it) => {
      const returned = it.status === "devolvido";
      const cls = returned ? "rental-item-line returned" : "rental-item-line";
      const suffix = returned ? ` <span class="muted">(dev. ${fmtDate(it.actual_return_date)})</span>` : "";
      return `<div class="${cls}"><span class="swatch" style="background:${escapeHtml(it.material_color || DEFAULT_MATERIAL_COLOR)}"></span>${escapeHtml(it.quantity)}x ${escapeHtml(it.material_name)}${suffix}</div>`;
    })
    .join("");
}

function rentalSearchScore(r, term) {
  if (window.SearchUtils && typeof window.SearchUtils.rentalSearchScore === "function") {
    return window.SearchUtils.rentalSearchScore(r, term);
  }
  const q = String(term || "").trim().toLocaleLowerCase("pt-BR");
  if (!q) return 0;
  const fields = [
    r.process_number,
    r.event_name,
    r.agency_name,
    r.agency_code,
    ...(r.items || []).map((it) => it.material_name),
  ].join(" ").toLocaleLowerCase("pt-BR");
  return fields.includes(q) ? 1 : -1;
}

function renderRentals() {
  const term = $("#rentalSearch").value.trim();
  const agencyId = $("#rentalAgencyFilter").value;
  const agencyCode = $("#rentalAgencyCodeFilter").value.trim().toLowerCase();
  const materialId = $("#rentalMaterialFilter").value;
  const status = $("#rentalStatusFilter").value;
  const checkoutFrom = $("#rentalCheckoutFrom").value;
  const checkoutTo = $("#rentalCheckoutTo").value;
  const returnFrom = $("#rentalReturnFrom").value;
  const returnTo = $("#rentalReturnTo").value;
  const overdueOnly = $("#rentalOverdueOnly").checked;

  // Popula os selects de agencia e material a partir dos dados atuais.
  syncSelectOptions(
    $("#rentalAgencyFilter"),
    "Todas as agencias",
    data.agencies.map((a) => ({ value: a.id, label: a.code ? `[${a.code}] ${a.name}` : a.name }))
  );
  syncSelectOptions(
    $("#rentalMaterialFilter"),
    "Todos os materiais",
    data.materials
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
      .map((m) => ({ value: m.id, label: m.name }))
  );

  const rows = data.rentals.map((r) => ({ rental: r, searchScore: rentalSearchScore(r, term) })).filter((entry) => {
    const r = entry.rental;
    const items = r.items || [];
    if (term && entry.searchScore < 0) return false;

    if (agencyId && r.agency_id !== agencyId) return false;
    if (agencyCode && !String(r.agency_code || "").toLowerCase().includes(agencyCode)) return false;
    if (materialId && !items.some((it) => it.material_id === materialId)) return false;

    if (status === "overdue") { if (!r.overdue) return false; }
    else if (status === "alugado") { if (r.status !== "alugado" && r.status !== "parcial") return false; }
    else if (status) { if (r.status !== status) return false; }

    if (overdueOnly && !r.overdue) return false;

    // Faixas de data (comparacao lexicografica de YYYY-MM-DD).
    if (checkoutFrom && (!r.checkout_date || r.checkout_date < checkoutFrom)) return false;
    if (checkoutTo && (!r.checkout_date || r.checkout_date > checkoutTo)) return false;
    if (returnFrom && (!r.expected_return_date || r.expected_return_date < returnFrom)) return false;
    if (returnTo && (!r.expected_return_date || r.expected_return_date > returnTo)) return false;

    return true;
  }).map((entry) => entry.rental);
  sortRows(rows, "rentals", (r, key) => {
    if (key === "materials") return (r.items || []).map((it) => it.material_name).join(", ");
    if (key === "total_quantity") return r.total_quantity;
    if (key === "status") return r.overdue ? "atrasado" : r.status;
    if (key === "agency") return r.agency_name;
    return r[key] || "";
  });

  const tbody = $("#rentals-table tbody");
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="10">Nenhum aluguel encontrado.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((r) => {
      const hasActive = (r.items || []).some((it) => it.status === "alugado");
      const actions = hasActive
        ? `<button class="btn-link" data-edit-rental="${r.id}">Editar</button>
           <button class="btn-link" data-return-rental="${r.id}">Devolver</button>
           <button class="btn-link danger" data-del-rental="${r.id}">Excluir</button>`
        : `<button class="btn-link" data-edit-rental="${r.id}">Editar</button>
           <button class="btn-link danger" data-del-rental="${r.id}">Excluir</button>`;

      const atts = r.attachments || [];
      const missing = atts.filter((a) => a.missing).length;
      const attCell = atts.length
        ? `<span class="att-count" title="${missing ? `${missing} arquivo(s) nao encontrado(s)` : `${atts.length} anexo(s)`}">${ATTACH_ICON_SVG} ${atts.length}${missing ? ' <span class="att-missing">!</span>' : ""}</span>`
        : '<span class="muted">-</span>';

      return `<tr>
        <td>${escapeHtml(r.agency_code) || "-"}</td>
        <td>${escapeHtml(r.agency_name)}</td>
        <td>${escapeHtml(r.event_name) || "-"}</td>
        <td>${escapeHtml(r.process_number) || "-"}</td>
        <td class="rental-items-cell">${rentalItemsCell(r)}</td>
        <td>${fmtDate(r.checkout_date)}</td>
        <td>${fmtDate(r.expected_return_date)}</td>
        <td>${rentalBadge(r)}</td>
        <td>${attCell}</td>
        <td class="col-actions">${actions}</td>
      </tr>`;
    })
    .join("");
  renderSortIndicators();
}

function clearRentalFilters() {
  $("#rentalSearch").value = "";
  $("#rentalAgencyFilter").value = "";
  $("#rentalAgencyCodeFilter").value = "";
  $("#rentalMaterialFilter").value = "";
  $("#rentalStatusFilter").value = "";
  setBRDateField("rentalCheckoutFrom", "");
  setBRDateField("rentalCheckoutTo", "");
  setBRDateField("rentalReturnFrom", "");
  setBRDateField("rentalReturnTo", "");
  $("#rentalOverdueOnly").checked = false;
  renderRentals();
}

// Icone de calendario usado no botao do date picker.
const CALENDAR_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>';

// Icone de "+" do botao Adicionar outro material.
const PLUS_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>';

// Icone de clipe (anexos).
const ATTACH_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>';

// Icone de lixeira (remover item/anexo).
const TRASH_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';

// Tamanho de arquivo legivel (anexos).
function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Campo de data com:
//   - input de texto visivel no formato DD/MM/YYYY (digitacao manual);
//   - botao com calendario moderno (input type=date nativo) para selecao;
//   - input type=date que guarda o valor interno ISO e leva o "name" do form.
// O texto BR e o calendario nativo ficam sempre sincronizados.
function brDateField({ label, name, baseId, iso, required }) {
  const visibleId = `${baseId}BR`;
  const brValue = DateUtils.isoToBR(iso || "");
  const req = required ? "required" : "";
  return `
    <label for="${visibleId}">${escapeHtml(label)}</label>
    <div class="date-field">
      <input type="text" id="${visibleId}" class="date-br" data-target="${baseId}"
        inputmode="numeric" maxlength="10" placeholder="dd/mm/aaaa" autocomplete="off" value="${escapeHtml(brValue)}" ${req} />
      <button type="button" class="date-pick-btn" data-pick="${baseId}" aria-label="Abrir calendario">${CALENDAR_ICON_SVG}</button>
      <input type="date" class="date-native" name="${name}" id="${baseId}" value="${escapeHtml(iso || "")}" tabindex="-1" aria-hidden="true" />
    </div>`;
}

function rentalFormHtml(r = {}) {
  const agencyOptions = data.agencies
    .map((a) => {
      const sel = a.id === r.agency_id ? " selected" : "";
      const label = a.code ? `[${a.code}] ${a.name}` : a.name;
      return `<option value="${a.id}"${sel}>${escapeHtml(label)}</option>`;
    })
    .join("");

  return `
    <div class="form-grid">
      <div class="field">
        ${brDateField({ label: "Data de retirada *", name: "checkout_date", baseId: "rentalCheckout", iso: r.checkout_date || data.today, required: true })}
      </div>
      <div class="field">
        ${brDateField({ label: "Devolucao prevista *", name: "expected_return_date", baseId: "rentalReturn", iso: r.expected_return_date || data.today, required: true })}
      </div>
      <div class="field">
        <label for="rentalAgency">Agencia *</label>
        <select name="agency_id" id="rentalAgency" required>
          <option value="">Selecione...</option>
          ${agencyOptions}
        </select>
      </div>
      <div class="field">
        <label for="rentalEvent">Nome do evento</label>
        <input name="event_name" id="rentalEvent" value="${escapeHtml(r.event_name)}" placeholder="Ex.: Feira do Agronegocio" maxlength="120" />
      </div>
      <div class="field">
        <label for="rentalProcess">Numero do processo (FLUID)</label>
        <input name="process_number" id="rentalProcess" value="${escapeHtml(r.process_number)}" placeholder="Ex.: FLUID-12345" maxlength="80" />
      </div>
      <div class="field full">
        <label>Materiais do aluguel *</label>
        <div id="rentalItemsList" class="rental-items"></div>
        <button type="button" class="btn btn-sm add-item-btn" id="addItemBtn">${PLUS_ICON_SVG} Adicionar outro material</button>
        <div class="hint" id="itemsHint"></div>
      </div>
      <div class="field full">
        <label>Resumo</label>
        <div id="rentalSummary" class="rental-summary"></div>
      </div>
      <div class="field full">
        <label>Anexos</label>
        <div id="attachList" class="attach-list"></div>
        <button type="button" class="btn btn-sm" id="addAttachBtn">${ATTACH_ICON_SVG} Adicionar anexos...</button>
        <div class="hint">Limite de 25 MB por arquivo. Tipos permitidos: pdf, imagens, Word/Excel/PowerPoint, txt, csv, zip.</div>
      </div>
      <div class="field full">
        <label for="rentalNotes">Observacoes</label>
        <textarea name="notes" id="rentalNotes">${escapeHtml(r.notes)}</textarea>
      </div>
    </div>`;
}

function openRentalForm(rental) {
  if (!data.materials.length) return toast("Cadastre um material antes.", "warn");
  if (!data.agencies.length) return toast("Cadastre uma agencia antes.", "warn");

  const editing = !!rental;
  let rowSeq = 0;

  // Estado dos itens do formulario. Itens ja devolvidos sao mantidos no estado
  // (serao reenviados intactos), porem ficam travados na interface.
  const itemRows = editing
    ? rental.items.map((it) => ({
        uid: ++rowSeq,
        id: it.id,
        material_id: it.material_id,
        quantity: Number(it.quantity) || 1,
        status: it.status,
        actual_return_date: it.actual_return_date || "",
      }))
    : [{ uid: ++rowSeq, id: "", material_id: "", quantity: 1, status: "alugado", actual_return_date: "" }];

  // Anexos: pendentes (criacao; copiados so ao salvar) e existentes (edicao;
  // adicionados/removidos imediatamente via IPC).
  const pendingFiles = [];
  let existingAtts = editing ? [...(rental.attachments || [])] : [];

  let availMap = null; // { materialId: disponivel } ou null enquanto sem periodo
  let loading = false;

  openModal(
    editing ? "Editar aluguel" : "Novo aluguel",
    rentalFormHtml(rental || {}),
    async () => {
      const v = formValues();
      // Defesa adicional na interface: o backend revalida tudo sob o lock, mas
      // evitamos chamadas obviamente invalidas e damos retorno imediato.
      if (!DateUtils.isValidISO(v.checkout_date)) {
        showModalError("Informe uma data de retirada valida (dd/mm/aaaa).");
        return { ok: false };
      }
      if (!DateUtils.isValidISO(v.expected_return_date)) {
        showModalError("Informe uma devolucao prevista valida (dd/mm/aaaa).");
        return { ok: false };
      }
      if (v.expected_return_date < v.checkout_date) {
        showModalError("A devolucao prevista nao pode ser anterior a retirada.");
        return { ok: false };
      }
      if (!v.agency_id) {
        showModalError("Selecione uma agencia.");
        return { ok: false };
      }
      if (itemRows.some((row) => row.status !== "devolvido" && !row.material_id)) {
        showModalError("Selecione o material de todos os itens (ou remova os itens vazios).");
        return { ok: false };
      }
      if (itemRows.some((row) => !(Number(row.quantity) >= 1))) {
        showModalError("As quantidades devem ser numeros inteiros maiores ou iguais a 1.");
        return { ok: false };
      }
      const ids = itemRows.map((row) => row.material_id).filter(Boolean);
      if (new Set(ids).size !== ids.length) {
        showModalError("O mesmo material aparece em mais de um item. Ajuste a quantidade no item ja existente.");
        return { ok: false };
      }

      const payload = {
        agency_id: v.agency_id,
        event_name: v.event_name,
        process_number: v.process_number,
        checkout_date: v.checkout_date,
        expected_return_date: v.expected_return_date,
        notes: v.notes,
        items: itemRows.map((row) => ({
          id: row.id,
          material_id: row.material_id,
          quantity: Number(row.quantity),
        })),
      };

      if (editing) {
        payload.id = rental.id;
        payload._baseline = rental;
        return await handleResult(window.api.updateRental(payload), "Aluguel atualizado.");
      }
      payload.attachments = pendingFiles.map((f) => ({ path: f.path, name: f.name }));
      return await handleResult(window.api.createRental(payload), "Aluguel registrado.");
    },
    editing ? "Salvar" : "Registrar"
  );

  const checkoutH = $("#rentalCheckout");
  const returnH = $("#rentalReturn");
  const checkoutV = $("#rentalCheckoutBR");
  const returnV = $("#rentalReturnBR");
  const agencySel = $("#rentalAgency");
  const itemsList = $("#rentalItemsList");
  const itemsHint = $("#itemsHint");
  const summaryEl = $("#rentalSummary");
  const attachListEl = $("#attachList");
  const excludeId = editing ? rental.id : null;

  initDateInputs($("#modalBody"));

  const materialById = new Map(data.materials.map((m) => [m.id, m]));
  const materialsSorted = [...data.materials].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  // Estado do periodo informado, para escolher a mensagem correta.
  const periodStatus = () => {
    const cIso = checkoutH.value;
    const rIso = returnH.value;
    const cText = (checkoutV?.value || "").trim();
    const rText = (returnV?.value || "").trim();
    const cOk = DateUtils.isValidISO(cIso);
    const rOk = DateUtils.isValidISO(rIso);
    if ((cText && !cOk) || (rText && !rOk)) return "invalid";
    if (!cOk || !rOk) return "incomplete";
    if (rIso < cIso) return "order";
    return "ok";
  };

  const availOf = (materialId) => (availMap ? Number(availMap[materialId] ?? 0) : null);

  // ------------------------- Itens (materiais) -------------------------

  const activeRows = () => itemRows.filter((row) => row.status !== "devolvido");

  const itemRowHtml = (row) => {
    if (row.status === "devolvido") {
      const m = materialById.get(row.material_id);
      return `<div class="rental-item-row returned" data-uid="${row.uid}">
        <span class="rental-item-locked">
          <span class="swatch" style="background:${escapeHtml(m?.color || DEFAULT_MATERIAL_COLOR)}"></span>
          ${escapeHtml(row.quantity)}x ${escapeHtml(m?.name || "(material removido)")}
        </span>
        <span class="badge badge-ok">Devolvido em ${fmtDate(row.actual_return_date)}</span>
      </div>`;
    }

    const ready = periodStatus() === "ok" && availMap && !loading;
    const usedByOthers = new Set(
      itemRows.filter((r2) => r2.uid !== row.uid && r2.material_id).map((r2) => r2.material_id)
    );
    const options = materialsSorted
      .map((m) => {
        const av = availOf(m.id);
        const isSelected = row.material_id === m.id;
        const duplicated = usedByOthers.has(m.id);
        const noStock = av !== null && av <= 0 && !isSelected;
        const disabled = duplicated || noStock ? " disabled" : "";
        let suffix = "";
        if (duplicated) suffix = " (ja adicionado)";
        else if (av !== null) suffix = ` — ${Math.max(0, av)} de ${Number(m.total_quantity) || 0} disp.`;
        return `<option value="${escapeHtml(m.id)}"${isSelected ? " selected" : ""}${disabled}>${escapeHtml(m.name)}${escapeHtml(suffix)}</option>`;
      })
      .join("");

    const av = row.material_id ? availOf(row.material_id) : null;
    const maxAttr = av !== null && av > 0 ? ` max="${av}"` : "";
    const removable = activeRows().length > 1;
    let rowHint = "";
    if (row.material_id && av !== null) {
      rowHint =
        av <= 0
          ? `<span class="rental-item-avail warn">Indisponivel no periodo</span>`
          : `<span class="rental-item-avail">Disponivel no periodo: <strong>${av}</strong></span>`;
    }

    return `<div class="rental-item-row" data-uid="${row.uid}">
      <select data-item-material aria-label="Material" ${ready ? "" : "disabled"}>
        <option value="">Selecione o material...</option>
        ${options}
      </select>
      <input data-item-qty type="number" min="1" step="1"${maxAttr} value="${escapeHtml(row.quantity)}" aria-label="Quantidade" ${ready ? "" : "disabled"} />
      <button type="button" class="icon-btn-light danger" data-item-remove title="Remover item" aria-label="Remover item" ${removable ? "" : "disabled"}>${TRASH_ICON_SVG}</button>
      ${rowHint}
    </div>`;
  };

  const renderItems = () => {
    itemsList.innerHTML = itemRows.map(itemRowHtml).join("");

    const status = periodStatus();
    itemsHint.className = "hint";
    if (status === "incomplete") {
      itemsHint.textContent = "Informe a retirada e a devolucao prevista para ver a disponibilidade dos materiais.";
    } else if (status === "invalid") {
      itemsHint.className = "hint warn";
      itemsHint.textContent = "Verifique as datas informadas (formato dd/mm/aaaa).";
    } else if (status === "order") {
      itemsHint.className = "hint warn";
      itemsHint.textContent = "A devolucao prevista nao pode ser anterior a retirada.";
    } else if (loading) {
      itemsHint.textContent = "Calculando disponibilidade no periodo...";
    } else {
      itemsHint.textContent = "A disponibilidade considera todos os alugueis ativos no periodo selecionado.";
    }
  };

  // Resumo dos itens antes da confirmacao.
  const renderSummary = () => {
    const parts = [];
    for (const row of itemRows) {
      if (!row.material_id) continue;
      const m = materialById.get(row.material_id);
      const returned = row.status === "devolvido" ? " (devolvido)" : "";
      parts.push(`<li>${escapeHtml(row.quantity)}x ${escapeHtml(m?.name || "(material removido)")}${returned}</li>`);
    }
    const period =
      DateUtils.isValidISO(checkoutH.value) && DateUtils.isValidISO(returnH.value)
        ? `Retirada em <strong>${fmtDate(checkoutH.value)}</strong>, devolucao prevista em <strong>${fmtDate(returnH.value)}</strong>.`
        : "";
    const agency = agencySel.selectedOptions[0]?.value
      ? `Agencia: <strong>${escapeHtml(agencySel.selectedOptions[0].textContent)}</strong>. `
      : "";
    summaryEl.innerHTML = parts.length
      ? `<ul class="rental-summary-list">${parts.join("")}</ul><div class="rental-summary-meta">${agency}${period}</div>`
      : `<span class="muted">Nenhum material selecionado ainda.</span>`;
  };

  const rerender = () => {
    renderItems();
    renderSummary();
  };

  // Delegacao de eventos da lista de itens (os elementos sao recriados a cada
  // render; o estado vive em itemRows).
  itemsList.addEventListener("change", (e) => {
    const rowEl = e.target.closest(".rental-item-row");
    if (!rowEl) return;
    const row = itemRows.find((r2) => String(r2.uid) === rowEl.dataset.uid);
    if (!row) return;
    if (e.target.matches("[data-item-material]")) {
      row.material_id = e.target.value;
      const av = availOf(row.material_id);
      if (av !== null && av > 0 && row.quantity > av) row.quantity = av;
      rerender();
    } else if (e.target.matches("[data-item-qty]")) {
      const n = Math.floor(Number(e.target.value));
      row.quantity = Number.isFinite(n) && n >= 1 ? n : 1;
      const av = row.material_id ? availOf(row.material_id) : null;
      if (av !== null && av > 0 && row.quantity > av) row.quantity = av;
      rerender();
    }
  });
  itemsList.addEventListener("input", (e) => {
    if (!e.target.matches("[data-item-qty]")) return;
    const rowEl = e.target.closest(".rental-item-row");
    const row = rowEl && itemRows.find((r2) => String(r2.uid) === rowEl.dataset.uid);
    if (!row) return;
    const n = Math.floor(Number(e.target.value));
    if (Number.isFinite(n) && n >= 1) {
      row.quantity = n;
      renderSummary();
    }
  });
  itemsList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-item-remove]");
    if (!btn || btn.disabled) return;
    const rowEl = btn.closest(".rental-item-row");
    const idx = itemRows.findIndex((r2) => String(r2.uid) === rowEl.dataset.uid);
    if (idx === -1) return;
    if (activeRows().length <= 1) return; // mantem pelo menos um item
    itemRows.splice(idx, 1);
    rerender();
  });

  $("#addItemBtn").addEventListener("click", () => {
    itemRows.push({ uid: ++rowSeq, id: "", material_id: "", quantity: 1, status: "alugado", actual_return_date: "" });
    rerender();
    const selects = itemsList.querySelectorAll("[data-item-material]");
    if (selects.length) selects[selects.length - 1].focus();
  });

  // ------------------------------ Anexos ------------------------------

  const renderAttachments = () => {
    const rowsHtml = [];
    for (const a of existingAtts) {
      const missing = a.missing
        ? `<span class="att-missing-badge" title="Arquivo nao encontrado na pasta de dados">arquivo ausente</span>`
        : "";
      rowsHtml.push(`<div class="attach-row" data-att-id="${escapeHtml(a.id)}">
        ${ATTACH_ICON_SVG}
        <span class="attach-name" title="${escapeHtml(a.file_name)}">${escapeHtml(a.file_name)}</span>
        <span class="attach-size">${fmtSize(a.size)}</span>
        ${missing}
        <button type="button" class="btn-link" data-att-open="${escapeHtml(a.id)}" ${a.missing ? "disabled" : ""}>Abrir</button>
        <button type="button" class="btn-link danger" data-att-remove="${escapeHtml(a.id)}">Remover</button>
      </div>`);
    }
    pendingFiles.forEach((f, i) => {
      rowsHtml.push(`<div class="attach-row pending">
        ${ATTACH_ICON_SVG}
        <span class="attach-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
        <span class="attach-size">${fmtSize(f.size)}</span>
        <span class="attach-pending-badge">sera copiado ao salvar</span>
        <button type="button" class="btn-link danger" data-att-pending-remove="${i}">Remover</button>
      </div>`);
    });
    attachListEl.innerHTML = rowsHtml.length
      ? rowsHtml.join("")
      : `<span class="muted">Nenhum anexo.</span>`;
  };

  $("#addAttachBtn").addEventListener("click", async () => {
    const res = await window.api.pickAttachments();
    if (!res || res.canceled || !res.ok) return;
    const valid = [];
    for (const f of res.files || []) {
      if (!f.valid) {
        toast(f.message || `Arquivo nao permitido: ${f.name}`, "warn");
        continue;
      }
      valid.push(f);
    }
    if (!valid.length) return;

    if (editing) {
      // Aluguel ja existe: copia imediatamente.
      const out = await window.api.addAttachments({
        rental_id: rental.id,
        files: valid.map((f) => ({ path: f.path, name: f.name })),
      });
      if (out && out.ok === false) {
        toast(out.message || "Falha ao adicionar anexos.", "error");
        return;
      }
      existingAtts = [...existingAtts, ...((out && out.attachments) || [])];
      renderAttachments();
      toast("Anexo(s) adicionado(s).", "success");
      loadAll();
    } else {
      for (const f of valid) {
        if (!pendingFiles.some((p) => p.path === f.path)) pendingFiles.push(f);
      }
      renderAttachments();
    }
  });

  attachListEl.addEventListener("click", async (e) => {
    const openId = e.target.closest("[data-att-open]")?.getAttribute("data-att-open");
    if (openId) {
      const res = await window.api.openAttachment(openId);
      if (res && res.ok === false) {
        toast(res.message || "Nao foi possivel abrir o anexo.", "error");
        if (res.code === "MISSING") {
          existingAtts = existingAtts.map((a) => (a.id === openId ? { ...a, missing: true } : a));
          renderAttachments();
        }
      }
      return;
    }

    const removeId = e.target.closest("[data-att-remove]")?.getAttribute("data-att-remove");
    if (removeId) {
      const att = existingAtts.find((a) => a.id === removeId);
      confirmDialog(
        `Remover o anexo "${att?.file_name}"? O arquivo sera excluido da pasta de dados.`,
        async () => {
          const res = await window.api.removeAttachment(removeId);
          if (res && res.ok === false) {
            toast(res.message || "Falha ao remover o anexo.", "error");
            return;
          }
          existingAtts = existingAtts.filter((a) => a.id !== removeId);
          renderAttachments();
          toast("Anexo removido.", "success");
          loadAll();
        },
        { title: "Remover anexo", okLabel: "Remover" }
      );
      return;
    }

    const pendingIdx = e.target.closest("[data-att-pending-remove]")?.getAttribute("data-att-pending-remove");
    if (pendingIdx !== undefined && pendingIdx !== null) {
      pendingFiles.splice(Number(pendingIdx), 1);
      renderAttachments();
    }
  });

  // --------------------------- Disponibilidade ---------------------------

  const refreshAvailability = async () => {
    if (periodStatus() !== "ok") {
      availMap = null;
      loading = false;
      rerender();
      return;
    }
    loading = true;
    rerender();
    try {
      const res = await window.api.getAvailability({
        checkout_date: checkoutH.value,
        expected_return_date: returnH.value,
        excludeId,
      });
      availMap = res && res.ok ? res.available || {} : {};
    } catch (_err) {
      availMap = {};
    }
    loading = false;
    // Reaplica os limites de quantidade com a nova disponibilidade.
    for (const row of activeRows()) {
      const av = row.material_id ? availOf(row.material_id) : null;
      if (av !== null && av > 0 && row.quantity > av) row.quantity = av;
    }
    rerender();
  };

  // Recalcula imediatamente quando qualquer uma das datas muda. Os eventos sao
  // disparados pelo input oculto (ISO) via initDateInputs.
  checkoutH.addEventListener("change", refreshAvailability);
  returnH.addEventListener("change", refreshAvailability);
  agencySel.addEventListener("change", renderSummary);

  renderAttachments();

  // Recalcula a disponibilidade inicial e, so entao, registra o estado "limpo"
  // do formulario (apos eventuais ajustes automaticos, como o limite de
  // quantidade), para que abrir uma edicao sem mexer em nada nao gere alerta.
  refreshAvailability().then(markModalPristine);
}

// ----------------------------- Devolucao (por item) -----------------------------

// Dialogo de devolucao: permite devolver todos os itens pendentes ou apenas
// parte deles, registrando a data de devolucao em cada item.
function openReturnForm(rental) {
  const activeItems = (rental.items || []).filter((it) => it.status === "alugado");
  if (!activeItems.length) return toast("Este aluguel ja foi totalmente devolvido.", "warn");

  const itemsHtml = activeItems
    .map(
      (it) => `<label class="return-item">
        <input type="checkbox" data-return-item value="${escapeHtml(it.id)}" checked />
        <span class="swatch" style="background:${escapeHtml(it.material_color || DEFAULT_MATERIAL_COLOR)}"></span>
        <span class="return-item-name">${escapeHtml(it.quantity)}x ${escapeHtml(it.material_name)}</span>
      </label>`
    )
    .join("");

  const eventInfo = rental.event_name ? ` — ${rental.event_name}` : "";
  const bodyHtml = `
    <p class="muted return-intro">${escapeHtml(agencyLabel(rental))}${escapeHtml(eventInfo)}</p>
    <div class="field full">
      <label>Itens a devolver</label>
      <div class="return-items">${itemsHtml}</div>
      <div class="hint">Desmarque os itens que ainda ficam com a agencia (devolucao parcial).</div>
    </div>
    <div class="field">
      ${brDateField({ label: "Data de devolucao *", name: "actual_return_date", baseId: "returnDate", iso: data.today, required: true })}
    </div>`;

  openModal(
    "Registrar devolucao",
    bodyHtml,
    async () => {
      const selected = $$("#modalBody [data-return-item]:checked").map((el) => el.value);
      if (!selected.length) {
        showModalError("Selecione pelo menos um item para devolver.");
        return { ok: false };
      }
      const dateIso = $("#returnDate").value;
      if (!DateUtils.isValidISO(dateIso)) {
        showModalError("Informe uma data de devolucao valida (dd/mm/aaaa).");
        return { ok: false };
      }
      return await handleResult(
        window.api.returnRental({ id: rental.id, item_ids: selected, actual_return_date: dateIso }),
        "Devolucao registrada."
      );
    },
    "Devolver"
  );
  initDateInputs($("#modalBody"));
}

// ----------------------------- Calendario -----------------------------

const MONTHS_PT = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];
const WEEKDAYS_PT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

const pad2 = (n) => String(n).padStart(2, "0");
const toISO = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
// Inicio da semana no domingo.
function startOfWeek(d) {
  const x = new Date(d);
  x.setDate(x.getDate() - x.getDay());
  x.setHours(0, 0, 0, 0);
  return x;
}

// Itens de aluguel que ocupam um determinado dia (entre retirada e devolucao).
// Trabalha sobre as entradas planas (uma por item/material) do snapshot.
// Comparacao lexicografica de strings YYYY-MM-DD funciona como ordem cronologica.
function rentalsOnDay(iso) {
  return (data.rentalEntries || []).filter((r) => {
    const start = r.checkout_date;
    if (!start) return false;
    const end =
      r.status === "devolvido" && r.actual_return_date
        ? r.actual_return_date
        : r.expected_return_date || start;
    return start <= iso && iso <= end;
  });
}

function chipClass(r) {
  if (r.status === "devolvido") return "returned";
  if (r.overdue) return "overdue";
  return "active";
}

// Cor personalizada do material (ou a cor padrao quando nao definida).
function materialColorOf(materialId) {
  const m = data.materials.find((x) => x.id === materialId);
  return (m && m.color) || DEFAULT_MATERIAL_COLOR;
}

// Converte "#rrggbb" em "rgba(r,g,b,alpha)" para fundos translucidos.
function hexToRgba(hex, alpha) {
  const v = /^#([0-9a-fA-F]{6})$/.exec(String(hex || ""));
  if (!v) return `rgba(65, 168, 18, ${alpha})`;
  const int = parseInt(v[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function renderCalendar() {
  const cont = $("#calendar");
  if (!cont) return;
  const todayIso = data.today || toISO(new Date());

  let days = [];
  if (calMode === "month") {
    const y = calRef.getFullYear();
    const m = calRef.getMonth();
    $("#calTitle").textContent = `${MONTHS_PT[m]} ${y}`;
    const gridStart = startOfWeek(new Date(y, m, 1));
    for (let i = 0; i < 42; i++) days.push(addDays(gridStart, i));
  } else {
    const ws = startOfWeek(calRef);
    const we = addDays(ws, 6);
    $("#calTitle").textContent =
      `${ws.getDate()} ${MONTHS_PT[ws.getMonth()].slice(0, 3)} - ` +
      `${we.getDate()} ${MONTHS_PT[we.getMonth()].slice(0, 3)} ${we.getFullYear()}`;
    for (let i = 0; i < 7; i++) days.push(addDays(ws, i));
  }

  const curMonth = calRef.getMonth();
  const maxChips = calMode === "month" ? 3 : 20;

  const weekdays = `<div class="cal-weekdays">${WEEKDAYS_PT.map(
    (w) => `<div class="cal-weekday">${w}</div>`
  ).join("")}</div>`;

  const cells = days
    .map((d) => {
      const iso = toISO(d);
      const evs = rentalsOnDay(iso);
      const isOther = calMode === "month" && d.getMonth() !== curMonth;
      const isToday = iso === todayIso;

      const chips = evs
        .slice(0, maxChips)
        .map((r) => {
          const codeStr = String(r.agency_code || "").trim();
          const eventStr = String(r.event_name || "").trim();
          const tip = `${codeStr ? `[${codeStr}] ` : ""}${r.agency_name}${eventStr ? ` - ${eventStr}` : ""} - ${r.material_name} (${fmtDate(
            r.checkout_date
          )} ate ${fmtDate(r.expected_return_date)})`;
          const color = materialColorOf(r.material_id);
          const style = `border-left-color:${color};background:${hexToRgba(color, 0.16)}`;
          const flag = r.overdue
            ? '<span class="cal-chip-flag overdue" title="Atrasado">!</span>'
            : "";
          const codeBadge = codeStr ? `<span class="cal-chip-code">${escapeHtml(codeStr)}</span>` : "";
          // Prioridade: codigo da agencia, material e quantidade.
          return `<div class="cal-chip ${chipClass(r)}" style="${style}" title="${escapeHtml(tip)}">${flag}${codeBadge}${escapeHtml(
            r.material_name
          )} ${escapeHtml(r.quantity)}x</div>`;
        })
        .join("");
      const more = evs.length > maxChips ? `<div class="cal-more">+${evs.length - maxChips} mais</div>` : "";

      return `<div class="cal-cell ${isOther ? "other-month" : ""} ${isToday ? "today" : ""}" data-day="${iso}" role="button" tabindex="0">
        <span class="cal-daynum">${d.getDate()}</span>
        <div class="cal-events">${chips}${more}</div>
      </div>`;
    })
    .join("");

  cont.innerHTML = weekdays + `<div class="cal-grid ${calMode === "week" ? "week" : ""}">${cells}</div>`;
}

function shiftCalendar(dir) {
  if (calMode === "month") {
    calRef = new Date(calRef.getFullYear(), calRef.getMonth() + dir, 1);
  } else {
    calRef = addDays(calRef, dir * 7);
  }
  renderCalendar();
}

function setCalMode(mode) {
  calMode = mode;
  $("#calModeMonth").classList.toggle("active", mode === "month");
  $("#calModeWeek").classList.toggle("active", mode === "week");
  renderCalendar();
}

// Badge de situacao reutilizado na tabela e no pop-up do dia.
function statusBadge(r) {
  if (r.status === "devolvido") return '<span class="badge badge-ok">Devolvido</span>';
  if (r.overdue) return '<span class="badge badge-overdue">Atrasado</span>';
  return '<span class="badge badge-rented">Alugado</span>';
}

function closeDayModal() {
  $("#dayModal").classList.add("hidden");
}

// Pop-up somente leitura com os alugueis ativos em um dia especifico.
function openDayModal(iso) {
  const evs = rentalsOnDay(iso);
  $("#dayModalTitle").textContent = `Materiais em ${fmtDate(iso)}`;

  let bodyHtml;
  if (!evs.length) {
    bodyHtml = `<p class="day-empty">Nenhum material alugado ou reservado neste dia.</p>`;
  } else {
    bodyHtml = `<ul class="day-list">` +
      evs
        .slice()
        .sort((a, b) => a.material_name.localeCompare(b.material_name, "pt-BR"))
        .map((r) => {
          const color = materialColorOf(r.material_id);
          return `<li class="day-item">
            <span class="day-swatch" style="background:${escapeHtml(color)}"></span>
            <div class="day-info">
              <div class="day-title">
                <strong>${escapeHtml(r.material_name)}</strong>
                <span class="day-qty">${escapeHtml(r.quantity)}x</span>
                ${statusBadge(r)}
              </div>
              <div class="day-meta">${escapeHtml(agencyLabel(r))}${r.event_name ? ` &middot; ${escapeHtml(r.event_name)}` : ""}</div>
              <div class="day-dates">
                <span>Retirada: <strong>${fmtDate(r.checkout_date)}</strong></span>
                <span>Devolucao prevista: <strong>${fmtDate(r.expected_return_date)}</strong></span>
              </div>
            </div>
          </li>`;
        })
        .join("") +
      `</ul>`;
  }

  $("#dayModalBody").innerHTML = bodyHtml;
  $("#dayModal").classList.remove("hidden");
}

// ----------------------------- Configuracoes -----------------------------

async function loadSettings() {
  const s = await window.api.getSettings();
  $("#dataDirInput").value = s.dataDir;
  $("#userIdValue").textContent = s.userId;
  renderFilesReport(null, s.paths);
}

function renderFilesReport(report, paths) {
  const container = $("#filesReport");
  const labels = {
    materials: "Materiais",
    agencies: "Agencias",
    rentals: "Alugueis",
    rentalItems: "Itens de aluguel",
    attachments: "Anexos (metadados)",
    stockProducts: "Produtos (estoque)",
    stockMovements: "Movimentacoes de estoque",
  };
  const keys = Object.keys(paths || (report || {}));
  container.innerHTML = keys
    .map((k) => {
      const info = report ? report[k] : null;
      const p = report ? report[k].path : paths[k];
      let status = '<span class="file-status">nao verificado</span>';
      if (info) {
        status = info.readable
          ? `<span class="file-status ok">${info.created ? "criado" : "ok"}</span>`
          : '<span class="file-status bad">sem acesso</span>';
      }
      return `<div class="file-row"><strong>${labels[k] || k}</strong><span class="mono">${escapeHtml(p)}</span>${status}</div>`;
    })
    .join("");
}

async function validateFiles() {
  try {
    const report = await window.api.validateFiles();
    renderFilesReport(report);
    const allOk = Object.values(report).every((r) => r.readable);
    toast(allOk ? "Arquivos validados com sucesso." : "Alguns arquivos estao sem acesso.", allOk ? "success" : "error");
    await loadAll();
  } catch (err) {
    toast("Erro ao validar: " + (err?.message || err), "error");
  }
}

async function chooseDir() {
  const res = await window.api.chooseDir();
  if (res && res.canceled) return;
  if (res && res.ok) {
    $("#dataDirInput").value = res.dataDir;
    toast("Pasta de dados atualizada.", "success");
    await loadSettings();
    await loadAll();
  }
}

async function importStockCsv(kind) {
  const res = await window.api.importStockCsv(kind);
  if (res && res.canceled) return;
  if (res && res.ok === false) {
    toast(res.message || "Importacao nao concluida.", "error");
    return;
  }
  toast(res.message || "CSV importado com sucesso.", "success");
  await loadSettings();
  await loadAll();
}

async function downloadStockTemplate(kind) {
  const res = await window.api.downloadStockTemplate(kind);
  if (res && res.canceled) return;
  if (res && res.ok === false) {
    toast(res.message || "Nao foi possivel salvar o template.", "error");
    return;
  }
  toast("Template CSV salvo.", "success");
}

function clearStockDashboardFilters() {
  $("#stockDashSearch").value = "";
  $("#stockDashCategoryFilter").value = "";
  $("#stockDashSupplierFilter").value = "";
  renderStockDashboard();
}

function clearStockProductFilters() {
  $("#stockProductSearch").value = "";
  $("#stockProductCategoryFilter").value = "";
  $("#stockProductSupplierFilter").value = "";
  $("#stockProductStatusFilter").value = "";
  $("#stockProductSort").value = "needed";
  tableSort.stockProducts = { key: "needed", dir: "desc" };
  renderStockProducts();
}

function clearStockMovementFilters() {
  $("#stockMovementSearch").value = "";
  $("#stockMovementProductFilter").value = "";
  $("#stockMovementCategoryFilter").value = "";
  $("#stockMovementTypeFilter").value = "";
  setBRDateField("stockMovementFrom", "");
  setBRDateField("stockMovementTo", "");
  renderStockMovements();
}

// ----------------------------- Navegacao -----------------------------

function switchView(view) {
  currentView = view;
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $("#settingsBtn").classList.toggle("active", view === "settings");
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  if (view === "settings") loadSettings();
  if (view === "calendar") renderCalendar();
  if (view === "stock-dashboard") renderStockDashboard();
  if (view === "stock-products") renderStockProducts();
  if (view === "stock-movements") renderStockMovements();
}

// ----------------------------- Eventos -----------------------------

function bindEvents() {
  $$(".nav-item").forEach((btn) => btn.addEventListener("click", () => switchView(btn.dataset.view)));
  $("#refreshBtn").addEventListener("click", loadAll);
  $("#settingsBtn").addEventListener("click", () => switchView("settings"));

  // Filtros do painel analitico (recalcula todo o painel ao mudar).
  [
    "#fltPreset",
    "#fltFrom",
    "#fltTo",
    "#fltAgency",
    "#fltMaterial",
    "#fltStatus",
  ].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener("change", renderDashboard);
  });
  $("#fltReset")?.addEventListener("click", resetDashFilters);
  $("#insightsGrid")?.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-insight]");
    if (btn) handleInsightAction(btn.getAttribute("data-insight"));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const detail = e.target instanceof HTMLElement ? e.target.closest("[data-detail]") : null;
    if (!detail) return;
    e.preventDefault();
    openDetail(detail.getAttribute("data-detail"));
  });

  // Modal
  $("#modalForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!modalSubmitHandler) return;
    $("#modalSubmit").disabled = true;
    try {
      const res = await modalSubmitHandler();
      if (!res || res.ok !== false) closeModal();
      else if (res.message) showModalError(res.message);
    } finally {
      $("#modalSubmit").disabled = false;
    }
  });
  // Todas as formas de fechar o formulario passam por requestCloseModal, que
  // pede confirmacao quando ha alteracoes nao salvas.
  $("#modalClose").addEventListener("click", requestCloseModal);
  $("#modalCancel").addEventListener("click", requestCloseModal);
  $("#modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") requestCloseModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // Se o dialogo de confirmacao estiver aberto, Esc equivale a acao segura
    // (Cancelar / Continuar editando), evitando dialogos ou fechamentos duplos.
    if (!$("#confirm").classList.contains("hidden")) {
      $("#confirmCancel").click();
      return;
    }
    if (!$("#modal").classList.contains("hidden")) {
      requestCloseModal();
      return;
    }
    if (!$("#dayModal").classList.contains("hidden")) closeDayModal();
  });

  // Botoes "novo"
  $("#addMaterialBtn").addEventListener("click", () => openMaterialForm(null));
  $("#addStockProductBtn").addEventListener("click", () => openStockProductForm(null));
  $("#addStockMovementBtn").addEventListener("click", () => openStockMovementForm(null));
  $("#addAgencyBtn").addEventListener("click", () => openAgencyForm(null));
  $("#addRentalBtn").addEventListener("click", () => openRentalForm());

  // Busca / filtros
  $("#materialSearch").addEventListener("input", renderMaterials);
  ["#stockDashSearch"].forEach((sel) => $(sel).addEventListener("input", renderStockDashboard));
  ["#stockDashCategoryFilter", "#stockDashSupplierFilter"].forEach((sel) => $(sel).addEventListener("change", renderStockDashboard));
  $("#stockDashClearFilters").addEventListener("click", clearStockDashboardFilters);
  $("#stockProductSearch").addEventListener("input", renderStockProducts);
  [
    "#stockProductCategoryFilter",
    "#stockProductSupplierFilter",
    "#stockProductStatusFilter",
  ].forEach((sel) => $(sel).addEventListener("change", renderStockProducts));
  $("#stockProductSort").addEventListener("change", applyStockProductSortSelect);
  $("#stockProductClearFilters").addEventListener("click", clearStockProductFilters);
  $("#downloadStockProductsReportBtn").addEventListener("click", exportStockProductsReport);
  ["#stockMovementSearch", "#stockMovementFrom", "#stockMovementTo"].forEach((sel) => $(sel).addEventListener("input", renderStockMovements));
  ["#stockMovementProductFilter", "#stockMovementCategoryFilter", "#stockMovementTypeFilter"].forEach((sel) =>
    $(sel).addEventListener("change", renderStockMovements)
  );
  $("#stockMovementClearFilters").addEventListener("click", clearStockMovementFilters);
  $("#downloadStockMovementsReportBtn").addEventListener("click", exportStockMovementsReport);
  $("#agencySearch").addEventListener("input", renderAgencies);
  [
    "#rentalSearch",
    "#rentalAgencyCodeFilter",
    "#rentalCheckoutFrom",
    "#rentalCheckoutTo",
    "#rentalReturnFrom",
    "#rentalReturnTo",
  ].forEach((sel) => $(sel).addEventListener("input", renderRentals));
  [
    "#rentalAgencyFilter",
    "#rentalMaterialFilter",
    "#rentalStatusFilter",
    "#rentalOverdueOnly",
  ].forEach((sel) => $(sel).addEventListener("change", renderRentals));
  $("#rentalClearFilters").addEventListener("click", clearRentalFilters);

  // Calendario
  $("#calPrev").addEventListener("click", () => shiftCalendar(-1));
  $("#calNext").addEventListener("click", () => shiftCalendar(1));
  $("#calToday").addEventListener("click", () => {
    calRef = new Date();
    renderCalendar();
  });
  $("#calModeMonth").addEventListener("click", () => setCalMode("month"));
  $("#calModeWeek").addEventListener("click", () => setCalMode("week"));

  // Clique em um dia abre o pop-up de detalhes (clicar num chip tambem).
  $("#calendar").addEventListener("click", (e) => {
    const cell = e.target.closest(".cal-cell");
    if (cell && cell.dataset.day) openDayModal(cell.dataset.day);
  });
  $("#calendar").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const cell = e.target.closest(".cal-cell");
    if (cell && cell.dataset.day) {
      e.preventDefault();
      openDayModal(cell.dataset.day);
    }
  });
  $("#dayModalClose").addEventListener("click", closeDayModal);
  $("#dayModal").addEventListener("click", (e) => {
    if (e.target.id === "dayModal") closeDayModal();
  });

  // Configuracoes
  $("#chooseDirBtn").addEventListener("click", chooseDir);
  $("#validateFilesBtn").addEventListener("click", validateFiles);
  $("#importProductsBtn").addEventListener("click", () => importStockCsv("products"));
  $("#importMovementsBtn").addEventListener("click", () => importStockCsv("movements"));
  $("#templateProductsBtn").addEventListener("click", () => downloadStockTemplate("products"));
  $("#templateMovementsBtn").addEventListener("click", () => downloadStockTemplate("movements"));

  // Delegacao de cliques nas tabelas (editar / excluir / devolver)
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;

    const detail = t.closest("[data-detail]");
    if (detail) {
      openDetail(detail.getAttribute("data-detail"));
      return;
    }

    const sortHeader = t.closest("th[data-sort-table][data-sort-key]");
    if (sortHeader) {
      setTableSort(sortHeader.dataset.sortTable, sortHeader.dataset.sortKey, sortHeader.dataset.sortDefault || "asc");
      const renderByTable = {
        materials: renderMaterials,
        agencies: renderAgencies,
        rentals: renderRentals,
        stockPurchase: renderPurchaseAlerts,
        stockProducts: renderStockProducts,
        stockMovements: renderStockMovements,
      };
      renderByTable[sortHeader.dataset.sortTable]?.();
      renderSortIndicators();
      return;
    }

    const navTarget = t.getAttribute("data-nav-target");
    if (navTarget) {
      const productFilter = t.getAttribute("data-product-filter");
      switchView(navTarget);
      if (navTarget === "stock-movements" && productFilter) {
        $("#stockMovementProductFilter").value = productFilter;
        renderStockMovements();
      }
      return;
    }

    const editMat = t.getAttribute("data-edit-material");
    if (editMat) return openMaterialForm(data.materials.find((m) => m.id === editMat));

    const delMat = t.getAttribute("data-del-material");
    if (delMat) {
      const m = data.materials.find((x) => x.id === delMat);
      return confirmDialog(`Excluir o material "${m?.name}"? Esta acao nao pode ser desfeita.`, () =>
        handleResult(window.api.deleteMaterial(delMat), "Material excluido.")
      );
    }

    const editStockProduct = t.getAttribute("data-edit-stock-product");
    if (editStockProduct) return openStockProductForm(data.stockProducts.find((p) => p.id === editStockProduct));

    const delStockProduct = t.getAttribute("data-del-stock-product");
    if (delStockProduct) {
      const p = data.stockProducts.find((x) => x.id === delStockProduct);
      return confirmDialog(`Excluir o produto "${p?.name}"?`, () =>
        handleResult(window.api.deleteStockProduct(delStockProduct), "Produto excluido.")
      );
    }

    const editStockMovement = t.getAttribute("data-edit-stock-movement");
    if (editStockMovement) return openStockMovementForm(data.stockMovements.find((m) => m.id === editStockMovement));

    const delStockMovement = t.getAttribute("data-del-stock-movement");
    if (delStockMovement) {
      return confirmDialog("Excluir esta movimentacao de estoque?", () =>
        handleResult(window.api.deleteStockMovement(delStockMovement), "Movimentacao excluida.")
      );
    }

    const editAg = t.getAttribute("data-edit-agency");
    if (editAg) return openAgencyForm(data.agencies.find((a) => a.id === editAg));

    const delAg = t.getAttribute("data-del-agency");
    if (delAg) {
      const a = data.agencies.find((x) => x.id === delAg);
      return confirmDialog(`Excluir a agencia "${a?.name}"?`, () =>
        handleResult(window.api.deleteAgency(delAg), "Agencia excluida.")
      );
    }

    const editRent = t.getAttribute("data-edit-rental");
    if (editRent) return openRentalForm(data.rentals.find((r) => r.id === editRent));

    const retRent = t.getAttribute("data-return-rental");
    if (retRent) {
      const r = data.rentals.find((x) => x.id === retRent);
      if (r) openReturnForm(r);
      return;
    }

    const delRent = t.getAttribute("data-del-rental");
    if (delRent) {
      const r = data.rentals.find((x) => x.id === delRent);
      const hasAtts = (r?.attachments || []).length > 0;
      return confirmDialog(
        `Excluir este registro de aluguel do historico?${hasAtts ? " Os anexos tambem serao excluidos." : ""}`,
        () => handleResult(window.api.deleteRental(delRent), "Registro excluido.")
      );
    }
  });

  // Auto-refresh quando os arquivos mudam (outro usuario / sincronizacao).
  window.api.onDataChanged(() => {
    loadAll();
    if (currentView !== "settings") toast("Dados atualizados.", "info");
  });
}

// ----------------------------- Inicio -----------------------------

bindEvents();
initDateInputs(document); // filtros (datas) usam entrada DD/MM/YYYY
loadAll();
