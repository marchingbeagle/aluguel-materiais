"use strict";

// Estado em memoria com o ultimo snapshot carregado do processo principal.
let data = { materials: [], agencies: [], rentals: [], stats: {}, today: "" };
let currentView = "dashboard";

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

function fmtDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "-";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
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

function openModal(title, bodyHtml, onSubmit, submitLabel = "Salvar") {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = bodyHtml;
  $("#modalSubmit").textContent = submitLabel;
  $("#modalError").classList.add("hidden");
  modalSubmitHandler = onSubmit;
  $("#modal").classList.remove("hidden");
  const first = $("#modalBody input, #modalBody select, #modalBody textarea");
  if (first) first.focus();
}

function closeModal() {
  $("#modal").classList.add("hidden");
  modalSubmitHandler = null;
}

function showModalError(msg) {
  const el = $("#modalError");
  el.textContent = msg;
  el.classList.remove("hidden");
}

function confirmDialog(message, onOk, { title = "Confirmar exclusao", okLabel = "Excluir" } = {}) {
  $("#confirmTitle").textContent = title;
  $("#confirmMessage").textContent = message;
  $("#confirmOk").textContent = okLabel;
  $("#confirm").classList.remove("hidden");
  const ok = $("#confirmOk");
  const cancel = $("#confirmCancel");
  const close = () => {
    $("#confirm").classList.add("hidden");
    ok.removeEventListener("click", okFn);
    cancel.removeEventListener("click", close);
  };
  const okFn = async () => {
    close();
    await onOk();
  };
  ok.addEventListener("click", okFn);
  cancel.addEventListener("click", close);
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
  renderAgencies();
  renderRentals();
  renderCalendar();
}

// ----------------------------- Painel -----------------------------

function renderDashboard() {
  const s = data.stats || {};
  $("#stat-materials").textContent = s.totalMaterials ?? 0;
  $("#stat-available").textContent = s.availableUnits ?? 0;
  $("#stat-rented").textContent = s.rentedUnits ?? 0;
  $("#stat-overdue").textContent = s.overdueCount ?? 0;

  const active = data.rentals.filter((r) => r.status === "alugado");
  const tbody = $("#dashboard-active tbody");
  if (!active.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Nenhum aluguel ativo.</td></tr>`;
    return;
  }
  tbody.innerHTML = active
    .sort((a, b) => (a.expected_return_date || "").localeCompare(b.expected_return_date || ""))
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

  renderTopAgencies();
}

// Data ISO de inicio (inclusiva) para o periodo escolhido no ranking.
// Retorna "" quando o periodo for "todos" (sem limite inferior).
function periodStartISO(period) {
  const now = new Date();
  if (period === "month") {
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-01`;
  }
  if (period === "year") {
    return `${now.getFullYear()}-01-01`;
  }
  if (period === "last30") {
    const d = new Date(now);
    d.setDate(d.getDate() - 29); // inclui hoje + 29 dias anteriores = 30 dias
    return toISO(d);
  }
  return "";
}

