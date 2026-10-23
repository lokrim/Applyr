import { isAlias, isCollection, isMap, isScalar, LineCounter, parseDocument, stringify, type Node } from 'yaml';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { ID_PATTERN, MAX_PROFILE_BYTES, ProfileSchema, type ProfileDocument } from './schema';

export interface ProfileIssue { code: string; path: (string | number)[]; line?: number; column?: number; message: string; removable?: boolean }
export interface ImportResult { document?: ProfileDocument; issues: ProfileIssue[] }
const fail = (code: string, message: string, line = 1): ImportResult => ({ issues: [{ code, path: [], line, message }] });
const trimLines = (s: string) => s.replace(/^\n+|\n+$/g, '');
const secretKey = (key: string) => /(?:apikey|password|passwd|otp|cookies?|tokens?|credentials?|authorization|secrets?)$/i.test(key.replace(/[-_\s]/g, '')) || ['__proto__', 'prototype', 'constructor'].includes(key);

export function parseProfileBytes(bytes: Uint8Array): ImportResult {
  if (bytes.byteLength > MAX_PROFILE_BYTES) return fail('SIZE', 'Use one Markdown file no larger than 256 KiB.');
  try { return parseProfileMarkdown(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return fail('ENCODING', 'Save the file as UTF-8 text; binary or invalid UTF-8 is unsupported.'); }
}

export async function readProfileFile(file: File): Promise<ImportResult> {
  if (!/\.md$/i.test(file.name)) return fail('FILE', 'Select one .md Markdown file.');
  if (file.size > MAX_PROFILE_BYTES) return fail('SIZE', 'Use one Markdown file no larger than 256 KiB.');
  try { return parseProfileBytes(new Uint8Array(await file.arrayBuffer())); }
  catch { return fail('FILE', 'The selected file could not be read. Select it again.'); }
}

function envelope(input: string) {
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  if (end < 0 || !/^\n---(?:\n|$)/.test(text.slice(end))) return null;
  return { yaml: text.slice(4, end), body: text.slice(end + 4).replace(/^\n/, ''), bodyLine: text.slice(0, end + 4).split('\n').length + 1 };
}

// Parse CommonMark solely for section boundaries/positions. Never compile HTML, fetch,
// resolve links, or execute nodes. Code fences and quoted headings remain answer text.
export function parseAnswerSections(body: string, bodyLine = 1) {
  const tree = fromMarkdown(body);
  const issues: ProfileIssue[] = [];
  const answerBodies: Record<string, string> = Object.create(null);
  const notes: string[] = [];
  const headings = tree.children.filter((n) => n.type === 'heading' && n.depth === 2);
  let cursor = 0;
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i]!;
    const start = heading.position!.start.offset!;
    const end = headings[i + 1]?.position?.start.offset ?? body.length;
    const raw = body.slice(start, heading.position!.end.offset);
    if (!/^##[ \t]+Answer:/.test(raw)) continue;
    notes.push(body.slice(cursor, start));
    cursor = end;
    const match = /^##[ \t]+Answer: ([a-z0-9]+(?:-[a-z0-9]+)*)(?:[ \t]+#+)?[ \t]*$/.exec(raw);
    const line = heading.position!.start.line + bodyLine - 1;
    if (!match) { issues.push({ code: 'ANSWER_HEADING', path: ['answers'], line, message: 'Use exactly ## Answer: followed by a valid stable ID.' }); continue; }
    const id = match[1]!;
    if (Object.hasOwn(answerBodies, id)) issues.push({ code: 'DUPLICATE_ANSWER', path: ['answers', id], line, message: 'Duplicate answer section; keep exactly one body per ID.' });
    answerBodies[id] = trimLines(body.slice(heading.position!.end.offset!, end));
  }
  notes.push(body.slice(cursor));
  for (const node of tree.children) {
    if (node.type !== 'code' && /^---$/m.test(body.slice(node.position!.start.offset, node.position!.end.offset))) issues.push({ code: 'FRONT_MATTER', path: [], line: node.position!.start.line + bodyLine - 1, message: 'Only one front-matter block is allowed. Use *** for a prose separator.' });
  }
  return { notes: trimLines(notes.join('\n\n')), answerBodies, issues };
}

