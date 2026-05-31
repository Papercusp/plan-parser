/**
 * Pure plan-document parser.
 *
 * file bytes → { frontmatter, now, items, decisions, ... }
 *
 * Conventions per
 *   apps/operator/docs/plans/agent-plan-tracking-2026-05-20.md (§3).
 *
 * Hard rules the parser enforces:
 *   - Tolerant heading match: strips leading `N. ` / `N.M ` before
 *     comparing to canonical names (## Now, ## Decisions). So
 *     `## 7. Decisions` matches.
 *   - Separator-agnostic: `blocked-by:` is a keyword, `P-NNN`/`D-NNN`
 *     are token patterns. Display glyphs (·, →, —) are never required.
 *   - Computed effectiveStatus is OUT OF SCOPE here — see resolver.ts.
 *     The parser surfaces only `storedStatus`.
 *   - Legacy detection is "missing or malformed frontmatter, or no
 *     slug field." Legacy files still parse to a result with isLegacy
 *     = true; callers (list/get) decide whether to surface them.
 */

export const PLAN_STATUSES = ['draft', 'ready', 'active', 'shipped', 'superseded'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const ITEM_STATUSES = [
  'todo',
  'wip',
  'blocked',
  'needs-human',
  'done',
  'dropped',
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/**
 * Per-item importance — a 4th axis orthogonal to status. Ordered most →
 * least important; the array index doubles as the sort rank. For a ToDo
 * it answers "which to pick up next"; for a needs-human item it answers
 * "how urgently a human should act." Distinct from the operator's
 * capability `tier` (risk-of-the-action). See
 * planning-attention-importance-2026-05-31.
 */
export const IMPORTANCE_LEVELS = ['urgent', 'high', 'normal', 'low'] as const;
export type Importance = (typeof IMPORTANCE_LEVELS)[number];
/** Default when an item line carries no `importance:` keyword. */
export const DEFAULT_IMPORTANCE: Importance = 'normal';

export interface PlanFrontmatter {
  title?: string;
  slug?: string;
  status?: PlanStatus;
  created?: string;
  updated?: string;
  owner?: string;
  supersedes?: string[];
  supersededBy?: string;
  raw: Record<string, string | string[]>;
}

export interface PlanNowBlock {
  state: string;
  next: string;
  raw: string;
  lineNumber: number;
}

export interface PlanItem {
  id: string;
  text: string;
  storedStatus: ItemStatus;
  /** Per-item importance — defaults to `normal` when the line carries no
   *  `importance:` keyword. Parsed glyph-agnostically like `blocked-by:`. */
  importance: Importance;
  blockedBy: string[];
  decisionRefs: string[];
  phase: string | null;
  lineNumber: number;
  rawLine: string;
}

export interface PlanDecision {
  id: string;
  title: string;
  body: string;
  date: string | null;
  itemRefs: string[];
  lineNumber: number;
}

export interface ParsedPlan {
  slug: string;
  filePath: string;
  filename: string;
  frontmatter: PlanFrontmatter;
  now: PlanNowBlock | null;
  items: PlanItem[];
  decisions: PlanDecision[];
  prose: string;
  /** Full original markdown source — what `parsePlan` was handed. The
   *  admin UI's PlanEditor renders this so the canonical bytes stay the
   *  visible truth (D-001 of plans-admin-ui-2026-05-20). */
  raw: string;
  isLegacy: boolean;
  parseWarnings: string[];
}

const PNN = /^P-\d{3,}$/;
const DNN = /^D-\d{3,}$/;
const PNN_INLINE = /\bP-\d{3,}\b/g;
const DNN_INLINE = /\bD-\d{3,}\b/g;

const HEADING_NUM_PREFIX = /^\d+(?:\.\d+)?\.\s+/;

function normalizeHeading(text: string): string {
  return text.replace(HEADING_NUM_PREFIX, '').trim();
}

function splitFrontmatter(source: string): { fm: string | null; body: string } {
  if (!source.startsWith('---')) {
    return { fm: null, body: source };
  }
  const close = source.indexOf('\n---', 3);
  if (close === -1) {
    return { fm: null, body: source };
  }
  const fm = source.slice(3, close).replace(/^\n/, '');
  const afterClose = source.indexOf('\n', close + 4);
  const body = afterClose === -1 ? '' : source.slice(afterClose + 1);
  return { fm, body };
}

/**
 * Minimal YAML subset parser for plan frontmatter.
 *
 * Supports:
 *   key: scalar string
 *   key: [a, b, c]      (flow-style arrays)
 *   # comments
 *
 * Deliberately tiny — plan frontmatter is flat and short. No nested
 * maps, no block-style arrays, no anchors, no multi-line strings.
 * If a plan ever needs more, the lint rule will fail loudly.
 */
function parseFrontmatter(fm: string | null): {
  result: PlanFrontmatter;
  warnings: string[];
  ok: boolean;
} {
  const warnings: string[] = [];
  const raw: Record<string, string | string[]> = {};

  if (fm === null) {
    return {
      result: { raw },
      warnings,
      ok: false,
    };
  }

  const lines = fm.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
      warnings.push(`Unparseable frontmatter line: ${trimmed}`);
      continue;
    }
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();

    if (!key) {
      warnings.push(`Missing key in frontmatter line: ${trimmed}`);
      continue;
    }

    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      if (!inner) {
        raw[key] = [];
      } else {
        raw[key] = inner.split(',').map((v) => stripQuotes(v.trim())).filter(Boolean);
      }
      continue;
    }

    value = stripQuotes(value);
    raw[key] = value;
  }

  const out: PlanFrontmatter = { raw };
  if (typeof raw.title === 'string') out.title = raw.title;
  if (typeof raw.slug === 'string') out.slug = raw.slug;
  if (typeof raw.status === 'string') {
    if ((PLAN_STATUSES as readonly string[]).includes(raw.status)) {
      out.status = raw.status as PlanStatus;
    } else {
      warnings.push(`Unknown plan status: ${raw.status}`);
    }
  }
  if (typeof raw.created === 'string') out.created = raw.created;
  if (typeof raw.updated === 'string') out.updated = raw.updated;
  if (typeof raw.owner === 'string') out.owner = raw.owner;
  if (Array.isArray(raw.supersedes)) out.supersedes = raw.supersedes;
  if (typeof raw['superseded-by'] === 'string') out.supersededBy = raw['superseded-by'];
  if (typeof raw.supersededBy === 'string' && !out.supersededBy) {
    out.supersededBy = raw.supersededBy;
  }

  return { result: out, warnings, ok: true };
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

