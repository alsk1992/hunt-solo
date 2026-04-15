#!/usr/bin/env bun
// hunt-solo — one-shot bug hunter.
// Find a real bug in a random GitHub repo → open a PR to fix it.
// Zero dependencies beyond Bun. Uses free OpenRouter models.
//
// Usage:
//   bun run hunt-solo.ts
//   bun run hunt-solo.ts <username> <pat> <language>
//
// Env:
//   OPENROUTER_API_KEY        required (free at openrouter.ai/keys)
//   GITHUB_PAT                optional (alternative to passing as arg)
//   HUNT_MODEL                optional (default: meta-llama/llama-4-maverick:free)

// ─── LLM client (OpenRouter, OpenAI-compatible) ───

interface LlmOptions {
  system?: string;
  temperature?: number;
  maxTokens?: number;
}

interface LlmClient {
  complete(prompt: string, opts?: LlmOptions): Promise<string>;
}

class OpenRouterClient implements LlmClient {
  constructor(private apiKey: string, private model: string) {}

  async complete(prompt: string, opts: LlmOptions = {}): Promise<string> {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxTokens ?? 4096,
        temperature: opts.temperature ?? 0.7,
        messages: [
          ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
          { role: 'user' as const, content: prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`openrouter ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices?.[0]?.message?.content ?? '';
  }
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) { last = e; if (i < attempts - 1) await sleep(500 * 2 ** i); }
  }
  throw last;
}

// ─── GitHub API (minimal, no deps) ───

const REST = 'https://api.github.com';

function gh(pat: string) {
  const headers: Record<string, string> = {
    'Authorization': `token ${pat}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'hunt-solo/1.0',
  };
  return {
    async get(path: string): Promise<any> {
      const res = await fetch(REST + path, { headers });
      if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res.json();
    },
    async post(path: string, body?: unknown): Promise<any> {
      const res = await fetch(REST + path, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${text.slice(0, 200)}`);
      return text ? JSON.parse(text) : undefined;
    },
    async patch(path: string, body: unknown): Promise<any> {
      const res = await fetch(REST + path, {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`PATCH ${path} → ${res.status}`);
      return res.json();
    },
    async put(path: string, body?: unknown): Promise<any> {
      const res = await fetch(REST + path, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok && res.status !== 204) throw new Error(`PUT ${path} → ${res.status}`);
      const text = await res.text();
      return text ? JSON.parse(text) : undefined;
    },
  };
}

// ─── Types ───

type BugType = 'null-check' | 'dead-import' | 'missing-error-handling' | 'off-by-one'
  | 'resource-leak' | 'logic-bug' | 'missing-edge-case' | 'broken-route'
  | 'missing-return' | 'incorrect-comparison';

interface BugFinding {
  file: string;
  startLine: number;
  endLine: number;
  bugType: BugType;
  confidence: 'medium' | 'high';
  description: string;
  originalCode: string;
  fixedCode: string;
}

interface RepoFile {
  path: string;
  content: string;
  sha: string;
}

// ─── Config ───

const LANGS = ['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'ruby', 'swift', 'kotlin', 'c', 'cpp'] as const;

const SRC_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.sol',
  '.swift', '.kt', '.cs', '.rb', '.java', '.c', '.cpp', '.h', '.sh', '.lua', '.zig',
]);

const SKIP = new Set([
  'node_modules', 'vendor', '.git', 'dist', 'build', '__pycache__',
  '.next', 'target', 'coverage', '.cache', 'venv', '.venv', 'env',
]);

const VALID_BUG_TYPES = new Set<string>([
  'null-check', 'dead-import', 'missing-error-handling', 'off-by-one',
  'resource-leak', 'logic-bug', 'missing-edge-case', 'broken-route',
  'missing-return', 'incorrect-comparison',
]);

// ─── Interactive prompt ───

async function ask(question: string): Promise<string> {
  process.stdout.write(question);
  const buf: Buffer[] = [];
  for await (const chunk of process.stdin) {
    buf.push(chunk as Buffer);
    if ((chunk as Buffer).includes(10)) break;
  }
  return Buffer.concat(buf).toString().trim();
}

// ─── Main ───

async function main() {
  console.log('═══ hunt-solo — one-shot bug hunter ═══\n');

  // 1. Gather inputs
  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) {
    console.error('missing OPENROUTER_API_KEY — get a free key at https://openrouter.ai/keys');
    process.exit(1);
  }

  const username = process.argv[2] || await ask('GitHub username: ');
  const pat = process.argv[3] || process.env.GITHUB_PAT || await ask('GitHub PAT: ');
  if (!username || !pat) { console.error('need username + PAT'); process.exit(1); }

  const langArg = process.argv[4] || '';
  const lang = LANGS.includes(langArg as any) ? langArg : await pickLang();

  const model = process.env.HUNT_MODEL ?? 'meta-llama/llama-4-maverick:free';
  const llm = new OpenRouterClient(orKey, model);
  const api = gh(pat);

  // Verify creds
  console.log(`\nverifying PAT for ${username}...`);
  try {
    const user = await api.get('/user');
    if (user.login.toLowerCase() !== username.toLowerCase()) {
      console.error(`PAT belongs to ${user.login}, not ${username}`);
      process.exit(1);
    }
    console.log(`  authenticated as ${user.login} (${user.public_repos} repos, ${user.followers} followers)`);
  } catch (e: any) {
    console.error(`  auth failed: ${e.message ?? e}`);
    process.exit(1);
  }

  // 2. Find target repo
  console.log(`\nsearching for ${lang} repos...`);
  const target = await findTarget(api, lang);
  if (!target) {
    console.error('no suitable target found — try a different language');
    process.exit(1);
  }
  console.log(`  target: ${target.name} (${target.stars} stars, pushed ${target.daysAgo}d ago)`);

  // 3. Download source files
  console.log(`\ndownloading source files...`);
  const files = await downloadFiles(api, target.name);
  console.log(`  ${files.length} files (${(files.reduce((s, f) => s + f.content.length, 0) / 1024).toFixed(1)} KB)`);
  if (files.length === 0) {
    console.error('no analyzable source files');
    process.exit(1);
  }

  // 4. Analyze
  console.log(`\nanalyzing with ${model}...`);
  const findings = await analyze(llm, files, target.name);
  console.log(`  ${findings.length} candidate bug(s)`);

  const valid = findings.filter((f) => validate(f, files));
  console.log(`  ${valid.length} passed validation`);

  if (valid.length === 0) {
    console.log('\nno actionable bugs found. run again to try another repo.');
    process.exit(0);
  }

  const best = valid.sort((a, b) => (b.confidence === 'high' ? 3 : 2) - (a.confidence === 'high' ? 3 : 2))[0];
  console.log(`\n  bug: ${best.bugType} in ${best.file}:${best.startLine}`);
  console.log(`  ${best.description}`);
  console.log(`\n  original:`);
  best.originalCode.split('\n').forEach((l) => console.log(`    - ${l}`));
  console.log(`  fix:`);
  best.fixedCode.split('\n').forEach((l) => console.log(`    + ${l}`));

  // 5. Confirm
  const ok = await ask('\nopen PR? (y/n): ');
  if (ok.toLowerCase() !== 'y') { console.log('aborted'); process.exit(0); }

  // 6. Fork + branch + commit + PR (all via API, no local git)
  const [owner, repo] = target.name.split('/');

  console.log('\nforking...');
  try { await api.post(`/repos/${owner}/${repo}/forks`); }
  catch { /* may already exist */ }
  await sleep(5000);

  // Base branch
  let base = 'main';
  try { await api.get(`/repos/${owner}/${repo}/branches/main`); }
  catch { base = 'master'; }

  // Create branch on fork from upstream HEAD
  console.log('creating branch...');
  const baseSha = (await api.get(`/repos/${owner}/${repo}/git/ref/heads/${base}`)).object.sha;
  const branch = `fix/${slug(best.file)}-${best.bugType}`.slice(0, 60);

  try {
    await api.post(`/repos/${username}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
  } catch {
    await api.patch(`/repos/${username}/${repo}/git/refs/heads/${branch}`, { sha: baseSha, force: true });
  }

  // Apply fix + commit via Contents API
  console.log('committing fix...');
  const src = files.find((f) => f.path === best.file)!;
  const fixed = applyFix(src.content, best);
  if (fixed === src.content) { console.error('fix produced no change'); process.exit(1); }

  let fileSha: string;
  try { fileSha = (await api.get(`/repos/${username}/${repo}/contents/${best.file}?ref=${branch}`)).sha; }
  catch { fileSha = src.sha; }

  await api.put(`/repos/${username}/${repo}/contents/${best.file}`, {
    message: `fix: ${best.description.toLowerCase().slice(0, 72)}`,
    content: Buffer.from(fixed).toString('base64'),
    sha: fileSha,
    branch,
  });

  // Open PR
  console.log('opening PR...');
  const prBody = await genPRBody(llm, best);
  const pr = await api.post(`/repos/${owner}/${repo}/pulls`, {
    title: `Fix ${best.bugType} in ${best.file.replace(/^.*\//, '')}`,
    body: prBody,
    head: `${username}:${branch}`,
    base,
  });

  console.log(`\n  PR opened: ${pr.html_url}\n`);
}

// ─── Target discovery ───

async function findTarget(api: ReturnType<typeof gh>, lang: string): Promise<{ name: string; stars: number; daysAgo: number } | null> {
  const searches = [
    () => issueSearch(api, lang, 'bug'),
    () => issueSearch(api, lang, 'help wanted'),
    () => issueSearch(api, lang, 'good first issue'),
    () => repoSearch(api, lang),
  ];

  for (const search of searches) {
    try {
      const repos = shuffle(await search());
      for (const r of repos) {
        try {
          const d = await api.get(`/repos/${r}`);
          const stars = d.stargazers_count ?? 0;
          if (stars < 50 || stars > 10_000 || d.archived || d.fork) continue;
          const daysAgo = Math.floor((Date.now() - Date.parse(d.pushed_at ?? '')) / 86400000);
          if (daysAgo > 90) continue;
          return { name: r, stars, daysAgo };
        } catch { continue; }
      }
    } catch { continue; }
  }
  return null;
}

async function issueSearch(api: ReturnType<typeof gh>, lang: string, label: string): Promise<string[]> {
  const stars = 100 + Math.floor(Math.random() * 300);
  const q = encodeURIComponent(`language:${lang} stars:${stars}..8000 pushed:>${daysAgo(60)} label:"${label}"`);
  const d = await api.get(`/search/issues?q=${q}&sort=created&per_page=15`);
  const repos = (d.items ?? []).map((i: any) => (i.repository_url as string).match(/\/repos\/(.+)$/)?.[1]).filter(Boolean) as string[];
  return [...new Set(repos)];
}

async function repoSearch(api: ReturnType<typeof gh>, lang: string): Promise<string[]> {
  const stars = 50 + Math.floor(Math.random() * 200);
  const sort = Math.random() < 0.5 ? 'stars' : 'updated';
  const page = 1 + Math.floor(Math.random() * 3);
  const q = encodeURIComponent(`language:${lang} stars:${stars}..5000 pushed:>${daysAgo(90)}`);
  const d = await api.get(`/search/repositories?q=${q}&sort=${sort}&per_page=20&page=${page}`);
  return (d.items ?? []).map((i: any) => i.full_name as string);
}

// ─── File download ───

async function downloadFiles(api: ReturnType<typeof gh>, repo: string): Promise<RepoFile[]> {
  const [o, n] = repo.split('/');
  let tree: any[];
  try { tree = (await api.get(`/repos/${o}/${n}/git/trees/HEAD?recursive=1`)).tree ?? []; }
  catch {
    try { tree = (await api.get(`/repos/${o}/${n}/git/trees/main?recursive=1`)).tree ?? []; }
    catch { tree = (await api.get(`/repos/${o}/${n}/git/trees/master?recursive=1`)).tree ?? []; }
  }

  const blobs = tree.filter((e: any) => {
    if (e.type !== 'blob') return false;
    const sz = e.size ?? 0;
    if (sz > 50_000 || sz < 10) return false;
    const p = e.path as string;
    if (!SRC_EXT.has(p.slice(p.lastIndexOf('.')))) return false;
    if (/lock\b|\.lock$/i.test(p)) return false;
    if (p.split('/').some((s: string) => SKIP.has(s))) return false;
    if (/\.(test|spec|e2e)\./i.test(p) || p.split('/').some((s: string) => /^(__)?tests?(__)?$/i.test(s))) return false;
    return true;
  });

  // Score: src/ > lib/ > app/; entry points higher; medium-sized files preferred
  const scored = blobs.map((e: any) => {
    let s = 0;
    const p = e.path as string;
    if (p.startsWith('src/')) s += 3;
    else if (/^(lib|app)\//.test(p)) s += 2;
    if (/index\.|main\.|app\.|server\.|handler\.|router\.|controller\.|middleware\./i.test(p)) s += 2;
    const sz = e.size ?? 0;
    if (sz >= 200 && sz <= 2000) s += 2;
    else if (sz > 2000 && sz <= 10000) s += 1;
    return { e, s };
  }).sort((a, b) => b.s - a.s);

  const files: RepoFile[] = [];
  for (const { e } of scored.slice(0, 15)) {
    try {
      const blob = await api.get(`/repos/${o}/${n}/git/blobs/${e.sha}`);
      files.push({ path: e.path, content: Buffer.from(blob.content, 'base64').toString('utf8'), sha: e.sha });
    } catch { /* skip */ }
  }
  return files;
}

// ─── Bug analysis ───

async function analyze(llm: LlmClient, files: RepoFile[], repo: string): Promise<BugFinding[]> {
  const batches = batch(files, 6000);
  const all: BugFinding[] = [];

  for (const b of batches) {
    const ctx = b.map((f) => {
      const numbered = f.content.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
      return `### ${f.path}\n\`\`\`\n${numbered}\n\`\`\``;
    }).join('\n\n');

    const system = `You are a senior engineer code reviewing. Find REAL bugs only — not style, not improvements.

Each bug needs the EXACT original lines (copy-paste, preserve indentation) and your fix.

Bug types: null-check, dead-import, missing-error-handling, off-by-one, resource-leak, logic-bug, missing-edge-case, missing-return, incorrect-comparison

DO NOT report: style, security, races, performance, refactoring.

Output ONLY a JSON array (no fences):
[{"file":"path","startLine":42,"endLine":44,"bugType":"null-check","confidence":"high","description":"short desc","originalCode":"exact lines","fixedCode":"corrected lines"}]
Empty: []
Max 2 findings.`;

    try {
      const raw = await withRetry(() => llm.complete(
        `Repository: ${repo}\n\n${ctx}\n\nFind real bugs. JSON only.`,
        { system, temperature: 0.3, maxTokens: 2048 },
      ), 2);
      all.push(...parse(raw, b));
      if (all.length >= 3) break;
    } catch (e: any) {
      console.log(`  batch error: ${e.message ?? e}`);
    }
  }
  return all;
}

function batch(files: RepoFile[], max: number): RepoFile[][] {
  const out: RepoFile[][] = [];
  let cur: RepoFile[] = [], sz = 0;
  for (const f of files) {
    const len = Math.min(f.content.length, 2000);
    if (sz + len > max && cur.length > 0) { out.push(cur); cur = []; sz = 0; }
    cur.push({ ...f, content: f.content.slice(0, 2000) });
    sz += len;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function parse(raw: string, files: RepoFile[]): BugFinding[] {
  const s = raw.indexOf('['), e = raw.lastIndexOf(']');
  if (s < 0 || e <= s) return [];
  let arr: any[];
  try { arr = JSON.parse(raw.slice(s, e + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const fm = new Map(files.map((f) => [f.path, f]));

  return arr.filter((f) => {
    if (!f?.file || !fm.has(f.file)) return false;
    const lc = fm.get(f.file)!.content.split('\n').length;
    if (typeof f.startLine !== 'number' || f.startLine < 1) return false;
    if (typeof f.endLine !== 'number' || f.endLine < f.startLine || f.endLine > lc + 5) return false;
    if (f.confidence !== 'medium' && f.confidence !== 'high') return false;
    if (!VALID_BUG_TYPES.has(f.bugType)) return false;
    if (!f.originalCode || !f.fixedCode) return false;
    return true;
  }).map((f) => ({
    file: f.file, startLine: f.startLine, endLine: f.endLine,
    bugType: f.bugType as BugType, confidence: f.confidence as 'medium' | 'high',
    description: String(f.description ?? ''),
    originalCode: String(f.originalCode), fixedCode: String(f.fixedCode),
  }));
}

// ─── Validation + fix application ───

function validate(f: BugFinding, files: RepoFile[]): boolean {
  const file = files.find((x) => x.path === f.file);
  if (!file) return false;
  if (f.startLine < 1 || f.endLine > file.content.split('\n').length) return false;
  if (f.originalCode.trim() === f.fixedCode.trim()) return false;
  if (!findInFile(file.content, f.originalCode, f.startLine)) return false;
  const oL = f.originalCode.length, fL = f.fixedCode.length;
  if (oL > 0 && (fL > oL * 4 || fL < oL * 0.1)) return false;
  const bal = (s: string) => { let n = 0; for (const c of s) { if ('{(['.includes(c)) n++; if ('})]'.includes(c)) n--; } return n; };
  if (Math.abs(bal(f.fixedCode) - bal(f.originalCode)) > 1) return false;
  return true;
}

function findInFile(content: string, orig: string, hint: number): { start: number; end: number } | null {
  // Exact match
  if (content.includes(orig)) {
    const s = content.slice(0, content.indexOf(orig)).split('\n').length - 1;
    return { start: s, end: s + orig.split('\n').length - 1 };
  }
  // Fuzzy: normalize whitespace, search near hint
  const norm = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  const nOrig = norm(orig);
  const lines = content.split('\n');
  const oLC = orig.split('\n').filter((l) => l.trim()).length;
  const lo = Math.max(0, hint - 11), hi = Math.min(lines.length, hint + 10);
  for (let i = lo; i <= hi - oLC; i++) {
    for (let len = oLC - 1; len <= oLC + 2 && i + len <= lines.length; len++) {
      if (norm(lines.slice(i, i + len).join('\n')) === nOrig) return { start: i, end: i + len - 1 };
    }
  }
  return null;
}

function applyFix(content: string, f: BugFinding): string {
  if (content.includes(f.originalCode)) return content.replace(f.originalCode, f.fixedCode);
  const m = findInFile(content, f.originalCode, f.startLine);
  if (m) {
    const l = content.split('\n');
    return [...l.slice(0, m.start), ...f.fixedCode.split('\n'), ...l.slice(m.end + 1)].join('\n');
  }
  const l = content.split('\n');
  return [...l.slice(0, f.startLine - 1), ...f.fixedCode.split('\n'), ...l.slice(Math.min(f.endLine, l.length))].join('\n');
}

// ─── PR body ───

async function genPRBody(llm: LlmClient, f: BugFinding): Promise<string> {
  const stories = [
    'I was browsing the source and noticed', 'While reading through the codebase I spotted',
    'Found this while checking out the code', 'Noticed this while reading the implementation',
  ];
  const story = stories[Math.floor(Math.random() * stories.length)];
  try {
    return (await withRetry(() => llm.complete(
      `Write a short GitHub PR description (2-3 sentences) for this bug fix.\n\nBug: ${f.description}\nFile: ${f.file}:${f.startLine}\nType: ${f.bugType}\nContext: ${story}\n\nSound like a real dev. Do NOT mention AI/bots/tools. Just the body text, no headers.`,
      { temperature: 0.9, maxTokens: 300 },
    ))).trim();
  } catch {
    return `${story} a ${f.bugType} in \`${f.file}\`.\n\n${f.description}`;
  }
}

// ─── Helpers ───

async function pickLang(): Promise<string> {
  console.log('\nlanguages:');
  LANGS.forEach((l, i) => console.log(`  ${i + 1}. ${l}`));
  const c = await ask('pick (default 1): ');
  return LANGS[parseInt(c || '1', 10) - 1] ?? 'typescript';
}

function slug(path: string): string {
  return path.replace(/^.*\//, '').replace(/\.[^.]+$/, '').replace(/[^a-z0-9-]/gi, '-').slice(0, 25);
}
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}
function daysAgo(n: number): string { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(e instanceof Error ? e.stack : String(e)); process.exit(1); });
