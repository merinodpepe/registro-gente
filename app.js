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
  let tokenClient = null, pending = null, inflight = null;
  window.__gsiReady = () => { initAuth(); };

  function initAuth() {
    if (tokenClient || !window.google?.accounts?.oauth2) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.CLIENT_ID,
      scope: SCOPE,
      callback: (r) => {
        if (r.error) return pending?.reject(new Error(r.error));
        state.token = r.access_token;
        state.expires = Date.now() + ((Number(r.expires_in) || 3600) - 60) * 1000;
        LS.set(LS.signed, "1");
        pending?.resolve(state.token);
      },
      error_callback: (e) => pending?.reject(new Error(e.type || "auth")),
    });
    if (state.waitingInit) { state.waitingInit(); state.waitingInit = null; }
  }

  // Una sola petición de token en vuelo: las llamadas simultáneas comparten la misma promesa
  function requestToken(prompt) {
    if (inflight) return inflight;
    inflight = new Promise((resolve, reject) => {
      const go = () => { pending = { resolve, reject }; tokenClient.requestAccessToken({ prompt }); };
      if (tokenClient) go(); else { state.waitingInit = go; initAuth(); }
    }).finally(() => { inflight = null; });
    return inflight;
  }
  async function ensureToken() {
    if (state.token && Date.now() < state.expires) return state.token;
    return requestToken(""); // renovación silenciosa
  }

  async function api(path, opts = {}, retry = true) {
    const token = await ensureToken();
    let res;
    try {
      res = await fetch(API + path, {
        ...opts,
        signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
      });
    } catch {
      const err = new Error("Sin conexión con Google. Revisa tu internet e inténtalo de nuevo."); err.offline = true; throw err;
    }
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
    // Si la pestaña configurada no existe, usa la primera de la hoja
    const found = meta.sheets.find((s) => s.properties.title === state.tab);
    const sh = found || meta.sheets[0];
    if (!sh) throw new Error("El Sheet no tiene pestañas.");
    if (!found) toast(`No existe la pestaña "${state.tab}". Uso "${sh.properties.title}".`, true);
    state.tab = sh.properties.title;
    state.gid = sh.properties.sheetId;
  }

  async function loadPeople() {
    const range = encodeURIComponent(`${quoteTab(state.tab)}!A1:${LAST_COL}`);
    const data = await api(`/${state.sheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE`);
    const rows = data.values || [];
    const h = rows.findIndex((r) => norm(r[0]).trim() === "id");
    if (h === -1) throw new Error('No encuentro la fila de encabezados (la celda "ID" en la columna A).');
    if (norm(rows[h][2]).trim() !== "nombre") throw new Error("Las columnas del Sheet no coinciden (ID, Fecha, Nombre…). No escribo nada para no estropearlo.");
    state.headerRow = h + 1;
    const people = [];
    rows.slice(h + 1).forEach((r, i) => {
      const o = {};
      COLS.forEach((c, k) => (o[c] = c === "fecha" ? toISODate(r[k]) : str(r[k])));
      if (COLS.slice(1).every((c) => !o[c].trim())) return;
      o.id = Number(r[0]) || 0;
      o.row = h + 2 + i; // fila real en la hoja (1-indexada)
      people.push(o);
    });
    state.people = people;
  }

  async function refresh(silent = false) {
    if (DEMO) { render(); return; }
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
    if (e.offline) toast(e.message, true);
    else if (e.status === 403 || e.status === 404) toast("No tengo acceso a esa hoja. ¿Es la correcta y de tu cuenta?", true);
    else if (/popup|interaction|immediate|access_denied|auth/i.test(e.message)) { showView("login"); $("login-msg").textContent = "Tu sesión ha caducado. Vuelve a entrar."; }
    else toast(e.message || "Error", true);
  }

  const nextId = () => state.people.reduce((m, p) => Math.max(m, p.id), 0) + 1;

  function rawValues() {
    return [
      Number($("f-id").value), $("f-fecha").value, $("f-nombre").value.trim(), $("f-fisica").value.trim(), $("f-lugar").value.trim(),
      $("f-contexto").value.trim(), $("f-tag").value.trim(), $("f-contacto").value.trim(), $("f-notas").value.trim(),
    ];
  }
  // Evita que el Sheet interprete texto como fórmula/fecha/número (=, +, -, @, ceros iniciales, 1/2…)
  const safe = (s) => (/^[=+\-@\t\r]/.test(s) || /^0\d/.test(s) || /^\d+([/.-]\d+)+$/.test(s) ? "'" + s : s);
  const formValues = () => rawValues().map((v, k) => (k >= 2 ? safe(v) : v));

  async function savePerson() {
    const row = Number($("f-row").value);
    const values = formValues();
    if (DEMO) {
      const raw = rawValues();
      const o = Object.fromEntries(COLS.map((c, k) => [c, c === "id" ? raw[k] : String(raw[k])]));
      if (row) Object.assign(state.people.find((x) => x.row === row), o);
      else state.people.push({ ...o, id: nextId(), row: nextId() + 3 });
      return;
    }
    if (!row) {
      // nueva persona: añade al final sin pisar nada (ID calculado con datos recién leídos)
      await loadPeople();
      values[0] = nextId();
      await api(`/${state.sheetId}/values/${encodeURIComponent(`${quoteTab(state.tab)}!A:${LAST_COL}`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
        method: "POST", body: JSON.stringify({ values: [values] }),
      });
    } else {
      const orig = state.people.find((x) => x.row === row);
      await assertRow(orig);
      await api(`/${state.sheetId}/values/${encodeURIComponent(`${quoteTab(state.tab)}!A${row}:${LAST_COL}${row}`)}?valueInputOption=USER_ENTERED`, {
        method: "PUT", body: JSON.stringify({ values: [values] }),
      });
    }
  }

  // Evita pisar otra fila si alguien movió filas en el Sheet mientras tanto
  async function assertRow(p) {
    const r = await api(`/${state.sheetId}/values/${encodeURIComponent(`${quoteTab(state.tab)}!A${p.row}:C${p.row}`)}?valueRenderOption=UNFORMATTED_VALUE`);
    const v = r.values?.[0] || [];
    if (!p.id || Number(v[0]) !== p.id || str(v[2]) !== p.nombre) { await refresh(true); throw new Error("La hoja cambió. He recargado; vuelve a intentarlo."); }
  }

  async function deletePerson(p) {
    if (DEMO) { state.people = state.people.filter((x) => x !== p); return; }
    await assertRow(p);
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
      ...[[state.people.length, "total"], [week, "esta semana"], [withC, "con contacto"]].map(([n, l]) => el("div", { class: "stat" }, el("b", { text: n }), el("span", { text: l }))),
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

  const openIds = new Set();
  const svgIcon = (d, cls) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", cls); svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", d);
    svg.append(path); return svg;
  };
  const chev = () => svgIcon("m6 9 6 6 6-6", "chev");
  const phoneIcon = () => svgIcon("M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z", "contact-ico");

  function card(p, q, i = 0) {
    const f = (label, value) => (value.trim() ? el("div", { class: "field" }, el("dt", { text: label }), el("dd", {}, highlight(value, q))) : null);
    const isOpen = openIds.has(p.id);
    const bodyId = `cb-${p.row}`;
    const hv = hue(p.nombre || "?");
    const tags = splitTags(p.tag);
    const head = el("button", { class: "card-head", type: "button", "aria-expanded": String(isOpen), "aria-controls": bodyId },
      el("span", { class: "avatar", style: `background:linear-gradient(135deg,hsl(${hv} 62% 58%),hsl(${(hv + 40) % 360} 60% 46%))`, "aria-hidden": "true", text: (p.nombre.trim()[0] || "?").toUpperCase() }),
      el("span", { class: "card-title" }, el("span", { class: "card-name" }, highlight(p.nombre || "Sin nombre", q)), el("span", { class: "card-sub" }, highlight([p.lugar, p.fisica].filter(Boolean).join(" · ") || "—", q))),
      el("span", { class: "card-meta" },
        state.sort === "name" ? el("span", { text: dateLabel(p.fecha) }) : null,
        p.contacto.trim() ? el("span", { class: "has-contact" }, phoneIcon(), el("span", { class: "sr-only", text: "Tiene contacto" })) : null,
        chev()));
    const body = el("div", { class: "card-body", id: bodyId }, el("div", {}, el("div", { class: "card-inner" },
      el("dl", { style: "margin:0" }, f("Descripción física", p.fisica), f("Lugar", p.lugar), f("Contexto / Conversación", p.contexto), f("Contacto", p.contacto), f("Notas extra", p.notas), f("Fecha", p.fecha ? new Date(p.fecha + "T00:00:00").toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" }) : "")),
      el("div", { class: "card-actions" }, ...contactActions(p.contacto), el("button", { class: "btn primary", type: "button", onclick: (e) => { e.stopPropagation(); openForm(p); }, text: "Editar" })))));
    body.inert = !isOpen;
    const c = el("article", { class: "card" + (isOpen ? " open" : ""), style: `--i:${Math.min(i, 10)}` },
      el("h3", { class: "card-h" }, head),
      tags.length ? el("div", { class: "tags" }, tags.map((t) => el("span", { class: "tag", text: t }))) : null,
      body);
    const toggle = () => {
      const o = c.classList.toggle("open");
      head.setAttribute("aria-expanded", String(o)); body.inert = !o;
      if (o) openIds.add(p.id); else openIds.delete(p.id);
    };
    head.addEventListener("click", toggle);
    c.addEventListener("click", (e) => { if (!e.target.closest("a,button,.card-body")) toggle(); });
    return c;
  }

  function render() {
    renderStats(); renderChips();
    $("subtitle").textContent = state.people.length ? `${state.people.length} ${state.people.length === 1 ? "persona" : "personas"} registradas` : "Tu libreta privada";
    const q = state.q.trim();
    const list = filtered();
    const out = [];
    let last = null;
    for (const p of list) {
      if (state.sort !== "name") {
        const label = dateLabel(p.fecha);
        if (label !== last) { out.push(el("h2", { class: "group-title", text: label })); last = label; }
      }
      out.push(card(p, q, out.length));
    }
    $("list").classList.toggle("no-anim", state.rendered);
    state.rendered = true;
    $("list").replaceChildren(...out);
    $("empty").hidden = list.length > 0;
  }

  /* ---------- formulario ---------- */
  let snap = "";
  const dirty = () => JSON.stringify(rawValues()) !== snap;

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
    $("more").open = edit && !!(p.fisica || p.tag || p.notas);
    snap = JSON.stringify(rawValues());
    $("dlg-form").showModal();
    if (!edit) $("f-nombre").focus();
  }

  function exportCSV() {
    const head = ["ID", "Fecha", "Nombre", "Descripción física", "Lugar", "Contexto / Conversación", "Vibes / Tag", "Contacto (IG / Telf)", "Notas extra"];
    const esc = (v) => { const t = str(v); return `"${(/^[=+\-@\t\r]/.test(t) ? "'" + t : t).replace(/"/g, '""')}"`; };
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

  // Modo demo solo en localhost: datos inventados en memoria, sin tocar el Sheet (para probar la UI)
  const DEMO = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).has("demo");
  function startDemo() {
    const d = (n) => { const x = new Date(); x.setDate(x.getDate() - n); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
    const mk = (id, n, nombre, fisica, lugar, contexto, tag, contacto, notas) => ({ id, row: id + 3, fecha: d(n), nombre, fisica, lugar, contexto, tag, contacto, notas });
    state.people = [
      mk(1, 0, "Lucía Ferrer", "Pelo rizado, chaqueta vaquera", "Café del Born", "Le pregunté por el libro que leía y acabamos hablando de Cortázar.", "simpática, curiosa", "@lucia.ferrer", "Quedamos en repetir el café"),
      mk(2, 1, "Marc", "Alto, gorra roja", "Parada del bus 24", "Me dio conversación sobre el retraso del bus.", "molt top", "+34 600 123 456", ""),
      mk(3, 1, "Aisha", "Pañuelo verde", "Biblioteca Jaume Fuster", "Me recomendó un sitio para estudiar.", "amable", "", "Estudia arquitectura"),
      mk(4, 5, "Carlota Menéndez", "Morena bajita, mona", "Caminando bajo la lluvia", "Le dije 'oye, está lloviendo' y estuvimos hablando un buen rato.", "molt top, simpática", "", "Amiga de la familia de Joan"),
      mk(5, 12, "Josep", "Bajito, fuertote", "Plaza Sants", "Esperábamos que parara de llover.", "", "", ""),
    ];
    showView("app"); render();
  }

  async function start() {
    if (DEMO) return startDemo();
    state.sheetId = CFG.SHEET_ID || LS.get(LS.sheet) || "";
    state.tab = LS.get(LS.tab) || CFG.DEFAULT_TAB;
    if (!state.sheetId) { $("setup-tab").value = state.tab; showView("setup"); return; }
    LS.del(LS.cache); // limpia cachés de versiones anteriores: no guardamos datos personales en el navegador
    if (LS.get(LS.signed) !== "1") { showView("login"); return; }
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
  let qTimer;
  $("q").addEventListener("input", (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = e.target.value; render(); }, 120); });
  $("sort").addEventListener("change", (e) => { state.sort = e.target.value; render(); });

  function setMenu(open, focus = false) {
    $("menu").hidden = !open; $("btn-menu").setAttribute("aria-expanded", String(open));
    if (open) $("menu").querySelector("button").focus(); else if (focus) $("btn-menu").focus();
  }
  $("btn-menu").addEventListener("click", (e) => { e.stopPropagation(); setMenu($("menu").hidden); });
  document.addEventListener("click", () => { if (!$("menu").hidden) setMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("menu").hidden) setMenu(false, true); });
  $("menu-export").addEventListener("click", exportCSV);
  $("menu-settings").addEventListener("click", () => { $("setup-sheet").value = state.sheetId; $("setup-tab").value = state.tab; showView("setup"); });
  $("menu-logout").addEventListener("click", () => {
    if (state.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(state.token, () => {});
    state.token = null; state.people = [];
    LS.del(LS.signed); LS.del(LS.cache);
    $("list").replaceChildren(); showView("login");
  });

  function closeDlg(d) {
    if (!d.open || d.classList.contains("closing")) return;
    d.classList.add("closing");
    setTimeout(() => { d.classList.remove("closing"); d.close(); }, 200);
  }
  function requestClose(d) {
    if (d.id === "dlg-form" && dirty() && !confirm("¿Descartar lo que has escrito?")) return;
    closeDlg(d);
  }
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => requestClose(b.closest("dialog"))));
  document.querySelectorAll("dialog").forEach((d) => {
    d.addEventListener("click", (e) => { if (e.target === d) requestClose(d); });
    d.addEventListener("cancel", (e) => { e.preventDefault(); requestClose(d); });
  });

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("btn-save");
    if (!$("f-nombre").value.trim() && !$("f-fisica").value.trim()) {
      $("form-msg").textContent = "Pon un nombre o, al menos, una descripción física.";
      $("more").open = true; $("f-nombre").focus(); return;
    }
    btn.disabled = true; btn.setAttribute("aria-busy", "true"); btn.textContent = "Guardando…"; $("form-msg").textContent = "";
    try {
      const isNew = !$("f-row").value;
      await savePerson();
      snap = JSON.stringify(rawValues());
      closeDlg($("dlg-form"));
      toast(isNew ? "Añadido ✓" : "Guardado ✓"); navigator.vibrate?.(15);
      await refresh(true);
    } catch (err) { $("form-msg").textContent = err.message; }
    finally { btn.disabled = false; btn.removeAttribute("aria-busy"); btn.textContent = "Guardar"; }
  });

  let toDelete = null;
  $("btn-delete").addEventListener("click", () => {
    toDelete = state.people.find((p) => p.row === Number($("f-row").value));
    if (!toDelete) return;
    $("confirm-name").textContent = toDelete.nombre || "esta persona";
    $("dlg-confirm").showModal();
  });
  $("confirm-no").addEventListener("click", () => closeDlg($("dlg-confirm")));
  $("confirm-yes").addEventListener("click", async () => {
    const btn = $("confirm-yes"); btn.disabled = true;
    try { await deletePerson(toDelete); closeDlg($("dlg-confirm")); snap = JSON.stringify(rawValues()); closeDlg($("dlg-form")); toast("Borrado"); await refresh(true); }
    catch (err) { closeDlg($("dlg-confirm")); toast(err.message, true); }
    finally { btn.disabled = false; }
  });

  let lastY = 0;
  addEventListener("scroll", () => {
    const y = scrollY;
    $("topbar").classList.toggle("scrolled", y > 8);
    $("fab").classList.toggle("compact", y > 60 && y > lastY);
    if (y < lastY) $("fab").classList.remove("compact");
    lastY = y;
  }, { passive: true });

  start();
})();