interface RawSection {
  heading: string;
  normalizedHeading: string;
  level: number;
  startLine: number;
  body: string[];
}

function splitSections(body: string): RawSection[] {
  const lines = body.split('\n');
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    // Track fenced code blocks (``` or ~~~) so headings inside them
    // aren't treated as section breaks and items inside them aren't
    // parsed as real items.
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      if (current) current.body.push(line);
      continue;
    }
    if (inFence) {
      if (current) current.body.push(line);
      continue;
    }
    // Only split on level-1 or level-2 headings. Level-3+ stays as
    // body content so `### D-NNN` lives inside its parent `## Decisions`
    // section.
    const m = /^(#{1,2})\s+(.*)$/.exec(line);
    if (m) {
      if (current) sections.push(current);
      const heading = (m[2] ?? '').trim();
      current = {
        heading,
        normalizedHeading: normalizeHeading(heading),
        level: (m[1] ?? '').length,
        startLine: i + 1,
        body: [],
      };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) sections.push(current);
  return sections;
}

function parseNow(section: RawSection): PlanNowBlock | null {
  const raw = section.body.join('\n').trim();
  if (!raw) return null;
  const stateMatch = /\*\*State:\*\*\s*([\s\S]*?)(?=\n\s*\*\*Next:\*\*|$)/i.exec(raw);
  const nextMatch = /\*\*Next:\*\*\s*([\s\S]*?)$/i.exec(raw);
  return {
    state: stateMatch ? (stateMatch[1] ?? '').trim() : '',
    next: nextMatch ? (nextMatch[1] ?? '').trim() : '',
    raw,
    lineNumber: section.startLine,
  };
}