// Ranking de agencias com mais reservas (alugueis), filtrado por periodo da
// data de retirada. Agrupa por agencia, conta reservas e soma a quantidade.
// Agencias removidas sao tratadas com seguranca (nome de fallback e codigo "-").
function renderTopAgencies() {
  const tbody = $("#top-agencies tbody");
  if (!tbody) return;

  const period = $("#topAgenciesPeriod")?.value || "month";
  const fromIso = periodStartISO(period);

  const groups = new Map();
  for (const r of data.rentals) {
    const checkout = r.checkout_date || "";
    // Comparacao lexicografica de YYYY-MM-DD (ordem cronologica).
    if (fromIso && (!checkout || checkout < fromIso)) continue;

    const key = r.agency_id || `__sem_agencia__${r.agency_name}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        code: String(r.agency_code || "").trim(),
        name: r.agency_name || "(agencia removida)",
        bookings: 0,
        quantity: 0,
      };
      groups.set(key, g);
    }
    g.bookings += 1;
    g.quantity += Number(r.quantity) || 0;
  }

  const rows = Array.from(groups.values()).sort(
    (a, b) =>
      b.bookings - a.bookings ||
      b.quantity - a.quantity ||
      a.name.localeCompare(b.name, "pt-BR")
  );

  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="4">Nenhuma reserva no periodo selecionado.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map(
      (g) => `<tr>
        <td>${escapeHtml(g.code) || "-"}</td>
        <td>${escapeHtml(g.name)}</td>
        <td>${escapeHtml(g.bookings)}</td>
        <td>${escapeHtml(g.quantity)}</td>
      </tr>`
    )
    .join("");
}

// ----------------------------- Materiais -----------------------------

function renderMaterials() {
  const term = $("#materialSearch").value.trim().toLowerCase();

  const rows = data.materials.filter((m) => {
    return !term ||
      m.name.toLowerCase().includes(term) ||
      (m.description || "").toLowerCase().includes(term);
  });

  const tbody = $("#materials-table tbody");
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Nenhum material encontrado.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .map((m) => {
      const availBadge = m.available <= 0
        ? `<span class="badge badge-zero">${m.available}</span>`
        : `<span class="badge badge-ok">${m.available}</span>`;
      const swatchColor = m.color || DEFAULT_MATERIAL_COLOR;
      return `<tr>
        <td><span class="swatch" style="background:${escapeHtml(swatchColor)}" title="${escapeHtml(m.color ? swatchColor : "Cor padrao")}"></span>${escapeHtml(m.name)}</td>
        <td>${escapeHtml(m.total_quantity)}</td>
        <td>${escapeHtml(m.rented)}</td>
        <td>${availBadge}</td>
        <td>${escapeHtml(m.notes) || "-"}</td>
        <td class="col-actions">
          <button class="btn-link" data-edit-material="${m.id}">Editar</button>
          <button class="btn-link danger" data-del-material="${m.id}">Excluir</button>
        </td>
      </tr>`;
    })
    .join("");
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

function renderRentals() {
  const term = $("#rentalSearch").value.trim().toLowerCase();
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

  const rows = data.rentals.filter((r) => {
    const matchTerm = !term ||
      r.material_name.toLowerCase().includes(term) ||
      r.agency_name.toLowerCase().includes(term) ||
      String(r.agency_code || "").toLowerCase().includes(term);
    if (!matchTerm) return false;

    if (agencyId && r.agency_id !== agencyId) return false;
    if (agencyCode && !String(r.agency_code || "").toLowerCase().includes(agencyCode)) return false;
    if (materialId && r.material_id !== materialId) return false;

    if (status === "overdue") { if (!r.overdue) return false; }
    else if (status) { if (r.status !== status) return false; }

    if (overdueOnly && !r.overdue) return false;

    // Faixas de data (comparacao lexicografica de YYYY-MM-DD).
    if (checkoutFrom && (!r.checkout_date || r.checkout_date < checkoutFrom)) return false;
    if (checkoutTo && (!r.checkout_date || r.checkout_date > checkoutTo)) return false;
    if (returnFrom && (!r.expected_return_date || r.expected_return_date < returnFrom)) return false;
    if (returnTo && (!r.expected_return_date || r.expected_return_date > returnTo)) return false;

    return true;
  });

  const tbody = $("#rentals-table tbody");
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="9">Nenhum aluguel encontrado.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .sort((a, b) => (b.checkout_date || "").localeCompare(a.checkout_date || ""))
    .map((r) => {
      let badge;
      if (r.status === "devolvido") badge = '<span class="badge badge-ok">Devolvido</span>';
      else if (r.overdue) badge = '<span class="badge badge-overdue">Atrasado</span>';
      else badge = '<span class="badge badge-rented">Alugado</span>';

      const actions = r.status === "alugado"
        ? `<button class="btn-link" data-edit-rental="${r.id}">Editar</button>
           <button class="btn-link" data-return-rental="${r.id}">Devolver</button>
           <button class="btn-link danger" data-del-rental="${r.id}">Excluir</button>`
        : `<button class="btn-link" data-edit-rental="${r.id}">Editar</button>
           <button class="btn-link danger" data-del-rental="${r.id}">Excluir</button>`;

      return `<tr>
        <td>${escapeHtml(r.agency_code) || "-"}</td>
        <td>${escapeHtml(r.material_name)}</td>
        <td>${escapeHtml(r.agency_name)}</td>
        <td>${escapeHtml(r.quantity)}</td>
        <td>${fmtDate(r.checkout_date)}</td>
        <td>${fmtDate(r.expected_return_date)}</td>
        <td>${fmtDate(r.actual_return_date)}</td>
        <td>${badge}</td>
        <td class="col-actions">${actions}</td>
      </tr>`;
    })
    .join("");
}

function clearRentalFilters() {
  $("#rentalSearch").value = "";
  $("#rentalAgencyFilter").value = "";
  $("#rentalAgencyCodeFilter").value = "";
  $("#rentalMaterialFilter").value = "";
  $("#rentalStatusFilter").value = "";
  $("#rentalCheckoutFrom").value = "";
  $("#rentalCheckoutTo").value = "";
  $("#rentalReturnFrom").value = "";
  $("#rentalReturnTo").value = "";
  $("#rentalOverdueOnly").checked = false;
  renderRentals();
}

function rentalFormHtml(r = {}) {
  const isReturned = r.status === "devolvido";
  const materialOptions = data.materials
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .map((m) => {
      const sel = m.id === r.material_id ? " selected" : "";
      return `<option value="${m.id}" data-available="${m.available}"${sel}>${escapeHtml(m.name)} (disp.: ${m.available})</option>`;
    })
    .join("");
  const agencyOptions = data.agencies
    .map((a) => {
      const sel = a.id === r.agency_id ? " selected" : "";
      const label = a.code ? `[${a.code}] ${a.name}` : a.name;
      return `<option value="${a.id}"${sel}>${escapeHtml(label)}</option>`;
    })
    .join("");

  const returnedField = isReturned
    ? `<div class="field full">
        <label>Data de devolucao</label>
        <input name="actual_return_date" type="date" value="${escapeHtml(r.actual_return_date)}" />
      </div>`
    : "";

  return `
    <div class="form-grid">
      <div class="field full">
        <label>Material *</label>
        <select name="material_id" id="rentalMaterial" required>
          <option value="">Selecione...</option>
          ${materialOptions}
        </select>
        <div class="hint" id="availHint"></div>
      </div>
      <div class="field full">
        <label>Agencia *</label>
        <select name="agency_id" required>
          <option value="">Selecione...</option>
          ${agencyOptions}
        </select>
      </div>
      <div class="field">
        <label>Quantidade *</label>
        <input name="quantity" id="rentalQty" type="number" min="1" step="1" value="${escapeHtml(r.quantity ?? 1)}" required />
      </div>
      <div class="field">
        <label>Data de retirada *</label>
        <input name="checkout_date" type="date" value="${escapeHtml(r.checkout_date || data.today)}" required />
      </div>
      <div class="field full">
        <label>Devolucao prevista *</label>
        <input name="expected_return_date" type="date" value="${escapeHtml(r.expected_return_date || data.today)}" required />
      </div>
      ${returnedField}
      <div class="field full">
        <label>Observacoes</label>
        <textarea name="notes">${escapeHtml(r.notes)}</textarea>
      </div>
    </div>`;
}

function openRentalForm(rental) {
  if (!data.materials.length) return toast("Cadastre um material antes.", "warn");
  if (!data.agencies.length) return toast("Cadastre uma agencia antes.", "warn");

  const editing = !!rental;
  openModal(
    editing ? "Editar aluguel" : "Novo aluguel",
    rentalFormHtml(rental || {}),
    async () => {
      const v = formValues();
      if (editing) {
        v.id = rental.id;
        v._baseline = rental;
        return await handleResult(window.api.updateRental(v), "Aluguel atualizado.");
      }
      return await handleResult(window.api.createRental(v), "Aluguel registrado.");
    },
    editing ? "Salvar" : "Registrar"
  );

  // Atualiza dica de disponibilidade e limite de quantidade ao escolher material.
  const matSel = $("#rentalMaterial");
  const qty = $("#rentalQty");
  const hint = $("#availHint");
  const updateHint = () => {
    const opt = matSel.selectedOptions[0];
    const avail = opt ? Number(opt.dataset.available || 0) : 0;
    if (matSel.value) {
      hint.innerHTML = `Disponivel: <strong>${avail}</strong>`;
    } else {
      hint.textContent = "";
    }
  };
  matSel.addEventListener("change", updateHint);
  if (editing) updateHint();
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

// Alugueis que ocupam um determinado dia (entre retirada e devolucao).
// Comparacao lexicografica de strings YYYY-MM-DD funciona como ordem cronologica.
function rentalsOnDay(iso) {
  return data.rentals.filter((r) => {
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
          const tip = `${codeStr ? `[${codeStr}] ` : ""}${r.agency_name} - ${r.material_name} (${fmtDate(
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
              <div class="day-meta">${escapeHtml(agencyLabel(r))}</div>
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
  const labels = { materials: "Materiais", agencies: "Agencias", rentals: "Alugueis" };
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

// ----------------------------- Navegacao -----------------------------

function switchView(view) {
  currentView = view;
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $("#settingsBtn").classList.toggle("active", view === "settings");
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  if (view === "settings") loadSettings();
  if (view === "calendar") renderCalendar();
}

// ----------------------------- Eventos -----------------------------

function bindEvents() {
  $$(".nav-item").forEach((btn) => btn.addEventListener("click", () => switchView(btn.dataset.view)));
  $("#refreshBtn").addEventListener("click", loadAll);
  $("#settingsBtn").addEventListener("click", () => switchView("settings"));

  // Ranking de agencias no painel (recalcula ao trocar o periodo).
  $("#topAgenciesPeriod").addEventListener("change", renderTopAgencies);

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
  $("#modalClose").addEventListener("click", closeModal);
  $("#modalCancel").addEventListener("click", closeModal);
  $("#modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#modal").classList.contains("hidden")) closeModal();
    if (!$("#dayModal").classList.contains("hidden")) closeDayModal();
  });

  // Botoes "novo"
  $("#addMaterialBtn").addEventListener("click", () => openMaterialForm(null));
  $("#addAgencyBtn").addEventListener("click", () => openAgencyForm(null));
  $("#addRentalBtn").addEventListener("click", () => openRentalForm());

  // Busca / filtros
  $("#materialSearch").addEventListener("input", renderMaterials);
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

  // Delegacao de cliques nas tabelas (editar / excluir / devolver)
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;

    const editMat = t.getAttribute("data-edit-material");
    if (editMat) return openMaterialForm(data.materials.find((m) => m.id === editMat));

    const delMat = t.getAttribute("data-del-material");
    if (delMat) {
      const m = data.materials.find((x) => x.id === delMat);
      return confirmDialog(`Excluir o material "${m?.name}"? Esta acao nao pode ser desfeita.`, () =>
        handleResult(window.api.deleteMaterial(delMat), "Material excluido.")
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
      return confirmDialog(
        `Marcar como devolvido: ${r?.quantity}x ${r?.material_name} (${r?.agency_name})?`,
        () => handleResult(window.api.returnRental({ id: retRent }), "Devolucao registrada."),
        { title: "Confirmar devolucao", okLabel: "Devolver" }
      );
    }

    const delRent = t.getAttribute("data-del-rental");
    if (delRent) {
      return confirmDialog("Excluir este registro de aluguel do historico?", () =>
        handleResult(window.api.deleteRental(delRent), "Registro excluido.")
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
loadAll();
