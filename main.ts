// main.ts is mend, the CLI SPEC.md specifies (MIT). It does all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, line matching at three tiers, unified diffs, SEARCH/REPLACE blocks,
// V4A patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines, its own line break and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  brk: string;
  ends: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], brk: '\n', ends: false };
  const nl = text.indexOf('\n');
  const brk = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const ends = text.endsWith(brk);
  const parts = text.split(brk);
  if (ends) parts.pop();
  return { lines: parts, brk, ends };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.brk) + (f.ends ? f.brk : '');
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const onlyWs = (s: string): boolean => /^[ \t]*$/.test(s);

/** Line equality at one matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/** Every 0-based position where O matches the file's lines at the tier, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!lineEq(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 when strict) at which O occurs at least once. */
function firstTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { from: string; to: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** One body line of a unified hunk or a V4A chunk. `empty` marks a patch line that was exactly empty. */
interface BodyItem {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  empty: boolean;
}

function bodyItem(line: string): BodyItem {
  if (line === '') return { kind: 'ctx', text: '', empty: true };
  const c = line[0]!;
  if (c === ' ') return { kind: 'ctx', text: line.slice(1), empty: false };
  if (c === '-') return { kind: 'del', text: line.slice(1), empty: false };
  if (c === '+') return { kind: 'add', text: line.slice(1), empty: false };
  return { kind: 'bs', text: line.slice(1), empty: false };
}

/**
 * The lines that replace the matched lines at `pos`: a context line is the file's own matched line, never the
 * patch's; at tier 2 every other line is re-indented from O's first line's leading whitespace to the file's
 * first matched line's (SPEC.md section 5). `o` is the matched old lines, `items` the hunk or chunk body.
 */
function replacement(fileLines: string[], pos: number, items: BodyItem[], o: string[], tier: number): string[] {
  const out: string[] = [];
  const P = leadWs(o[0] ?? '');
  const F = leadWs(fileLines[pos] ?? '');
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (it.kind === 'del') {
      oi += 1;
    } else if (it.kind === 'add') {
      let t = it.text;
      if (tier === 2 && t !== '' && !onlyWs(t) && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Unified diffs (SPEC.md section 6) ----

interface UHunk {
  oldStart: number;
  items: BodyItem[];
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  /** A `--- `/`+++ ` pair named the paths, so `rename from/to` does not override them. */
  hasHeaderPair: boolean;
  hunks: UHunk[];
}

/** A `--- ` or `+++ ` header path: text after the four characters, up to the first tab, trimmed, with a
 * leading `a/` or `b/` removed (SPEC.md section 6). */
function headerPath(line: string): string {
  const t = line.slice(4).split('\t')[0]!.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let sec: USection | null = null;
  let state: 'out' | 'header' | 'body' = 'out';
  let hunk: UHunk | null = null;
  const flushHunk = (): void => {
    if (hunk !== null && sec !== null) {
      // Empty lines at the end of a hunk body are not part of it; a line that is a single space is a real
      // context line with empty text and stays.
      while (hunk.items.length > 0 && hunk.items[hunk.items.length - 1]!.kind === 'ctx' && hunk.items[hunk.items.length - 1]!.empty) hunk.items.pop();
      sec.hunks.push(hunk);
    }
    hunk = null;
  };
  const startSection = (oldP: string | null, newP: string | null): void => {
    sec = { oldPath: oldP, newPath: newP, newFile: false, deletedFile: false, hasHeaderPair: false, hunks: [] };
    sections.push(sec);
    state = 'header';
  };
  const parseDiffGit = (line: string, i: number): [string, string] => {
    const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    return [m[1]!, m[2]!];
  };
  const hunkAt = (line: string, i: number): UHunk => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    return { oldStart: parseInt(m[1]!, 10), items: [] };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      if (state === 'body') flushHunk();
      const [a, b] = parseDiffGit(line, i);
      startSection(a, b);
      continue;
    }
    if (state === 'out') {
      if (line.startsWith('--- ')) {
        const next = lines[i + 1] ?? '';
        if (next.startsWith('+++ ')) {
          startSection(headerPath(line) === '/dev/null' ? null : headerPath(line), headerPath(next) === '/dev/null' ? null : headerPath(next));
          i++;
        }
        // Otherwise prose outside a section: ignored.
      }
      continue;
    }
    if (state === 'header') {
      if (line.startsWith('--- ')) {
        const next = lines[i + 1] ?? '';
        if (!next.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        const p = headerPath(line);
        sec!.oldPath = p === '/dev/null' ? null : p;
        const q = headerPath(next);
        sec!.newPath = q === '/dev/null' ? null : q;
        sec!.hasHeaderPair = true;
        i++;
        continue;
      }
      if (line.startsWith('+++ ')) {
        const p = headerPath(line);
        sec!.newPath = p === '/dev/null' ? null : p;
        sec!.hasHeaderPair = true;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (!sec!.hasHeaderPair) sec!.oldPath = line.slice('rename from '.length);
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!sec!.hasHeaderPair) sec!.newPath = line.slice('rename to '.length);
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec!.newFile = true;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec!.deletedFile = true;
        continue;
      }
      if (line.startsWith('@@')) {
        if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
        state = 'body';
        hunk = hunkAt(line, i);
        continue;
      }
      // index / old mode / new mode / similarity index / dissimilarity index / Index: and any other line: ignored.
      continue;
    }
    // state === 'body'
    if (line.startsWith('diff --git ')) {
      flushHunk();
      const [a, b] = parseDiffGit(line, i);
      startSection(a, b);
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        flushHunk();
        startSection(headerPath(line) === '/dev/null' ? null : headerPath(line), headerPath(next) === '/dev/null' ? null : headerPath(next));
        i++;
        continue;
      }
      // A `--- ` line that is not a section header ends the body: it is outside the body, ignored.
      flushHunk();
      state = 'out';
      continue;
    }
    if (line.startsWith('@@')) {
      flushHunk();
      hunk = hunkAt(line, i);
      continue;
    }
    if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
      hunk!.items.push(bodyItem(line));
      continue;
    }
    flushHunk();
    state = 'out';
  }
  if (state === 'body') flushHunk();
  return sections;
}