const ITEM_LINE_RE =
  /^[-*]\s+\*\*\s*(P-\d{3,})\s*\*\*\s+`([a-z-]+)`\s+(.*)$/;

function parseItemLine(
  line: string,
  lineNumber: number,
  phase: string | null,
): PlanItem | null {
  const m = ITEM_LINE_RE.exec(line);
  if (!m) return null;
  const id = m[1] ?? '';
  const statusTok = m[2] ?? '';
  const rest = m[3] ?? '';
  if (!(ITEM_STATUSES as readonly string[]).includes(statusTok)) {
    return null;
  }

  let text = rest;
  const blockedBy: string[] = [];
  const blockedByRe = /\bblocked-by\s*:\s*((?:P-\d{3,}(?:\s*,\s*)?)+)/i;
  const bbMatch = blockedByRe.exec(text);
  if (bbMatch) {
    const list = (bbMatch[1] ?? '').match(PNN_INLINE) ?? [];
    blockedBy.push(...list);
    text = (text.slice(0, bbMatch.index) + text.slice(bbMatch.index + bbMatch[0].length)).trim();
  }

  // `importance:` keyword — parsed glyph-agnostically like blocked-by,
  // then stripped from the visible text. An unknown value degrades to
  // `normal` here WITHOUT a parseWarning (those become lint *errors* —
  // lint.ts:149); plans:lint instead emits a soft `unknown_importance`
  // warning by re-scanning the raw line.
  let importance: Importance = DEFAULT_IMPORTANCE;
  const importanceRe = /\bimportance\s*:\s*([a-z]+)\b/i;
  const impMatch = importanceRe.exec(text);
  if (impMatch) {
    const tok = (impMatch[1] ?? '').toLowerCase();
    if ((IMPORTANCE_LEVELS as readonly string[]).includes(tok)) {
      importance = tok as Importance;
    }
    text = (text.slice(0, impMatch.index) + text.slice(impMatch.index + impMatch[0].length)).trim();
  }

  const decisionRefs = Array.from(new Set(text.match(DNN_INLINE) ?? []));

  text = text.replace(/[·→—]+\s*$/g, '').trim();
  text = text.replace(/\s+→\s+(?=D-\d)/g, ' ').replace(/\s+·\s+/g, ' ').trim();

  return {
    id,
    text,
    storedStatus: statusTok as ItemStatus,
    importance,
    blockedBy,
    decisionRefs,
    phase,
    lineNumber,
    rawLine: line,
  };
}

const DECISION_HEAD_RE = /^###\s+(D-\d{3,})\b\s*(?:[-–—]\s*)?(.*)$/;

function parseDecisionsSection(section: RawSection): PlanDecision[] {
  const decisions: PlanDecision[] = [];
  let current: PlanDecision | null = null;
  let bodyBuf: string[] = [];

  const flush = () => {
    if (current) {
      current.body = bodyBuf.join('\n').trim();
      const refs = new Set(current.body.match(PNN_INLINE) ?? []);
      current.itemRefs = Array.from(refs);
      const dateLine = current.body.match(/^Date:\s*([\d-]+)/im);
      if (dateLine) current.date = dateLine[1] ?? null;
      decisions.push(current);
    }
    current = null;
    bodyBuf = [];
  };

  let inFence = false;
  for (let i = 0; i < section.body.length; i++) {
    const line = section.body[i] ?? '';
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      if (current) bodyBuf.push(line);
      continue;
    }
    if (inFence) {
      if (current) bodyBuf.push(line);
      continue;
    }
    const m = DECISION_HEAD_RE.exec(line);
    if (m) {
      flush();
      current = {
        id: m[1] ?? '',
        title: (m[2] ?? '').trim(),
        body: '',
        date: null,
        itemRefs: [],
        lineNumber: section.startLine + i + 1,
      };
    } else if (current) {
      bodyBuf.push(line);
    }
  }
  flush();
  return decisions;
}

