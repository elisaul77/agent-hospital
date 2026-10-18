// Phase 5 (hospital-5b1): client helpers of the Archive room. Pure functions with a fake fetch; the DOM layer is
// covered by the headless-Chrome probe (not here, Docker has no browser). The grep gate keeps HTML strings out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchArchive, archiveRows, viewerTabs, docBanners, docUrl, fetchDoc, shotKinds, galleryItems, shotCaption, stepShot,
} from '../public/js/archive.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(here, '..', 'public', 'js', 'archive.js');
const ID = '0123456789abcdef';

const headersOf = (obj) => ({
  get(name) {
    const hit = Object.keys(obj).find((k) => k.toLowerCase() === name.toLowerCase());
    return hit === undefined ? null : obj[hit];
  },
});

// Fake fetch: records every call, answers from a queue of {status, body?, headers?, text?}.
function fakeFetch(...answers) {
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    const a = answers.shift();
    if (!a) throw new Error('fake fetch: no answer queued');
    return {
      ok: a.status >= 200 && a.status < 300,
      status: a.status,
      headers: headersOf(a.headers ?? {}),
      json: async () => a.body,
      text: async () => a.text ?? '',
    };
  };
  fn.calls = calls;
  return fn;
}

const CASE = (over) => ({
  id: ID, project: 'proj', name: 'alpha', status: 'IN_PROGRESS', tier: 'L', mtime: 1000, docs: [{ kind: 'state' }], live: false,
  ...over,
});

test('fetchArchive: one same-origin relative GET with no options and no custom headers', async () => {
  const f = fakeFetch({ status: 200, body: { cases: [], truncated: false } });
  await fetchArchive(f);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], ['/api/archive']);
});

test('fetchArchive: a refusal throws with the status (never a silent empty list)', async () => {
  await assert.rejects(fetchArchive(fakeFetch({ status: 421, body: {} })), /\/api\/archive 421/);
});

test('archiveRows: newest first by mtime, ties keep the server order, exact fields', async () => {
  const rows = archiveRows([
    CASE({ id: '1111111111111111', name: 'old', mtime: 100 }),
    CASE({ id: '2222222222222222', name: 'new', mtime: 900 }),
    CASE({ id: '3333333333333333', name: 'tie-a', mtime: 500 }),
    CASE({ id: '4444444444444444', name: 'tie-b', mtime: 500, live: true }),
  ]);
  assert.deepEqual(rows.map((r) => r.name), ['new', 'tie-a', 'tie-b', 'old']);
  assert.deepEqual(Object.keys(rows[0]), ['id', 'project', 'name', 'status', 'tier', 'mtime', 'live']);
  assert.equal(rows[2].live, true);
  assert.equal(rows[0].live, false);
});

test('archiveRows: a missing or non-numeric mtime sorts last instead of breaking the order', () => {
  const rows = archiveRows([CASE({ name: 'bad', mtime: undefined }), CASE({ name: 'good', mtime: 5 })]);
  assert.deepEqual(rows.map((r) => r.name), ['good', 'bad']);
});

test('archive list end to end with a fake fetch: order and the truncated flag survive', async () => {
  const f = fakeFetch({ status: 200, truncated: true, body: { truncated: true, cases: [CASE({ name: 'a', mtime: 1 }), CASE({ name: 'b', mtime: 2 })] } });
  const { cases, truncated } = await fetchArchive(f);
  assert.equal(truncated, true);
  assert.deepEqual(archiveRows(cases).map((r) => r.name), ['b', 'a']);
});

test('viewerTabs: state, plan, council docs (by council, then decisions, debate, brief), ONE Capturas tab; unknown kinds dropped', () => {
  const tabs = viewerTabs([
    { kind: 'shot-1' }, { kind: 'council-1-debate', label: 'hospital-5b1' }, { kind: 'state' }, { kind: 'bogus' },
    { kind: 'shot-0' }, { kind: 'council-0-brief', label: 'hospital-4b' }, { kind: 'plan' },
    { kind: 'council-0-decisions', label: 'hospital-4b' }, { kind: 'council-0-debate', label: 'hospital-4b' },
  ]);
  assert.deepEqual(tabs.map((t) => t.kind), [
    'state', 'plan', 'council-0-decisions', 'council-0-debate', 'council-0-brief', 'council-1-debate', 'shots',
  ]);
  assert.deepEqual(tabs.map((t) => t.label), [
    'Estado', 'Plan', 'Decisiones · hospital-4b', 'Debate · hospital-4b', 'Brief · hospital-4b', 'Debate · hospital-5b1', 'Capturas',
  ]);
});

test('viewerTabs: the council label is shown as given (textContent later); a missing label falls back to Consejo n', () => {
  const tabs = viewerTabs([{ kind: 'council-0-decisions', label: '<img src=x onerror=1>' }, { kind: 'council-1-debate' }]);
  assert.deepEqual(tabs.map((t) => t.label), ['Decisiones · <img src=x onerror=1>', 'Debate · Consejo 2']);
});

test('viewerTabs: a case with only its state file has one tab; no shots means no Capturas tab; no docs has none', () => {
  assert.deepEqual(viewerTabs([{ kind: 'state' }]).map((t) => t.label), ['Estado']);
  assert.deepEqual(viewerTabs([{ kind: 'state' }, { kind: 'council-0-debate', label: 'a' }]).map((t) => t.kind), ['state', 'council-0-debate']);
  assert.deepEqual(viewerTabs([]), []);
  assert.deepEqual(viewerTabs(undefined), []);
});