export function parseProfileMarkdown(input: string): ImportResult {
  if (new TextEncoder().encode(input).byteLength > MAX_PROFILE_BYTES) return fail('SIZE', 'Use one Markdown file no larger than 256 KiB.');
  if ([...input].some((c) => { const code = c.charCodeAt(0); return code === 127 || (code < 32 && ![9, 10, 13].includes(code)); }) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input)) return fail('ENCODING', 'Remove binary/control characters and save as UTF-8.');
  const parts = envelope(input);
  if (!parts) return fail('FRONT_MATTER', 'Begin with --- on its own line and close one YAML front-matter block with ---.');
  const lineCounter = new LineCounter();
  try {
    const yaml = parseDocument(parts.yaml, { version: '1.2', schema: 'core', customTags: [], merge: false, uniqueKeys: true, strict: true, prettyErrors: false, lineCounter, logLevel: 'silent' });
    const location = (offset: number) => { const p = lineCounter.linePos(offset); return { line: p.line + 1, column: p.col }; };
    const issues: ProfileIssue[] = [...yaml.errors, ...yaml.warnings].map((error) => ({ code: error.code, path: [], ...location(error.pos[0]), message: error.code === 'DUPLICATE_KEY' ? 'Duplicate YAML key; remove the duplicate explicitly.' : 'Invalid or unsupported YAML; repair this location using plain core-schema data.' }));
    const positions = new Map<string, { line: number; column: number }>();
    let count = 0;
    function inspect(node: Node | null, path: (string | number)[], depth: number) {
      if (!node) return;
      if (++count > 4096 || depth > 12) throw new Error('LIMIT');
      if (node.range) positions.set(JSON.stringify(path), location(node.range[0]));
      const at = positions.get(JSON.stringify(path));
      if (isAlias(node) || ('anchor' in node && node.anchor) || node.tag) issues.push({ code: 'YAML_FEATURE', path, ...at, message: 'Remove aliases, anchors and explicit/custom tags; use plain core-schema values.' });
      if (isCollection(node) && node.items.length > 100) throw new Error('LIMIT');
      if (isMap(node)) node.items.forEach((pair) => {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string') { issues.push({ code: 'KEY', path, ...at, message: 'Mapping keys must be strings.' }); return; }
        const key = pair.key.value;
        const keyPath = [...path, key];
        if (pair.key.range) positions.set(JSON.stringify(keyPath), location(pair.key.range[0]));
        if (secretKey(key) || key === '<<') issues.push({ code: 'FORBIDDEN_KEY', path: keyPath, ...positions.get(JSON.stringify(keyPath)), message: 'Remove credential, unsafe or merge keys. Secrets do not belong in profiles.' });
        if (['reviewed_on', 'confirmed_on', 'start_date', 'end_date', 'available_from'].includes(key) && isScalar(pair.value) && typeof pair.value.value === 'string' && !['QUOTE_DOUBLE', 'QUOTE_SINGLE'].includes(pair.value.type ?? '')) issues.push({ code: 'DATE_QUOTING', path: keyPath, ...positions.get(JSON.stringify(keyPath)), message: 'Quote date strings as YYYY-MM or YYYY-MM-DD to preserve precision.' });
        inspect(pair.key, keyPath, depth + 1);
        inspect(pair.value as Node | null, keyPath, depth + 1);
      });
      else if (isCollection(node)) node.items.forEach((item, i) => inspect(item as Node | null, [...path, i], depth + 1));
    }
    inspect(yaml.contents, [], 0);
    if (issues.length) return { issues };
    const raw: unknown = yaml.toJS({ maxAliasCount: 0 });
    const parsed = ProfileSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path as (string | number)[];
        if (issue.code === 'unrecognized_keys') for (const key of issue.keys) issues.push({ code: 'UNKNOWN_KEY', path: [...path, key], ...positions.get(JSON.stringify([...path, key])), message: 'Unknown v1 key; repair it in the file or explicitly remove it here.', removable: true });
        else issues.push({ code: issue.path[0] === 'profile_version' ? 'VERSION' : 'SCHEMA', path, ...positions.get(JSON.stringify(path)), message: issue.path[0] === 'profile_version' ? 'Only profile_version: 1 is supported. Export/migrate to v1 before importing.' : issue.code === 'custom' ? issue.message : 'Invalid field type, format or size. Check this field against the v1 template.' });
      }
      return { issues };
    }
    const sections = parseAnswerSections(parts.body, parts.bodyLine);
    issues.push(...sections.issues);
    const expected = new Set(parsed.data.answers?.map((a) => a.id));
    parsed.data.answers?.forEach((a, i) => { if (!sections.answerBodies[a.id]?.trim()) issues.push({ code: 'ANSWER_BODY', path: ['answers', i, 'id'], ...positions.get(JSON.stringify(['answers', i, 'id'])), message: 'Add a nonempty matching ## Answer: section for this ID.' }); });
    Object.keys(sections.answerBodies).forEach((id) => { if (!expected.has(id)) issues.push({ code: 'ANSWER_METADATA', path: ['answers', id], message: 'Add matching answer metadata or remove this orphan section.' }); });
    if (issues.length) return { issues };
    return { document: { data: parsed.data, notes: sections.notes, answerBodies: sections.answerBodies }, issues: [] };
  } catch { return fail('PARSE_LIMIT', 'Unable to parse safely. Reduce nesting (max 12), collections (max 100), nodes (max 4096), or repair YAML syntax.'); }
}