export interface ParseOptions {
  filePath?: string;
}

export function parsePlan(source: string, opts: ParseOptions = {}): ParsedPlan {
  const filePath = opts.filePath ?? '<inline>';
  const filename = filePath.split('/').pop() ?? filePath;
  const slug = filename.replace(/\.mdx?$/, '');

  const { fm, body } = splitFrontmatter(source);
  const { result: frontmatter, warnings, ok: fmOk } = parseFrontmatter(fm);

  const isLegacy = !fmOk || !frontmatter.slug || !frontmatter.status;

  const sections = splitSections(body);

  let now: PlanNowBlock | null = null;
  const items: PlanItem[] = [];
  let decisions: PlanDecision[] = [];

  let currentPhase: string | null = null;

  for (const section of sections) {
    const norm = section.normalizedHeading;

    if (section.level === 2 && /^Now$/i.test(norm) && !now) {
      now = parseNow(section);
      continue;
    }

    if (section.level === 2 && /^Decisions$/i.test(norm)) {
      decisions = parseDecisionsSection(section);
      continue;
    }

    if (section.level === 2 && /^Phase\b/i.test(norm)) {
      currentPhase = norm;
    } else if (section.level === 2) {
      currentPhase = null;
    }

    let inFence = false;
    for (let i = 0; i < section.body.length; i++) {
      const line = section.body[i] ?? '';
      if (/^\s*(?:```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const item = parseItemLine(line, section.startLine + i + 1, currentPhase);
      if (item) items.push(item);
    }
  }

  const idSeen = new Set<string>();
  for (const it of items) {
    if (idSeen.has(it.id)) {
      warnings.push(`Duplicate item id: ${it.id} at line ${it.lineNumber}`);
    }
    idSeen.add(it.id);
    if (!PNN.test(it.id)) {
      warnings.push(`Malformed item id: ${it.id}`);
    }
  }
  const decSeen = new Set<string>();
  for (const d of decisions) {
    if (decSeen.has(d.id)) {
      warnings.push(`Duplicate decision id: ${d.id} at line ${d.lineNumber}`);
    }
    decSeen.add(d.id);
    if (!DNN.test(d.id)) {
      warnings.push(`Malformed decision id: ${d.id}`);
    }
  }

  return {
    slug,
    filePath,
    filename,
    frontmatter,
    now,
    items,
    decisions,
    prose: body,
    raw: source,
    isLegacy,
    parseWarnings: warnings,
  };
}

/**
 * Return a copy of `body` with every character inside a fenced code
 * block (``` / ~~~ fences and the fence lines themselves) replaced by
 * a space. Newlines and total length are preserved byte-for-byte, so a
 * regex match index computed against the masked string applies
 * unchanged to the original.
 *
 * The write mutators (set-status, set-now, add-decision, add-item)
 * locate their target heading/item by running a regex over the masked
 * body, then splice the *real* body at the resulting index — so a
 * `## Now` or `- **P-001**` line inside a worked-example fence is never
 * mistaken for the real structural element. This matches the parser,
 * which already ignores fenced regions.
 */
export function maskFences(body: string): string {
  const lines = body.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const isFenceLine = /^\s*(?:```|~~~)/.test(line);
    if (isFenceLine) {
      inFence = !inFence;
      lines[i] = ' '.repeat(line.length);
      continue;
    }
    if (inFence) {
      lines[i] = ' '.repeat(line.length);
    }
  }
  return lines.join('\n');
}