/** Is there a `\` line after the hunk's last context or `+` line? It removes the final line break. */
function backslashAfterLast(items: BodyItem[]): boolean {
  let last = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.kind === 'ctx' || items[i]!.kind === 'add') last = i;
  }
  if (last < 0) return false;
  return items.slice(last + 1).some((it) => it.kind === 'bs');
}

function applyHunks(before: string, hunks: UHunk[], strict: boolean, failPath: string): string {
  const f = splitFile(before);
  const lines = f.lines;
  let ends = f.ends;
  let d = 0;
  for (const h of hunks) {
    let oLen = 0;
    let nLen = 0;
    const o: string[] = [];
    for (const it of h.items) {
      if (it.kind === 'ctx') {
        o.push(it.text);
        oLen++;
        nLen++;
      } else if (it.kind === 'del') {
        o.push(it.text);
        oLen++;
      } else if (it.kind === 'add') {
        nLen++;
      }
    }
    if (oLen > 0) {
      const found = firstTier(lines, o, strict);
      if (found === null) throw new Fail('no-match', failPath);
      const target = h.oldStart - 1 + d;
      let pos = found.pos[0]!;
      let best = Math.abs(pos - target);
      for (const p of found.pos) {
        const dd = Math.abs(p - target);
        if (dd < best) {
          best = dd;
          pos = p;
        }
      }
      const atEnd = pos + oLen === lines.length;
      const repl = replacement(lines, pos, h.items, o, found.tier);
      lines.splice(pos, oLen, ...repl);
      if (atEnd) ends = !backslashAfterLast(h.items);
      d += nLen - oLen;
    } else {
      const p = Math.min(Math.max(h.oldStart + d, 0), lines.length);
      const repl = h.items.filter((it) => it.kind === 'add').map((it) => it.text);
      lines.splice(p, 0, ...repl);
      if (p === lines.length) ends = !backslashAfterLast(h.items);
      d += repl.length;
    }
  }
  return joinFile({ lines, brk: f.brk, ends });
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((sec) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = oldP === null || sec.newFile;
    const isDelete = newP === null || sec.deletedFile;
    const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
    return (tree: Tree): void => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      if (isCreate) {
        const target = newP ?? oldP!;
        if (oldP === null && newP === null) throw new Fail('unsafe', '/dev/null');
        if (tree.get(target) !== null) throw new Fail('exists', target);
        const addLines: string[] = [];
        for (const h of sec.hunks) for (const it of h.items) if (it.kind === 'add') addLines.push(it.text);
        let noBreak = false;
        for (const h of sec.hunks) if (backslashAfterLast(h.items)) noBreak = true;
        tree.now.set(target, addLines.length === 0 ? '' : addLines.join('\n') + (noBreak ? '' : '\n'));
        return;
      }
      if (isDelete) {
        const target = oldP!;
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
        return;
      }
      if (isMove) {
        const before = tree.get(oldP!);
        if (before === null) throw new Fail('missing', oldP!);
        if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
        const result = applyHunks(before, sec.hunks, strict, oldP!);
        tree.now.set(newP!, result);
        tree.now.set(oldP!, null);
        tree.moves.push({ from: oldP!, to: newP! });
        return;
      }
      const target = oldP!;
      const before = tree.get(target);
      if (before === null) throw new Fail('missing', target);
      tree.now.set(target, applyHunks(before, sec.hunks, strict, target));
    };
  });
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const start = lines.findIndex((l, k) => k >= i && l.trimEnd() === '<<<<<<< SEARCH');
    if (start < 0) break;
    // Path: the nearest non-blank line before SEARCH, after the previous block's REPLACE (or the patch
    // start), that does not start with three backticks; otherwise the previous block's path.
    let path: string | null = null;
    for (let j = start - 1; j >= i; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
      else throw new Exit2(`error: parse ${start + 1}`);
    }
    const eq = lines.findIndex((l, k) => k > start && l.trimEnd() === '=======');
    if (eq < 0) throw new Exit2(`error: parse ${start + 1}`);
    const end = lines.findIndex((l, k) => k > eq && l.trimEnd() === '>>>>>>> REPLACE');
    if (end < 0) throw new Exit2(`error: parse ${start + 1}`);
    blocks.push({ path, oldLines: lines.slice(start + 1, eq), newLines: lines.slice(eq + 1, end) });
    i = end + 1;
  }
  return blocks;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  return parseSearchReplace(lines).map((b) => {
    return (tree: Tree): void => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(b.path);
      if (before === null) throw new Fail('missing', b.path);
      const f = splitFile(before);
      const found = firstTier(f.lines, b.oldLines, strict);
      if (found === null) throw new Fail('no-match', b.path);
      if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
      const pos = found.pos[0]!;
      const items = b.newLines.map((t): BodyItem => ({ kind: 'add', text: t, empty: false }));
      const repl = replacement(f.lines, pos, items, b.oldLines, found.tier);
      const out = f.lines.slice();
      out.splice(pos, b.oldLines.length, ...repl);
      tree.now.set(b.path, joinFile({ lines: out, brk: f.brk, ends: f.ends }));
    };
  });
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