test('shotKinds: only shot-<n> kinds, numeric order, no duplicates', () => {
  assert.deepEqual(shotKinds([{ kind: 'shot-10' }, { kind: 'state' }, { kind: 'shot-2' }, { kind: 'shot-2' }, { kind: 'shot-0' }, { kind: 'shot-01' }]),
    ['shot-0', 'shot-2', 'shot-10']);
  assert.deepEqual(shotKinds([{ kind: 'council-0-decisions' }]), []);
  assert.deepEqual(shotKinds(undefined), []);
});

test('galleryItems: one thumbnail per shot with its same-origin URL and label; a bad case id gives none', () => {
  const items = galleryItems(ID, [{ kind: 'shot-1' }, { kind: 'shot-0' }]);
  assert.deepEqual(items, [
    { kind: 'shot-0', label: 'Captura 1', url: `/api/doc?case=${ID}&doc=shot-0` },
    { kind: 'shot-1', label: 'Captura 2', url: `/api/doc?case=${ID}&doc=shot-1` },
  ]);
  assert.deepEqual(galleryItems('../etc', [{ kind: 'shot-0' }]), []);
});

test('stepShot: clamps to the gallery (no wrap), empty gallery gives -1; shotCaption is "n / total" or empty', () => {
  assert.equal(stepShot(0, -1, 3), 0);
  assert.equal(stepShot(2, 1, 3), 2);
  assert.equal(stepShot(1, 1, 3), 2);
  assert.equal(stepShot(-1, 1, 3), 0, 'from the grid, first step lands on the first shot');
  assert.equal(stepShot(0, 1, 0), -1);
  assert.equal(shotCaption(1, 3), '2 / 3');
  assert.equal(shotCaption(0, 0), '');
});

test('docBanners: no redaction and no truncation means no banner', () => {
  assert.deepEqual(docBanners(headersOf({ 'X-Redacted-Count': '0', 'X-Truncated': 'false' })), []);
  assert.deepEqual(docBanners(headersOf({})), [], 'image responses carry no text headers');
});

test('docBanners: redaction shows the count and the best-effort warning (singular and plural)', () => {
  const one = docBanners(headersOf({ 'X-Redacted-Count': '1', 'X-Truncated': 'false' }));
  assert.deepEqual(one.map((b) => b.text), ['1 secreto tapado — protección parcial']);
  assert.equal(one[0].tone, 'warn');
  const three = docBanners(headersOf({ 'X-Redacted-Count': '3', 'X-Truncated': 'false' }));
  assert.deepEqual(three.map((b) => b.text), ['3 secretos tapados — protección parcial']);
});

test('docBanners: truncation has its own notice; both flags give two banners in order', () => {
  const t = docBanners(headersOf({ 'X-Redacted-Count': '0', 'X-Truncated': 'true' }));
  assert.equal(t.length, 1);
  assert.match(t[0].text, /recortado/);
  const both = docBanners(headersOf({ 'X-Redacted-Count': '2', 'X-Truncated': 'true' }));
  assert.equal(both.length, 2);
  assert.match(both[0].text, /secretos tapados/);
  assert.match(both[1].text, /recortado/);
});

test('docBanners: an unreadable count header is a warning, never silently zero', () => {
  const bad = docBanners(headersOf({ 'X-Redacted-Count': 'abc', 'X-Truncated': 'false' }));
  assert.equal(bad.length, 1);
  assert.equal(bad[0].tone, 'warn');
});

test('docUrl: opaque id and fixed kind only; anything else is refused (null)', () => {
  assert.equal(docUrl(ID, 'state'), `/api/doc?case=${ID}&doc=state`);
  assert.equal(docUrl(ID, 'shot-0'), `/api/doc?case=${ID}&doc=shot-0`);
  for (const [id, kind] of [['../etc', 'state'], [ID.toUpperCase(), 'state'], [ID, 'plan/../x'], [ID, 'shot-100'], [ID, 'state&x=1']]) {
    assert.equal(docUrl(id, kind), null, `${id} ${kind}`);
  }
});

test('docUrl: council kinds are council-<n>-<type> only; bare legacy kinds and out-of-shape indexes are refused', () => {
  assert.equal(docUrl(ID, 'council-1-brief'), `/api/doc?case=${ID}&doc=council-1-brief`);
  for (const kind of ['decisions', 'debate', 'council-20-decisions', 'council-01-debate', 'council-0-state', 'council-../x-debate']) {
    assert.equal(docUrl(ID, kind), null, kind);
  }
});

test('fetchDoc: 404 is "no disponible" (found false), 200 returns text and banners, 500 throws', async () => {
  assert.deepEqual(await fetchDoc(fakeFetch({ status: 404, body: {} }), ID, 'plan'), { found: false });
  const ok = await fetchDoc(fakeFetch({ status: 200, text: '<b>x</b>', headers: { 'X-Redacted-Count': '1', 'X-Truncated': 'false' } }), ID, 'council-0-debate');
  assert.equal(ok.found, true);
  assert.equal(ok.text, '<b>x</b>');
  assert.equal(ok.banners.length, 1);
  await assert.rejects(fetchDoc(fakeFetch({ status: 500, body: {} }), ID, 'state'), /\/api\/doc state 500/);
  await assert.rejects(fetchDoc(fakeFetch(), ID, '../state'), /doc/);
});

test('grep gate: the client never builds HTML from strings (textContent / DOM nodes only)', () => {
  const src = fs.readFileSync(CLIENT, 'utf8');
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'srcdoc']) {
    assert.equal(src.includes(bad), false, bad);
  }
});
