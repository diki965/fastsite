// fastsite: a faster drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build returns
// for the same input: every page's index.html, the index and tag pages,
// build-report.txt and each static file, byte for byte. It is written from
// makefun-site's own README (its front matter, template dialect, Markdown
// subset, slug rule and report), reimplemented here as one straight pipeline:
//
//   - the Markdown renderer walks each body's lines once and writes HTML
//     straight into the output, instead of lexing into token objects and
//     rendering them afterwards;
//   - the inline renderer scans for the next interesting character with one
//     regex and copies the plain runs between them untouched, instead of
//     escaping the body one character at a time;
//   - slug and date words are cached (titles, tags and headings repeat
//     across a site), and word counts are a single scan;
//   - each template is parsed once and compiled to a small function, so
//     rendering a page is straight code instead of a tree walk with a scope
//     lookup per value.
//
// Nothing here reads a clock, the environment, randomness or a file: the
// output is a function of the input alone, as makefun-site's is.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped, and nothing else. */
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** The slug of `text`, exactly as makefun-site spells it (see its README, "Text"). */
function slugifySlow(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  // ASCII text is unchanged by the normalisation, so skip both steps for it.
  const src = plain === text ? text : plain;
  let out = '';
  let gap = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

// Titles, tags and headings repeat across a site (and across the cases of
// one run), so their slugs are worth remembering. The cache is a pure
// function of its inputs, so it cannot change an answer.
const slugCache = new Map();
function slugify(text) {
  let r = slugCache.get(text);
  if (r === undefined) {
    r = slugifySlow(text);
    if (slugCache.size < 65536) slugCache.set(text, r);
  }
  return r;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
const dateCache = new Map();
function longDate(date) {
  let r = dateCache.get(date);
  if (r === undefined) {
    const y = date.slice(0, 4);
    const m = MONTHS[Number(date.slice(5, 7)) - 1];
    const d = Number(date.slice(8, 10));
    r = `${d} ${m} ${y}`;
    if (dateCache.size < 8192) dateCache.set(date, r);
  }
  return r;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

const FM_BLANK = /^[ \t]*$/;

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `lines` is the source's text, line ends "\n",
 * split on "\n". The body is returned as the lines after the closing "---".
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (FM_BLANK.test(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1) };
}

// ---------------------------------------------------------------- Markdown

const MD_BLANK = /^[ \t]*$/;
const MD_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const MD_FENCE_CLOSE = /^```[ \t]*$/;
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const MD_HR = /^(?:---|\*\*\*)[ \t]*$/;
const MD_BULLET = /^[-*] (.*)$/;
const MD_ORDERED = /^(\d{1,9})\. (.*)$/;
const MD_CONTINUED = /^ {2,}\S/;
const MD_TRIM = /^[ \t]+|[ \t]+$/g;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = MD_HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return MD_BLANK.test(line);
  if (c === 96) return MD_FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return MD_HR.test(line);
  return false;
}

/** A line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  const n = line.length;
  if (n === 0) return line;
  // Most lines are already trimmed; only then touch the regex.
  const f = line.charCodeAt(0);
  const l = line.charCodeAt(n - 1);
  if (f !== 32 && f !== 9 && l !== 32 && l !== 9) return line;
  return line.replace(MD_TRIM, '');
}

// --- inline rendering -------------------------------------------------

// Every character the inline renderer must stop at: a backslash escape, a
// code span, strong, emphasis or a link, and the five HTML escapables.
// The scan below only ever lands on one of these, so the plain text between
// two stops holds nothing that needs escaping and is copied as it is.
const SPECIAL = /[\\`*\[&<>"']/g;

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** Whether the character at `pos` is escaped by an odd run of backslashes before it. */
function isEscaped(s, pos) {
  let n = 0;
  for (let p = pos - 1; p >= 0 && s[p] === '\\'; p--) n++;
  return (n % 2) === 1;
}

/** The first unescaped `**` at or after `from`, or -1. */
function findStrongClose(s, from) {
  let k = s.indexOf('**', from);
  while (k !== -1 && isEscaped(s, k)) k = s.indexOf('**', k + 1);
  return k;
}

/** The first single `*` at or after `from` (one whose run is not `**`), outside an escape, or -1. */
function findEmClose(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    if (isEscaped(s, j)) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s[j + 1] === '*') {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/** The first unescaped `]` at or after `from`, or -1. */
function findBracketClose(s, from) {
  let k = s.indexOf(']', from);
  while (k !== -1 && isEscaped(s, k)) k = s.indexOf(']', k + 1);
  return k;
}

const WS_IN_TARGET = /\s/;

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    SPECIAL.lastIndex = i;
    const m = SPECIAL.exec(s);
    if (m === null) {
      out += s.slice(i);
      break;
    }
    const j = m.index;
    if (j > i) out += s.slice(i, j);
    const c = s[j];
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      out += ESCAPES[c];
      i = j + 1;
      continue;
    }
    if (c === '\\') {
      const d = s[j + 1];
      if (d !== undefined && ESCAPABLE.has(d)) {
        out += ESCAPES[d] || d;
        i = j + 2;
      } else {
        out += '\\';
        i = j + 1;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += `<code>${escapeHtml(s.slice(j + 1, k))}</code>`;
        i = k + 1;
      } else {
        out += '`';
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findStrongClose(s, j + 2);
        if (k > j + 2) {
          out += `<strong>${inline(s.slice(j + 2, k), env)}</strong>`;
          i = k + 2;
        } else {
          out += '**';
          i = j + 2;
        }
        continue;
      }
      const k = findEmClose(s, j + 1);
      if (k > j + 1) {
        out += `<em>${inline(s.slice(j + 1, k), env)}</em>`;
        i = k + 1;
      } else {
        out += '*';
        i = j + 1;
      }
      continue;
    }
    // c === '['
    const k = findBracketClose(s, j + 1);
    if (k !== -1 && s[k + 1] === '(') {
      const mm = s.indexOf(')', k + 2);
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !WS_IN_TARGET.test(target)) {
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k), env)}</a>`;
        i = mm + 1;
        continue;
      }
    }
    out += '[';
    i = j + 1;
  }
  return out;
}

// --- block rendering --------------------------------------------------

/**
 * `lines` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or ""). `env.link(target)` resolves
 * a link's href. Heading ids are unique within this page (`ids`).
 */
function renderMarkdown(lines, env) {
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    // A line's first character decides what it can be: a fence opens on
    // "`", a heading on "#", a break or a bullet on "-" or "*", a quote on
    // ">", an ordered list on a digit, a blank or indented line on a space
    // or tab — anything else is a paragraph line, no regex needed.
    if (c0 === 32 || c0 === 9) {
      if (MD_BLANK.test(line)) {
        i++;
        continue;
      }
    } else if (c0 !== 96 && c0 !== 35 && c0 !== 45 && c0 !== 42 && c0 !== 62 && !(c0 >= 48 && c0 <= 57)) {
      // A paragraph: this line and the lines after it up to a blank line, a
      // fence, a heading or a thematic break.
      const parts = [trimLine(line)];
      i++;
      while (i < n && !endsParagraph(lines[i])) parts.push(trimLine(lines[i++]));
      const html = inline(parts.join('\n'), env);
      if (excerpt === null) excerpt = html;
      out.push(`<p>${html}</p>\n`);
      continue;
    }
    let m = c0 === 96 ? MD_FENCE_OPEN.exec(line) : null;
    if (m !== null) {
      const lang = m[1];
      let j = i + 1;
      while (j < n && !MD_FENCE_CLOSE.test(lines[j])) j++;
      // The body's lines, each escaped and ended in "\n": escaping the
      // joined text is the same, since escaping never touches "\n".
      const body = lines.slice(i + 1, j);
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      out.push(`<pre><code${cls}>${body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`}</code></pre>\n`);
      i = j + 1;
      continue;
    }
    const heading = c0 === 35 ? headingOf(line) : null;
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      out.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if ((c0 === 45 || c0 === 42) && MD_HR.test(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (c0 === 62) {
      // A blockquote: the lines opening on ">".
      const parts = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const t = trimLine(lines[i].replace(/^> ?/, ''));
        if (t !== '') parts.push(t);
        i++;
      }
      out.push(parts.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(parts.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    const bullet = (c0 === 45 || c0 === 42) ? MD_BULLET.exec(line) : null;
    const ordered = bullet === null && c0 >= 48 && c0 <= 57 ? MD_ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? MD_ORDERED : MD_BULLET;
      const start = isOrdered ? Number(ordered[1]) : 1;
      const items = [];
      while (i < n) {
        const mm = marker.exec(lines[i]);
        if (mm !== null) {
          items.push(trimLine(isOrdered ? mm[2] : mm[1]));
          i++;
        } else if (MD_CONTINUED.test(lines[i])) {
          items[items.length - 1] += `\n${trimLine(lines[i])}`;
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let html = `${open}\n`;
      for (const item of items) html += `<li>${inline(item, env)}</li>\n`;
      out.push(`${html}</${tag}>\n`);
      continue;
    }
    // A paragraph: this line and the lines after it up to a blank line, a
    // fence, a heading or a thematic break.
    const parts = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) parts.push(trimLine(lines[i++]));
    const html = inline(parts.join('\n'), env);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// --- compiling a parsed template to a function --------------------------

// A value as text: a string itself, a number in JavaScript's digits, true or
// false, an array's items joined by ", ", else "".
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += textOf(v[i]);
    }
    return s;
  }
  return '';
}

// Whether a value counts as true in an if: not undefined, null, false, "",
// 0 or an empty array.
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// One more segment of a path: an own property of the value so far, or undefined.
function seg(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

// The scope a template renders in: the values a page gives it, then one
// object per loop around it, each holding that loop's element and `loop`.
// Scopes are linked by prototype, so reading a name finds the innermost
// loop that binds it, else the page's values — and, every scope being built
// on a null prototype, a name nothing binds reads undefined.

/** JavaScript for the value at `path` in the scope `scope`. */
function pathExpr(path, scope) {
  let e = `${scope}.${path[0]}`;
  for (let k = 1; k < path.length; k++) e = `seg(${e},${JSON.stringify(path[k])})`;
  return e;
}

/**
 * The body of a render function for `nodes`, written into `lines`.
 * `scope` is the JavaScript name of the scope object the body reads from;
 * `uid` hands out fresh variable names. The function returns a string and
 * takes (S, D, esc, txt, truthy, seg, T): the scope, the include depth,
 * the value helpers and the template map — all of them are passed on at
 * every include, so a template included from another still sees them.
 */
function compileBody(nodes, scope, uid, lines) {
  for (const n of nodes) {
    if (n.kind === 'text') {
      lines.push(`o+=${JSON.stringify(n.text)};`);
    } else if (n.kind === 'var') {
      lines.push(`o+=esc(txt(${pathExpr(n.path, scope)}));`);
    } else if (n.kind === 'raw') {
      lines.push(`o+=txt(${pathExpr(n.path, scope)});`);
    } else if (n.kind === 'if') {
      const cond = n.not ? `!truthy(${pathExpr(n.path, scope)})` : `truthy(${pathExpr(n.path, scope)})`;
      lines.push(`if(${cond}){`);
      compileBody(n.then, scope, uid, lines);
      if (n.else !== null) {
        lines.push('}else{');
        compileBody(n.else, scope, uid, lines);
      }
      lines.push('}');
    } else if (n.kind === 'for') {
      const xs = `X${uid.n++}`;
      const sc = `S${uid.n++}`;
      const lp = `L${uid.n++}`;
      const k = `K${uid.n++}`;
      lines.push(`{const ${xs}=${pathExpr(n.path, scope)};if(Array.isArray(${xs})){const ${sc}=Object.create(${scope});const ${lp}={index:0,first:false,last:false,length:${xs}.length};${sc}.loop=${lp};for(let ${k}=0;${k}<${xs}.length;${k}++){${sc}${n.name === 'loop' ? '' : `.${n.name}=${xs}[${k}];`}${lp}.index=${k}+1;${lp}.first=${k}===0;${lp}.last=${k}===${xs}.length-1;`);
      compileBody(n.body, sc, uid, lines);
      lines.push('}}}');
    } else if (n.kind === 'include') {
      lines.push(`if(D<${INCLUDE_DEPTH}){const F=T.get(${JSON.stringify(n.name)});if(F!==undefined)o+=F(${scope},D+1,esc,txt,truthy,seg,T);}`);
    }
  }
}

// A parsed template's render function is built where the templates are
// compiled (in build(), below): `new Function` returns a function of
// (S, D, esc, txt, truthy, seg, T) — the scope, the include depth, the
// value helpers and the template map — and the render call passes all seven.

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * A compiled render function depends only on its template's text — the
 * value helpers and the template map arrive as parameters — so one is
 * shared by every case that uses the same text, across a whole run. A
 * template that does not parse is never cached: each case reports its own
 * failures under its own names.
 */
const TEMPLATE_CACHE = new Map();

/** One site's output tree: path -> text. */
export function run(input) {
  // Templates, parsed in code-unit order of their name; one that does not
  // parse is reported and left out.
  const report = [];
  const T = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    const text = input.templates[name];
    let f = TEMPLATE_CACHE.get(text);
    if (f === undefined) {
      let nodes;
      try {
        nodes = parseTemplate(name, text);
      } catch (err) {
        if (!(err instanceof TemplateError)) throw err;
        report.push(err.message);
        continue;
      }
      // Each parsed template compiled to a render function
      // (S, D, esc, txt, truthy, seg, T) => string, sharing this case's
      // template map and value helpers through its parameters.
      const lines = ['let o="";'];
      compileBody(nodes, 'S', { n: 0 }, lines);
      lines.push('return o;');
      f = new Function('S', 'D', 'esc', 'txt', 'truthy', 'seg', 'T', lines.join('\n'));
      TEMPLATE_CACHE.set(text, f);
    }
    T.set(name, f);
  }
  const render = (name, scope) => {
    const f = T.get(name);
    return f === undefined ? null : f(scope, 0, escapeHtml, textOf, truthy, seg, T);
  };

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      sources.push({ path: f.path, lines: text.split('\n') });
    } else statics.push(f);
  }

  // 2. Each source's front matter, in that order; a refused source, a
  // source under the generator's own directories, a post with no date, a
  // source whose layout is no template that parses, and a draft are
  // reported and dropped, the first failure the one reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!T.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url, its slug unique in its directory.
  const bySource = new Map();
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const env = {
      link: (target) => {
        if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${srcPath} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    // The body's words, counted over its lines: a line break is whitespace,
    // so no word ever spans two lines.
    let w = 0;
    for (const ln of s.body) {
      let inWord = false;
      for (let q = 0; q < ln.length; q++) {
        const c = ln.charCodeAt(q);
        const ws =
          c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
          c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
          c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
          c === 0x3000 || c === 0xfeff;
        if (ws) inWord = false;
        else if (!inWord) {
          inWord = true;
          w++;
        }
      }
    }
    s.readingMinutes = Math.max(1, Math.ceil(w / 200));
  }

  // 5. The posts, newest first and then by slug; each post's neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
    p.newerLink = linkOf(p.newer);
    p.olderLink = linkOf(p.older);
  });

  // 6. The tags, grouped by their slug, each named as first met in the
  // posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages
  // through theirs, then each static file at its own path.
  //
  // A card's tag list, a page's table of contents and its neighbours are
  // the same at every render of that source, so they are built once here
  // and shared; a template only ever reads them.
  for (const s of kept) {
    s.tagCards = s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url }));
    s.tocCards = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
  }
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagCards,
  });
  const pageOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagCards,
    slug: s.slug,
    content: s.html,
    toc: s.tocCards,
    newer: s.post ? s.newerLink : null,
    older: s.post ? s.olderLink : null,
    is_post: s.post,
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  // One scope object for the case's renders, its page variables reset
  // before each render: rendering is synchronous, and a loop or include
  // only ever reads the scope it runs in, so nothing a render leaves
  // behind can reach the next one.
  const rootScope = Object.create(null);
  rootScope.site = site;
  rootScope.tags = allTags;
  rootScope.recent = recent;
  const scopeOf = (vars) => {
    rootScope.page = undefined;
    rootScope.posts = undefined;
    rootScope.pager = undefined;
    rootScope.tag = undefined;
    for (const k of Object.keys(vars)) rootScope[k] = vars[k];
    return rootScope;
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, scopeOf({ page: pageOf(s) }));
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', scopeOf({
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    }));
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', scopeOf({
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    }));
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', scopeOf({}));
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pagesBuilt = kept.filter((s) => !s.post).length;
  lines.push(`built ${pagesBuilt} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
