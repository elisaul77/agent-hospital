// Parsers for the warning block of subagent handbacks (subagent-pool v9.12). Pure: no I/O, no DOM.
// Shapes checked on real SubagentHandback inputs (2026-10-18), anchored at line start, case-sensitive:
//   implementer:  `WARNINGS:` then bullets (`- `, `* `, `N.`); a `KEY:` line closes the block.
//                 `WARNINGS: none` or no line = zero warnings.
//   reviewer:     `WARNINGS_RULING:` then one `label: fixed|acceptable|must fix` line per item.
//                 Prose without a label separator is not a ruling, so its item stays open.
// PRIVACY: text is sanitized and cut to WARNING_TEXT_MAX; nothing else from the handback is kept.

export const WARNING_TEXT_MAX = 120;
export const WARNING_ITEMS_MAX = 20;

const KEY_RE = /^[A-Z][A-Z_]+:(\s|$)/;
const NONE_RE = /^none\.?$/i;
const BULLET_RE = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/;
// Optional bullet, then `label <sep> token`, or a bare token. Separators: colon, em/en dash, spaced hyphen.
const RULING_RE = /^\s*(?:[-*]|\d+[.)])?\s*(?:(.*?)\s*(?::|—|–|\s-\s)\s*)?(fixed|acceptable|must[ _]fix)\s*\.?\s*$/i;

export function sanitize(s, n = WARNING_TEXT_MAX) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
}

// A key line closes a block, unless it is itself a ruling such as `API: must fix`.
function isKeyLine(line) {
  return KEY_RE.test(line) && !RULING_RE.test(line);
}

// Lines after the header line, up to the next key line.
function blockAfter(lines, i) {
  const out = [];
  for (let j = i + 1; j < lines.length && !isKeyLine(lines[j]); j++) out.push(lines[j]);
  return out;
}

/**
 * @param {string} message the handback's final text
 * @returns {{items: string[]}} open warning texts (empty when there are none)
 */
export function warningsOf(message) {
  const lines = String(message ?? '').split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith('WARNINGS:'));
  if (i < 0) return { items: [] };
  const inline = sanitize(lines[i].slice('WARNINGS:'.length));
  const bullets = [];
  const plain = [];
  for (const line of blockAfter(lines, i)) {
    if (!line.trim()) continue;
    const b = BULLET_RE.exec(line);
    if (b) bullets.push(sanitize(b[1]));
    else if (bullets.length) bullets[bullets.length - 1] = sanitize(`${bullets[bullets.length - 1]} ${line}`);
    else plain.push(sanitize(line));
  }
  const raw = bullets.length
    ? [...(inline ? [inline] : []), ...bullets]
    : [sanitize([inline, ...plain].filter(Boolean).join(' '))];
  const items = raw.filter((t) => t && !NONE_RE.test(t)).slice(0, WARNING_ITEMS_MAX);
  return { items };
}

function normalizeRuling(token) {
  return token.toLowerCase().replace(/[ _]/, '_');
}

/**
 * @param {string} message the reviewer handback's final text
 * @returns {{index: number, label: string, ruling: 'fixed'|'acceptable'|'must_fix'}[]}
 *   index is the ordinal among ruling lines; label is '' for a bare token line
 */
export function rulingsOf(message) {
  const lines = String(message ?? '').split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith('WARNINGS_RULING:'));
  if (i < 0) return [];
  const body = [lines[i].slice('WARNINGS_RULING:'.length), ...blockAfter(lines, i)];
  const out = [];
  for (const line of body) {
    const m = RULING_RE.exec(line);
    if (!m) continue;
    out.push({ index: out.length, label: sanitize(m[1] ?? ''), ruling: normalizeRuling(m[2]) });
  }
  return out;
}