const isV4aSection = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function applyV4aChunks(before: string, chunks: VChunk[], strict: boolean, failPath: string): string {
  const f = splitFile(before);
  const lines = f.lines;
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let anchorIdx = -1;
      for (const t of strict ? [0] : [0, 1, 2]) {
        for (let i = cursor; i < lines.length; i++) {
          if (lineEq(lines[i]!, ch.anchor, t)) {
            anchorIdx = i;
            break;
          }
        }
        if (anchorIdx >= 0) break;
      }
      if (anchorIdx < 0) throw new Fail('no-match', failPath);
      cursor = anchorIdx + 1;
    }
    let oLen = 0;
    const o: string[] = [];
    for (const it of ch.items) {
      if (it.kind === 'ctx') {
        o.push(it.text);
        oLen++;
      } else if (it.kind === 'del') {
        o.push(it.text);
        oLen++;
      }
    }
    if (oLen > 0) {
      const found = firstTier(lines, o, strict, cursor);
      if (found === null) throw new Fail('no-match', failPath);
      let pos = found.pos[0]!;
      if (ch.eof) {
        const atEnd = found.pos.find((p) => p + oLen === lines.length);
        if (atEnd === undefined) throw new Fail('no-match', failPath);
        pos = atEnd;
      }
      const repl = replacement(lines, pos, ch.items, o, found.tier);
      lines.splice(pos, oLen, ...repl);
      cursor = pos + repl.length;
    } else {
      const p = ch.eof ? lines.length : cursor;
      const repl = ch.items.filter((it) => it.kind === 'add').map((it) => it.text);
      lines.splice(p, 0, ...repl);
      cursor = p + repl.length;
    }
  }
  return joinFile({ lines, brk: f.brk, ends: f.ends });
}

