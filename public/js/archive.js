// Archive room (hospital-5b1, Phase 5): a DOM panel that lists the case files and shows one document at a time.
// Text reaches the page only through textContent (a <pre>); images only through <img src> on the same origin.
// The client sends no path and no custom header: the id is server-minted, the kind is one of a fixed set.
// Pure helpers first (tested with a fake fetch); the DOM layer is createArchive(document) at the bottom.

const ID_RE = /^[0-9a-f]{16}$/;
const KIND_RE = /^(state|plan|shot-(0|[1-9]\d?)|council-(0|[1-9]|1\d)-(decisions|debate|brief))$/;
const SHOT_RE = /^shot-(0|[1-9]\d?)$/;
const COUNCIL_RE = /^council-(0|[1-9]|1\d)-(decisions|debate|brief)$/;
const TEXT_ORDER = ['state', 'plan'];
const TEXT_LABEL = { state: 'Estado', plan: 'Plan' };
const COUNCIL_ORDER = ['decisions', 'debate', 'brief'];
const COUNCIL_LABEL = { decisions: 'Decisiones', debate: 'Debate', brief: 'Brief' };
const SHOTS_TAB = 'shots';
const SHOTS_LABEL = 'Capturas';
const TRUNCATED_NOTE = 'Texto recortado: el documento supera 256 KB y se muestra solo el principio.';
const NOT_AVAILABLE = 'Documento no disponible.';
const FOCUSABLE = 'button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Same-origin URL of one document, or null when the id or the kind is not in the fixed shape. */
export function docUrl(caseId, kind) {
  if (typeof caseId !== 'string' || !ID_RE.test(caseId) || typeof kind !== 'string' || !KIND_RE.test(kind)) return null;
  return `/api/doc?case=${caseId}&doc=${kind}`;
}

/** GET /api/archive with no options: a plain same-origin request. A refusal throws (never an empty list by accident). */
export async function fetchArchive(fetchFn) {
  const r = await fetchFn('/api/archive');
  if (!r.ok) throw new Error(`/api/archive ${r.status}`);
  const body = await r.json();
  return { cases: Array.isArray(body?.cases) ? body.cases : [], truncated: body?.truncated === true };
}

const mtimeKey = (c) => (Number.isFinite(c.mtime) ? c.mtime : -Infinity);

/** Rows in display order: newest first; equal mtimes keep the server order. Only the fields the list shows. */
export function archiveRows(cases) {
  return cases
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (mtimeKey(b.c) - mtimeKey(a.c)) || (a.i - b.i))
    .map(({ c }) => ({
      id: c.id,
      project: c.project,
      name: c.name,
      status: c.status,
      tier: c.tier,
      mtime: c.mtime,
      live: c.live === true,
    }));
}

/** The shot kinds a case really has, in numeric order (each once). Anything that is not shot-<n> is dropped. */
export function shotKinds(docs) {
  const kinds = [...new Set((docs ?? []).map((d) => d?.kind))]
    .filter((k) => typeof k === 'string' && SHOT_RE.test(k));
  return kinds.sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
}

/** Gallery thumbnails: one per shot, with its same-origin URL. A bad case id gives no items (never a bogus URL). */
export function galleryItems(caseId, docs) {
  return shotKinds(docs)
    .map((kind) => ({ kind, label: `Captura ${Number(kind.slice(5)) + 1}`, url: docUrl(caseId, kind) }))
    .filter((it) => it.url !== null);
}

/** "n / total" for the large view; empty when there is nothing to count. */
export function shotCaption(i, total) {
  return total > 0 && i >= 0 && i < total ? `${i + 1} / ${total}` : '';
}

/** Previous/next in the large view: clamped to the gallery (no wrap). An empty gallery gives -1. */
export function stepShot(i, delta, total) {
  if (total <= 0) return -1;
  return Math.min(total - 1, Math.max(0, i + delta));
}

// Council docs as tabs: by council index, then decisions, debate, brief. The label is the dir name (shown as text).
function councilTabs(docs) {
  const councils = new Map();
  for (const d of docs ?? []) {
    const m = COUNCIL_RE.exec(typeof d?.kind === 'string' ? d.kind : '');
    if (!m) continue;
    const n = Number(m[1]);
    if (!councils.has(n)) {
      const label = typeof d.label === 'string' && d.label ? d.label : `Consejo ${n + 1}`;
      councils.set(n, { label, types: new Set() });
    }
    councils.get(n).types.add(m[2]);
  }
  const tabs = [];
  for (const n of [...councils.keys()].sort((a, b) => a - b)) {
    const c = councils.get(n);
    for (const t of COUNCIL_ORDER) {
      if (c.types.has(t)) tabs.push({ kind: `council-${n}-${t}`, label: `${COUNCIL_LABEL[t]} · ${c.label}` });
    }
  }
  return tabs;
}

