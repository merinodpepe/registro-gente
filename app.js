"use strict";
(() => {
  const CFG = window.APP_CONFIG;
  const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
  const API = "https://sheets.googleapis.com/v4/spreadsheets";
  const COLS = ["id", "fecha", "nombre", "fisica", "lugar", "contexto", "tag", "contacto", "notas"];
  const LAST_COL = "I";
  const LS = {
    sheet: "rg.sheetId", tab: "rg.tab", signed: "rg.signedIn", cache: "rg.cache",
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin storage */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* sin storage */ } },
  };

  const $ = (id) => document.getElementById(id);
  const state = { token: null, expires: 0, sheetId: "", tab: "", gid: null, headerRow: 3, people: [], q: "", tag: "", sort: "date-desc", busy: false };

  /* ---------- utilidades ---------- */
  const pad = (n) => String(n).padStart(2, "0");
  const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const serialToISO = (n) => new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10);
  const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const str = (v) => (v === undefined || v === null ? "" : String(v));
  const quoteTab = (t) => `'${t.replace(/'/g, "''")}'`;

  function toISODate(v) {
    if (typeof v === "number") return serialToISO(v);
    const s = str(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
    if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${pad(m[2])}-${pad(m[1])}`;
    return "";
  }
  function dateLabel(iso) {
    if (!iso) return "Sin fecha";
    const d = new Date(iso + "T00:00:00");
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const diff = Math.round((t - d) / 86400000);
    if (diff === 0) return "Hoy";
    if (diff === 1) return "Ayer";
    return d.toLocaleDateString("es-ES", { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() === t.getFullYear() ? undefined : "numeric" });
  }
  function toast(msg, err = false) {
    const t = $("toast");
    t.textContent = msg; t.className = "toast show" + (err ? " err" : "");
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = "toast"), err ? 4500 : 2200);
  }
  function el(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) e.append(kid);
    return e;
  }
  function highlight(text, q) {
    const frag = document.createDocumentFragment();
    if (!q) { frag.append(text); return frag; }
    const nt = norm(text), nq = norm(q);
    if (nt.length !== text.length) { frag.append(text); return frag; }
    let i = 0, idx;
    while ((idx = nt.indexOf(nq, i)) !== -1) {
      frag.append(text.slice(i, idx), el("mark", { text: text.slice(idx, idx + nq.length) }));
      i = idx + nq.length;
    }
    frag.append(text.slice(i));
    return frag;
  }
  const splitTags = (s) => str(s).split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  const hue = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

  /* ---------- autenticación (Google Identity Services) ---------- */
  let tokenClient = null, pending = null;
  window.__gsiReady = () => { initAuth(); };

  function initAuth() {
    if (tokenClient || !window.google?.accounts?.oauth2) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.CLIENT_ID,
      scope: SCOPE,
      callback: (r) => {
        if (r.error) return pending?.reject(new Error(r.error));
        state.token = r.access_token;
        state.expires = Date.now() + (Number(r.expires_in) - 60) * 1000;
        LS.set(LS.signed, "1");
        pending?.resolve(state.token);
      },
      error_callback: (e) => pending?.reject(new Error(e.type || "auth")),
    });
    if (state.waitingInit) { state.waitingInit(); state.waitingInit = null; }
  }

  function requestToken(prompt) {
    return new Promise((resolve, reject) => {
      const go = () => { pending = { resolve, reject }; tokenClient.requestAccessToken({ prompt }); };
      if (tokenClient) go(); else { state.waitingInit = go; initAuth(); }
    });
  }
  async function ensureToken() {
    if (state.token && Date.now() < state.expires) return state.token;
    return requestToken(""); // renovación silenciosa
  }

  async function api(path, opts = {}, retry = true) {
    const token = await ensureToken();
    const res = await fetch(API + path, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
    });
    if (res.status === 401 && retry) { state.token = null; return api(path, opts, false); }
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error?.message || msg; } catch { /* sin json */ }
      const err = new Error(msg); err.status = res.status; throw err;
    }
    return res.json();
  }

  /* ---------- datos ---------- */
  async function loadSheetMeta() {
    const meta = await api(`/${state.sheetId}?fields=sheets.properties(sheetId,title)`);
    const sh = meta.sheets.find((s) => s.properties.title === state.tab);
    if (!sh) throw new Error(`No existe la pestaña "${state.tab}". Pestañas: ${meta.sheets.map((s) => s.properties.title).join(", ")}`);
    state.gid = sh.properties.sheetId;
  }

  async function loadPeople() {
    const range = encodeURIComponent(`${quoteTab(state.tab)}!A1:${LAST_COL}`);
    const data = await api(`/${state.sheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE`);
    const rows = data.values || [];
    const h = rows.findIndex((r) => norm(r[0]).trim() === "id");
    if (h === -1) throw new Error('No encuentro la fila de encabezados (la celda "ID" en la columna A).');
    state.headerRow = h + 1;
    const people = [];
    rows.slice(h + 1).forEach((r, i) => {
      const o = {};
      COLS.forEach((c, k) => (o[c] = c === "fecha" ? toISODate(r[k]) : str(r[k])));
      if (!o.nombre.trim() && !o.contexto.trim() && !o.lugar.trim() && !o.fisica.trim()) return;
      o.id = Number(r[0]) || 0;
      o.row = h + 2 + i; // fila real en la hoja (1-indexada)
      people.push(o);
    });
    state.people = people;
    LS.set(LS.cache, JSON.stringify({ sheet: state.sheetId, people }));
  }

  async function refresh(silent = false) {
    if (state.busy) return;
    state.busy = true;
    $("btn-refresh").classList.add("spin");
    if (!silent && !state.people.length) $("loading").hidden = false;
    try {
      if (state.gid === null) await loadSheetMeta();
      await loadPeople();
      render();
    } catch (e) {
      handleError(e);
    } finally {
      state.busy = false; $("loading").hidden = true; $("btn-refresh").classList.remove("spin");
    }
  }

  function handleError(e) {
    console.error(e);
    if (e.status === 403 || e.status === 404) toast("No tengo acceso a esa hoja. ¿Es la correcta y de tu cuenta?", true);
    else if (/popup|interaction|immediate|access_denied|auth/i.test(e.message)) { showView("login"); $("login-msg").textContent = "Tu sesión ha caducado. Vuelve a entrar."; }
    else toast(e.message || "Error", true);
  }

  const nextId = () => state.people.reduce((m, p) => Math.max(m, p.id), 0) + 1;

  function formValues() {
    return [
      Number($("f-id").value), $("f-fecha").value, $("f-nombre").value.trim(), $("f-fisica").value.trim(), $("f-lugar").value.trim(),
      $("f-contexto").value.trim(), $("f-tag").value.trim(), $("f-contacto").value.trim(), $("f-notas").value.trim(),
    ];
  }

  async function savePerson() {
    const row = Number($("f-row").value);
    const values = formValues();
    if (!row) {
      // nueva persona: justo debajo de la última fila con datos
      const last = Math.max(state.headerRow, ...state.people.map((p) => p.row));
      const target = last + 1;
      values[0] = nextId();
      await api(`/${state.sheetId}/values/${encodeURIComponent(`${quoteTab(state.tab)}!A${target}:${LAST_COL}${target}`)}?valueInputOption=USER_ENTERED`, {
        method: "PUT", body: JSON.stringify({ values: [values] }),
      });
    } else {
      await assertRow(row, values[0]);
      await api(`/${state.sheetId}/values/${encodeURIComponent(`${quoteTab(state.tab)}!A${row}:${LAST_COL}${row}`)}?valueInputOption=USER_ENTERED`, {
        method: "PUT", body: JSON.stringify({ values: [values] }),
      });
    }
  }

  // Evita pisar otra fila si alguien movió filas en el Sheet mientras tanto
  async function assertRow(row, id) {
    const r = await api(`/${state.sheetId}/values/${encodeURIComponent(`${quoteTab(state.tab)}!A${row}`)}?valueRenderOption=UNFORMATTED_VALUE`);
    if (Number(r.values?.[0]?.[0]) !== id) { await refresh(true); throw new Error("La hoja cambió. He recargado; vuelve a intentarlo."); }
  }

  async function deletePerson(p) {
    await assertRow(p.row, p.id);
    await api(`/${state.sheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests: [{ deleteDimension: { range: { sheetId: state.gid, dimension: "ROWS", startIndex: p.row - 1, endIndex: p.row } } }] }),
    });
  }

  /* ---------- vistas ---------- */
  function showView(name) {
    for (const v of ["login", "setup", "app"]) $("view-" + v).hidden = v !== name;
    $("topbar").hidden = name !== "app";
    $("fab").hidden = name !== "app";
  }

  /* ---------- render ---------- */
  function filtered() {
    const q = norm(state.q).trim();
    let list = state.people.filter((p) => {
      if (state.tag) {
        if (state.tag === "__contact") { if (!p.contacto.trim()) return false; }
        else if (state.tag === "__nocontact") { if (p.contacto.trim()) return false; }
        else if (!splitTags(p.tag).some((t) => norm(t) === norm(state.tag))) return false;
      }
      if (!q) return true;
      return norm([p.nombre, p.fisica, p.lugar, p.contexto, p.tag, p.contacto, p.notas].join(" ")).includes(q);
    });
    const byDate = (a, b) => (a.fecha || "").localeCompare(b.fecha || "") || a.id - b.id;
    if (state.sort === "date-desc") list.sort((a, b) => byDate(b, a));
    else if (state.sort === "date-asc") list.sort(byDate);
    else list.sort((a, b) => norm(a.nombre).localeCompare(norm(b.nombre)));
    return list;
  }

  function renderStats() {
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
    const wk = weekAgo.toISOString().slice(0, 10);
    const week = state.people.filter((p) => p.fecha >= wk).length;
    const withC = state.people.filter((p) => p.contacto.trim()).length;
    $("stats").replaceChildren(
      ...[[state.people.length, "personas"], [week, "últimos 7 días"], [withC, "con contacto"]].map(([n, l]) => el("div", { class: "stat" }, el("b", { text: n }), el("span", { text: l }))),
    );
  }

  function renderChips() {
    const counts = new Map();
    state.people.forEach((p) => splitTags(p.tag).forEach((t) => { const k = norm(t); counts.set(k, { name: counts.get(k)?.name || t, n: (counts.get(k)?.n || 0) + 1 }); }));
    const mk = (value, label, n) => el("button", { class: "chip", type: "button", "aria-pressed": String(state.tag === value), onclick: () => { state.tag = state.tag === value ? "" : value; render(); } }, label, n != null ? el("small", { text: n }) : null);
    const chips = [mk("", "Todos")];
    chips[0].setAttribute("aria-pressed", String(state.tag === ""));
    chips[0].onclick = () => { state.tag = ""; render(); };
    chips.push(mk("__contact", "📞 Con contacto"), mk("__nocontact", "Sin contacto"));
    [...counts.values()].sort((a, b) => b.n - a.n).forEach((t) => chips.push(mk(t.name, t.name, t.n)));
    $("chips").replaceChildren(...chips);
    $("dl-tags").replaceChildren(...[...counts.values()].map((t) => el("option", { value: t.name })));
    const places = [...new Set(state.people.map((p) => p.lugar.trim()).filter(Boolean))];
    $("dl-lugares").replaceChildren(...places.map((v) => el("option", { value: v })));
  }

  function contactActions(c) {
    const out = [];
    const s = c.trim();
    if (!s) return out;
    const ig = s.match(/^@?([A-Za-z0-9._]{2,30})$/) && /[A-Za-z]/.test(s) ? s.replace(/^@/, "") : (s.match(/instagram\.com\/([A-Za-z0-9._]+)/i) || [])[1];
    const digits = s.replace(/[^\d+]/g, "");
    if (ig) out.push(el("a", { class: "btn", href: `https://instagram.com/${ig}`, target: "_blank", rel: "noopener", text: "Instagram" }));
    else if (/^\+?\d{7,15}$/.test(digits)) {
      out.push(el("a", { class: "btn", href: `tel:${digits}`, text: "Llamar" }));
      out.push(el("a", { class: "btn", href: `https://wa.me/${digits.replace("+", "")}`, target: "_blank", rel: "noopener", text: "WhatsApp" }));
    } else if (/^https?:\/\//i.test(s)) out.push(el("a", { class: "btn", href: s, target: "_blank", rel: "noopener noreferrer", text: "Abrir enlace" }));
    return out;
  }

  function card(p, q) {
    const f = (label, value) => (value.trim() ? el("div", { class: "field" }, el("dt", { text: label }), el("dd", {}, highlight(value, q))) : null);
    const c = el("article", { class: "card", tabindex: "0" },
      el("div", { class: "card-head" },
        el("div", { class: "avatar", style: `background:hsl(${hue(p.nombre || "?")} 60% 50%)`, "aria-hidden": "true", text: (p.nombre.trim()[0] || "?").toUpperCase() }),
        el("div", { class: "card-title" }, el("h3", {}, highlight(p.nombre || "Sin nombre", q)), el("p", {}, highlight([p.lugar, p.fisica].filter(Boolean).join(" · ") || "—", q))),
        el("span", { class: "card-date", text: dateLabel(p.fecha) })),
      splitTags(p.tag).length ? el("div", { class: "tags" }, splitTags(p.tag).map((t) => el("span", { class: "tag", text: t }))) : null,
      el("div", { class: "card-body" },
        el("dl", { style: "margin:0" }, f("Descripción física", p.fisica), f("Lugar", p.lugar), f("Contexto / Conversación", p.contexto), f("Contacto", p.contacto), f("Notas extra", p.notas)),
        el("div", { class: "card-actions" }, ...contactActions(p.contacto), el("button", { class: "btn primary", type: "button", onclick: (e) => { e.stopPropagation(); openForm(p); }, text: "Editar" }))));
    const toggle = () => c.classList.toggle("open");
    c.addEventListener("click", (e) => { if (!e.target.closest("a,button")) toggle(); });
    c.addEventListener("keydown", (e) => { if (e.target === c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(); } });
    return c;
  }

  function render() {
    renderStats(); renderChips();
    const q = state.q.trim();
    const list = filtered();
    const out = [];
    let last = null;
    for (const p of list) {
      if (state.sort !== "name") {
        const label = dateLabel(p.fecha);
        if (label !== last) { out.push(el("h2", { class: "group-title", text: label })); last = label; }
      }
      out.push(card(p, q));
    }
    $("list").replaceChildren(...out);
    $("empty").hidden = list.length > 0;
  }

  /* ---------- formulario ---------- */
  function openForm(p) {
    const edit = !!p;
    $("form-title").textContent = edit ? `Editar a ${p.nombre || "persona"}` : "Nueva persona";
    $("f-row").value = edit ? p.row : "";
    $("f-id").value = edit ? p.id : "";
    $("f-nombre").value = edit ? p.nombre : "";
    $("f-fecha").value = edit ? p.fecha || todayISO() : todayISO();
    $("f-fisica").value = edit ? p.fisica : "";
    $("f-lugar").value = edit ? p.lugar : "";
    $("f-contexto").value = edit ? p.contexto : "";
    $("f-tag").value = edit ? p.tag : "";
    $("f-contacto").value = edit ? p.contacto : "";
    $("f-notas").value = edit ? p.notas : "";
    $("btn-delete").hidden = !edit;
    $("form-msg").textContent = "";
    $("dlg-form").showModal();
    if (!edit) $("f-nombre").focus();
  }

  function exportCSV() {
    const head = ["ID", "Fecha", "Nombre", "Descripción física", "Lugar", "Contexto / Conversación", "Vibes / Tag", "Contacto (IG / Telf)", "Notas extra"];
    const esc = (v) => `"${str(v).replace(/"/g, '""')}"`;
    const csv = [head, ...state.people.map((p) => COLS.map((c) => p[c]))].map((r) => r.map(esc).join(",")).join("\n");
    const a = el("a", { href: URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" })), download: `encuentros-${todayISO()}.csv` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------- arranque y eventos ---------- */
  function parseSheetId(input) {
    const m = input.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    return /^[a-zA-Z0-9_-]{20,}$/.test(input.trim()) ? input.trim() : "";
  }

  async function start() {
    state.sheetId = CFG.SHEET_ID || LS.get(LS.sheet) || "";
    state.tab = LS.get(LS.tab) || CFG.DEFAULT_TAB;
    if (!state.sheetId) { $("setup-tab").value = state.tab; showView("setup"); return; }
    // pintar la caché mientras se autentica (si existe)
    try { const c = JSON.parse(LS.get(LS.cache) || "null"); if (c?.sheet === state.sheetId) { state.people = c.people; showView("app"); render(); } } catch { /* sin caché */ }
    if (LS.get(LS.signed) !== "1") { state.people = []; showView("login"); return; }
    try {
      await requestToken("");
      showView("app");
      await refresh(true);
    } catch {
      state.people = []; $("list").replaceChildren(); showView("login");
    }
  }

  $("btn-login").addEventListener("click", async () => {
    $("login-msg").textContent = "";
    try {
      await requestToken("select_account");
      if (!state.sheetId) { showView("setup"); return; }
      showView("app"); await refresh();
    } catch (e) { $("login-msg").textContent = "No se pudo iniciar sesión (" + e.message + ")."; }
  });

  $("setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = parseSheetId($("setup-sheet").value);
    if (!id) { $("setup-msg").textContent = "No reconozco esa URL o ID."; return; }
    state.sheetId = id; state.tab = $("setup-tab").value.trim(); state.gid = null; state.people = [];
    LS.set(LS.sheet, id); LS.set(LS.tab, state.tab);
    $("setup-msg").textContent = "";
    if (LS.get(LS.signed) !== "1" || !state.token) { showView("login"); return; }
    showView("app"); await refresh();
  });

  $("btn-refresh").addEventListener("click", () => refresh());
  $("fab").addEventListener("click", () => openForm(null));
  $("q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
  $("sort").addEventListener("change", (e) => { state.sort = e.target.value; render(); });

  $("btn-menu").addEventListener("click", (e) => { e.stopPropagation(); $("menu").hidden = !$("menu").hidden; });
  document.addEventListener("click", () => ($("menu").hidden = true));
  $("menu-export").addEventListener("click", exportCSV);
  $("menu-settings").addEventListener("click", () => { $("setup-sheet").value = state.sheetId; $("setup-tab").value = state.tab; showView("setup"); });
  $("menu-logout").addEventListener("click", () => {
    if (state.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(state.token, () => {});
    state.token = null; state.people = [];
    LS.del(LS.signed); LS.del(LS.cache);
    $("list").replaceChildren(); showView("login");
  });

  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
  document.querySelectorAll("dialog").forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("btn-save"); btn.disabled = true; btn.textContent = "Guardando…"; $("form-msg").textContent = "";
    try {
      const isNew = !$("f-row").value;
      await savePerson();
      $("dlg-form").close();
      toast(isNew ? "Añadido ✓" : "Guardado ✓");
      await refresh(true);
    } catch (err) { $("form-msg").textContent = err.message; }
    finally { btn.disabled = false; btn.textContent = "Guardar"; }
  });

  let toDelete = null;
  $("btn-delete").addEventListener("click", () => {
    toDelete = state.people.find((p) => p.row === Number($("f-row").value));
    if (!toDelete) return;
    $("confirm-name").textContent = toDelete.nombre || "esta persona";
    $("dlg-confirm").showModal();
  });
  $("confirm-no").addEventListener("click", () => $("dlg-confirm").close());
  $("confirm-yes").addEventListener("click", async () => {
    $("dlg-confirm").close();
    try { await deletePerson(toDelete); $("dlg-form").close(); toast("Borrado"); await refresh(true); }
    catch (err) { toast(err.message, true); }
  });

  start();
})();