function v4aUpdateEdit(path: string, moveTo: string | undefined, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const result = applyV4aChunks(before, chunks, strict, path);
    if (moveTo !== undefined) {
      tree.now.set(moveTo, result);
      tree.now.set(path, null);
      tree.moves.push({ from: path, to: moveTo });
    } else {
      tree.now.set(path, result);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    // The section runs to the next section or *** End Patch; blank lines at its end are not part of it
    // (a line of spaces is blank, so it is dropped here rather than becoming a context line).
    let end = i + 1;
    while (end < last && !isV4aSection(lines[end]!)) end++;
    while (end > i + 1 && blank(lines[end - 1]!)) end--;
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const fileLines: string[] = [];
      for (let j = i + 1; j < end; j++) {
        const l = lines[j]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      i = end;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      for (let j = i + 1; j < end; j++) {
        if (blank(lines[j]!)) continue;
        throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      i = end;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const secLine = i + 1;
      let j = i + 1;
      let moveTo: string | undefined;
      if (j < end && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j++;
      }
      const chunks: VChunk[] = [];
      let chunk: VChunk | null = null;
      const endChunk = (): void => {
        if (chunk !== null) {
          chunks.push(chunk);
          chunk = null;
        }
      };
      while (j < end) {
        const l = lines[j]!;
        if (l.startsWith('@@')) {
          endChunk();
          chunk = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, items: [] };
          j++;
          continue;
        }
        if (l === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${j + 1}`);
          chunk.eof = true;
          endChunk();
          j++;
          continue;
        }
        if (l === '') {
          if (chunk !== null) chunk.items.push({ kind: 'ctx', text: '', empty: true });
          j++;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (chunk === null) {
            if (chunks.length === 0) chunk = { anchor: null, eof: false, items: [] };
            else throw new Exit2(`error: parse ${j + 1}`);
          }
          chunk!.items.push(bodyItem(l));
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      endChunk();
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${secLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---- The run (SPEC.md sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const covered = new Set<string>();
  for (const m of tree.moves) {
    if (tree.original(m.from) !== null && tree.get(m.from) === null && tree.original(m.to) === null && tree.get(m.to) !== null) {
      rows.push({ key: m.to, text: `R ${m.from} -> ${m.to}` });
      covered.add(m.from);
      covered.add(m.to);
    }
  }
  const touched = [...tree.now.keys()].sort(byteCmp);
  for (const p of touched) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!check) {
    for (const p of touched) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