/** Tabs for the docs a case really has: state, plan, the councils, then ONE Capturas tab when there are shots. */
export function viewerTabs(docs) {
  const kinds = new Set((docs ?? []).map((d) => d?.kind));
  const tabs = TEXT_ORDER.filter((k) => kinds.has(k)).map((k) => ({ kind: k, label: TEXT_LABEL[k] }));
  tabs.push(...councilTabs(docs));
  if (shotKinds(docs).length) tabs.push({ kind: SHOTS_TAB, label: SHOTS_LABEL });
  return tabs;
}

/**
 * Banners for a text document from its headers. Redaction shows its count (best effort, said plainly); truncation
 * has its own notice. A header that is present but unreadable is a warning, never a silent zero.
 */
export function docBanners(headers) {
  const get = (name) => (typeof headers?.get === 'function' ? headers.get(name) : null);
  const out = [];
  const count = get('X-Redacted-Count');
  if (count !== null) {
    if (!/^\d+$/.test(count)) {
      out.push({ tone: 'warn', text: 'Cabecera de redacción ilegible: no se puede confiar en el recuento.' });
    } else if (Number(count) > 0) {
      const n = Number(count);
      out.push({ tone: 'warn', text: `${n} ${n === 1 ? 'secreto tapado' : 'secretos tapados'} — protección parcial` });
    }
  }
  if (get('X-Truncated') === 'true') out.push({ tone: 'info', text: TRUNCATED_NOTE });
  return out;
}

/** One document. found:false is the friendly "no disponible" (every refusal is the same 404 on the server). */
export async function fetchDoc(fetchFn, caseId, kind) {
  const url = docUrl(caseId, kind);
  if (!url) throw new Error(`document kind or case id refused by the client: ${kind}`);
  const r = await fetchFn(url);
  if (r.status === 404) return { found: false };
  if (!r.ok) throw new Error(`/api/doc ${kind} ${r.status}`);
  return { found: true, text: await r.text(), banners: docBanners(r.headers) };
}

// ---- DOM layer (browser only; nothing here runs on import) ----