export function removeUnknownKeys(input: string, paths: (string | number)[][]): string {
  const parts = envelope(input);
  if (!parts) return input;
  const yaml = parseDocument(parts.yaml, { schema: 'core', logLevel: 'silent' });
  // Only paths reported by our strict validator can be removed; never use a caller's arbitrary paths.
  const allowed = parseProfileMarkdown(input).issues.filter((i) => i.removable).map((i) => JSON.stringify(i.path));
  paths.forEach((path) => { if (allowed.includes(JSON.stringify(path))) yaml.deleteIn(path); });
  return `---\n${yaml.toString()}---\n${parts.body}`;
}

function serializeProfile(document: ProfileDocument): string {
  return `---\n${stringify(document.data, { schema: 'core', aliasDuplicateObjects: false, defaultStringType: 'QUOTE_DOUBLE', lineWidth: 0 })}---\n\n${trimLines(document.notes)}${document.data.answers?.map((a) => `\n\n## Answer: ${a.id}\n\n${trimLines(document.answerBodies[a.id] ?? '')}`).join('') ?? ''}\n`;
}

export function validateProfileDocument(document: ProfileDocument): ImportResult {
  if (!document || typeof document !== 'object') return fail('DOCUMENT', 'Supply a v1 profile with notes and matching answer text.');
  const parsed = ProfileSchema.safeParse(document.data);
  if (!parsed.success) return { issues: parsed.error.issues.map((i) => ({ code: 'SCHEMA', path: i.path as (string | number)[], message: i.code === 'custom' ? i.message : 'Invalid field type, format or size; repair this field.' })) };
  if (typeof document.notes !== 'string' || !document.answerBodies || typeof document.answerBodies !== 'object' || Object.values(document.answerBodies).some((v) => typeof v !== 'string')) return fail('DOCUMENT', 'Repair notes and answer text.');
  if (Object.keys(document.answerBodies).some((key) => !ID_PATTERN.test(key) || !parsed.data.answers?.some((a) => a.id === key))) return fail('ANSWER_METADATA', 'Remove orphan answer bodies or add matching metadata.');
  try {
    const result = parseProfileMarkdown(serializeProfile({ ...document, data: parsed.data }));
    if (result.document && (JSON.stringify(result.document.answerBodies) !== JSON.stringify(Object.fromEntries((parsed.data.answers ?? []).map((a) => [a.id, trimLines(document.answerBodies[a.id] ?? '')]))) || result.document.notes !== trimLines(document.notes))) return fail('ANSWER_BODY', 'Keep level-two headings outside answer bodies and answer sections outside notes; use fenced code for literal headings.');
    return result;
  }
  catch { return fail('ANSWER_BODY', 'Supply matching nonempty answer bodies; keep level-two headings outside answers. Repair reserved front-matter delimiters in notes.'); }
}

export function exportProfile(document: ProfileDocument): string {
  const checked = validateProfileDocument(document).document;
  if (!checked) throw new Error('Repair profile validation errors before exporting.');
  return serializeProfile(checked);
}