function mtimeText(ms) {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Wires the Archive panel of public/index.html. Every element is looked up by id and must exist.
 * openList(from) and openCase(id, from) open the panel; `from` is the element that gets the focus back on close.
 */
export function createArchive(doc, { fetchFn = (u) => fetch(u) } = {}) {
  const el = (id) => {
    const found = doc.getElementById(id);
    if (!found) throw new Error(`[hospital] archive element missing: #${id}`);
    return found;
  };
  const panel = el('archive');
  const closeBtn = el('archive-close');
  const listView = el('archive-list-view');
  const docView = el('archive-doc-view');
  const statusEl = el('archive-status');
  const list = el('archive-list');
  const truncatedEl = el('archive-truncated');
  const title = el('archive-title');
  const back = el('archive-back');
  const docTitle = el('archive-doc-title');
  const tabsEl = el('archive-tabs');
  const banners = el('archive-banners');
  const notice = el('archive-notice');
  const pre = el('archive-text');
  const gallery = el('archive-gallery');
  const thumbs = el('archive-thumbs');
  const shotBar = el('archive-shot-bar');
  const shotPrev = el('archive-shot-prev');
  const shotPos = el('archive-shot-pos');
  const shotNext = el('archive-shot-next');
  const shotBack = el('archive-shot-back');
  const img = el('archive-img');

  let opener = null;
  let listSeq = 0;
  let docSeq = 0;
  let cache = null; // last /api/archive answer: { cases, truncated }
  let current = null; // { id, name, docs } of the case on screen
  let shots = []; // galleryItems() of the case on screen
  let shotIdx = -1; // the shot in the large view, -1 when none

  const isOpen = () => !panel.hidden;

  function openPanel(from) {
    if (isOpen()) return;
    opener = from ?? doc.activeElement;
    panel.hidden = false;
    closeBtn.focus();
  }

  function close() {
    if (!isOpen()) return;
    listSeq += 1;
    docSeq += 1;
    panel.hidden = true;
    resetPanes();
    shots = [];
    // The opener may be gone (an inspector button is rebuilt on every update): then the HUD button takes the focus.
    const back = opener && doc.contains(opener) ? opener : doc.getElementById('archive-open');
    back?.focus();
    opener = null;
  }

  function showView(view) {
    listView.hidden = view !== 'list';
    docView.hidden = view !== 'doc';
  }

  function showNotice(text) {
    notice.textContent = text;
    notice.hidden = false;
  }

  // Empties every pane of the document view (text, banners, gallery, large view). Each view then opens itself.
  function resetPanes() {
    banners.replaceChildren();
    notice.hidden = true;
    pre.hidden = true;
    pre.textContent = '';
    gallery.hidden = true;
    thumbs.replaceChildren();
    shotBar.hidden = true;
    img.hidden = true;
    img.removeAttribute('src');
  }

  // One thumbnail. The image loads lazily; a failed one becomes a plain "no disponible" text in its cell.
  function thumbItem(item, i) {
    const li = doc.createElement('li');
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'archive-thumb';
    btn.addEventListener('click', () => showShot(i));
    const im = doc.createElement('img');
    im.setAttribute('loading', 'lazy');
    im.alt = item.label;
    im.addEventListener('error', () => {
      const missing = doc.createElement('span');
      missing.className = 'archive-thumb-missing';
      missing.textContent = NOT_AVAILABLE;
      im.replaceWith(missing);
    });
    im.src = item.url;
    const cap = doc.createElement('span');
    cap.className = 'archive-thumb-label';
    cap.textContent = item.label;
    btn.append(im, cap);
    li.appendChild(btn);
    return li;
  }

  function showGallery() {
    resetPanes();
    shotIdx = -1;
    shots = galleryItems(current.id, current.docs);
    if (!shots.length) {
      showNotice(NOT_AVAILABLE);
      return;
    }
    gallery.hidden = false;
    thumbs.replaceChildren(...shots.map((s, i) => thumbItem(s, i)));
  }

  // The large view of one shot, with prev/next and back to the grid. The index is clamped to the gallery.
  function showShot(i) {
    const idx = stepShot(i, 0, shots.length);
    if (idx < 0) {
      showGallery();
      return;
    }
    resetPanes();
    shotIdx = idx;
    shotBar.hidden = false;
    shotPos.textContent = shotCaption(idx, shots.length);
    shotPrev.disabled = idx <= 0;
    shotNext.disabled = idx >= shots.length - 1;
    img.hidden = false;
    img.src = shots[idx].url;
  }

  function rowItem(r) {
    const li = doc.createElement('li');
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'archive-row';
    const head = doc.createElement('span');
    head.className = 'archive-row-title';
    head.textContent = `${r.project} · ${r.name}`;
    const meta = doc.createElement('span');
    meta.className = 'archive-row-meta';
    meta.textContent = [r.status ?? '—', r.tier ? `Tier ${r.tier}` : null, mtimeText(r.mtime)].filter(Boolean).join(' · ');
    btn.append(head, meta);
    if (r.live) {
      const badge = doc.createElement('span');
      badge.className = 'archive-live';
      badge.textContent = 'en vivo';
      btn.append(badge);
    }
    btn.addEventListener('click', () => {
      const entry = cache?.cases.find((c) => c.id === r.id);
      showCase({ id: r.id, name: r.name, docs: entry?.docs ?? [] });
    });
    li.appendChild(btn);
    return li;
  }

  async function loadCases() {
    if (!cache) cache = await fetchArchive(fetchFn);
    return cache;
  }

  async function openList(from) {
    openPanel(from);
    showView('list');
    title.textContent = 'ARCHIVO DEL CASO';
    current = null;
    const my = ++listSeq;
    statusEl.hidden = false;
    statusEl.textContent = 'cargando…';
    list.replaceChildren();
    truncatedEl.hidden = true;
    cache = null;
    try {
      const { cases, truncated } = await loadCases();
      if (my !== listSeq) return;
      const rows = archiveRows(cases);
      statusEl.textContent = rows.length ? '' : 'Sin expedientes en el archivo.';
      statusEl.hidden = rows.length > 0;
      truncatedEl.hidden = !truncated;
      for (const r of rows) list.appendChild(rowItem(r));
    } catch (err) {
      if (my !== listSeq) return;
      statusEl.textContent = 'No se pudo cargar el archivo.';
      console.error(`[hospital] archive: ${err.message}`);
    }
  }

  // The case's own entry (its docs decide the tabs): from the cached list, refetched once when absent.
  async function findEntry(id) {
    const hit = (await loadCases()).cases.find((c) => c.id === id);
    if (hit) return hit;
    cache = null;
    return (await loadCases()).cases.find((c) => c.id === id) ?? null;
  }

  async function openCase(id, from) {
    openPanel(from);
    const my = ++listSeq;
    try {
      const entry = await findEntry(id);
      if (my !== listSeq) return;
      if (!entry) {
        showView('list');
        title.textContent = 'ARCHIVO DEL CASO';
        statusEl.hidden = false;
        statusEl.textContent = 'Este caso ya no está en el archivo.';
        list.replaceChildren();
        return;
      }
      showCase({ id: entry.id, name: entry.name, docs: entry.docs });
    } catch (err) {
      if (my !== listSeq) return;
      console.error(`[hospital] archive case ${id}: ${err.message}`);
      showView('list');
      statusEl.hidden = false;
      statusEl.textContent = 'No se pudo abrir el expediente.';
    }
  }

  function showCase(entry) {
    current = entry;
    showView('doc');
    title.textContent = 'EXPEDIENTE';
    docTitle.textContent = entry.name ?? '';
    resetPanes();
    const tabs = viewerTabs(entry.docs);
    tabsEl.replaceChildren();
    for (const t of tabs) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.dataset.kind = t.kind;
      b.textContent = t.label;
      b.addEventListener('click', () => showDoc(t.kind));
      b.addEventListener('keydown', (e) => moveTab(e, t.kind));
      tabsEl.appendChild(b);
    }
    const first = tabs.find((t) => t.kind === 'state') ?? tabs[0];
    if (first) showDoc(first.kind);
    else showNotice(NOT_AVAILABLE);
  }

  function moveTab(e, kind) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabBtns = [...tabsEl.querySelectorAll('[role="tab"]')];
    const i = tabBtns.findIndex((b) => b.dataset.kind === kind);
    const next = tabBtns[(i + (e.key === 'ArrowRight' ? 1 : tabBtns.length - 1)) % tabBtns.length];
    e.preventDefault();
    next.focus();
    showDoc(next.dataset.kind);
  }

  async function showDoc(kind) {
    if (!current) return;
    const my = ++docSeq;
    for (const b of tabsEl.querySelectorAll('[role="tab"]')) {
      const on = b.dataset.kind === kind;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    resetPanes();
    if (kind === SHOTS_TAB) {
      showGallery();
      return;
    }
    try {
      const d = await fetchDoc(fetchFn, current.id, kind);
      if (my !== docSeq) return;
      if (!d.found) {
        showNotice(NOT_AVAILABLE);
        return;
      }
      for (const b of d.banners) {
        const p = doc.createElement('p');
        p.className = `archive-banner ${b.tone}`;
        p.textContent = b.text;
        banners.appendChild(p);
      }
      pre.textContent = d.text;
      pre.hidden = false;
    } catch (err) {
      if (my !== docSeq) return;
      console.error(`[hospital] archive doc ${kind}: ${err.message}`);
      showNotice('No se pudo leer el documento.');
    }
  }

  img.addEventListener('error', () => {
    if (!img.getAttribute('src')) return; // cleared on purpose
    img.hidden = true;
    img.removeAttribute('src');
    showNotice(NOT_AVAILABLE);
  });

  // Keyboard: Escape closes; Tab stays inside the panel (aria-modal).
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...panel.querySelectorAll(FOCUSABLE)].filter((b) => !b.closest('[hidden]'));
    if (!items.length) return;
    const firstEl = items[0];
    const lastEl = items[items.length - 1];
    if (e.shiftKey && doc.activeElement === firstEl) {
      e.preventDefault();
      lastEl.focus();
    } else if (!e.shiftKey && doc.activeElement === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  });
  closeBtn.addEventListener('click', close);
  back.addEventListener('click', () => openList(null));
  shotPrev.addEventListener('click', () => showShot(shotIdx - 1));
  shotNext.addEventListener('click', () => showShot(shotIdx + 1));
  shotBack.addEventListener('click', () => {
    showGallery();
    thumbs.querySelector('button')?.focus();
  });

  return { openList, openCase, close, isOpen };
}
