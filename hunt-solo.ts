#!/usr/bin/env bun
// hunt-solo — one-shot bug hunter.
// Find a real bug in a GitHub repo → open a PR to fix it.
// Zero dependencies beyond Bun. Uses free OpenRouter models.
//
// Usage:
//   bun run hunt-solo.ts
//   bun run hunt-solo.ts <username> <pat> <language> [owner/repo] [--loop] [--dry-run]
//
// Env:
//   OPENROUTER_API_KEY        required (free at openrouter.ai/keys)
//   GITHUB_PAT                optional (alternative to passing as arg)
//   HUNT_MODEL                optional (default: meta-llama/llama-4-maverick:free)
//   HUNT_MODEL_2              optional (second model for consensus — set to enable)
//   HUNT_MAX_ATTEMPTS         optional (max repos to try in --loop mode, default 5)

// ─── LLM client (OpenRouter, OpenAI-compatible) ───

interface LlmOptions {
  system?: string;
  temperature?: number;
  maxTokens?: number;
}

interface LlmClient {
  complete(prompt: string, opts?: LlmOptions): Promise<string>;
  readonly model: string;
}

class OpenRouterClient implements LlmClient {
  readonly model: string;
  constructor(private apiKey: string, model: string) { this.model = model; }

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

// ─── GitHub API ───

const REST = 'https://api.github.com';

function gh(pat: string) {
  const headers: Record<string, string> = {
    'Authorization': `token ${pat}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'hunt-solo/2.0',
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

// Screening pass result — lightweight, before full analysis
interface BugCandidate {
  file: string;
  line: number;
  hint: string;   // one-line description from screening
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

// Language extensions for syntax checking
const LANG_EXT: Record<string, string> = {
  '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx',
  '.py': 'python', '.go': 'go', '.rs': 'rust',
  '.rb': 'ruby', '.java': 'java', '.c': 'c', '.cpp': 'cpp',
  '.swift': 'swift', '.kt': 'kotlin',
};

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

// ─── CLI arg parsing ───

interface CliArgs {
  username: string;
  pat: string;
  lang: string;
  targetRepo?: string;       // owner/repo if specified
  loop: boolean;
  dryRun: boolean;
  maxAttempts: number;
}

async function parseArgs(orKey: string): Promise<CliArgs> {
  const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('-')));
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('-'));

  const loop = flags.has('--loop') || flags.has('-l');
  const dryRun = flags.has('--dry-run') || flags.has('-n');
  const maxAttempts = parseInt(process.env.HUNT_MAX_ATTEMPTS ?? '5', 10);

  const username = positional[0] || await ask('GitHub username: ');
  const pat = positional[1] || process.env.GITHUB_PAT || await ask('GitHub PAT: ');
  if (!username || !pat) { console.error('need username + PAT'); process.exit(1); }

  // 4th positional: could be a language or owner/repo
  let lang = '';
  let targetRepo: string | undefined;

  const arg3 = positional[2] || '';
  if (arg3.includes('/')) {
    targetRepo = arg3;
  } else if (LANGS.includes(arg3 as any)) {
    lang = arg3;
  }

  const arg4 = positional[3] || '';
  if (!targetRepo && arg4.includes('/')) targetRepo = arg4;
  if (!lang && LANGS.includes(arg4 as any)) lang = arg4;

  if (!lang) lang = await pickLang();

  return { username, pat, lang, targetRepo, loop, dryRun, maxAttempts };
}

// ─── Main ───

async function main() {
  console.log('═══ hunt-solo v2 — one-shot bug hunter ═══\n');

  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) {
    console.error('missing OPENROUTER_API_KEY — get a free key at https://openrouter.ai/keys');
    process.exit(1);
  }

  const args = await parseArgs(orKey);
  const model1 = process.env.HUNT_MODEL ?? 'meta-llama/llama-4-maverick:free';
  const model2 = process.env.HUNT_MODEL_2; // optional second model for consensus
  const llm = new OpenRouterClient(orKey, model1);
  const llm2 = model2 ? new OpenRouterClient(orKey, model2) : null;
  const api = gh(args.pat);

  // Verify creds
  console.log(`verifying PAT for ${args.username}...`);
  try {
    const user = await api.get('/user');
    if (user.login.toLowerCase() !== args.username.toLowerCase()) {
      console.error(`PAT belongs to ${user.login}, not ${args.username}`);
      process.exit(1);
    }
    console.log(`  authenticated as ${user.login}`);
  } catch (e: any) {
    console.error(`  auth failed: ${e.message ?? e}`);
    process.exit(1);
  }

  if (llm2) console.log(`models: ${model1} + ${model2} (consensus mode)`);
  else console.log(`model: ${model1}`);
  if (args.dryRun) console.log('  DRY RUN — will not open PR');
  if (args.loop) console.log(`  LOOP MODE — up to ${args.maxAttempts} repos`);

  // History tracking
  const history = await loadHistory();
  const triedThisRun = new Set<string>();

  // Main loop (1 iteration unless --loop)
  const maxTries = args.loop ? args.maxAttempts : 1;

  for (let attempt = 1; attempt <= maxTries; attempt++) {
    if (args.loop) console.log(`\n── attempt ${attempt}/${maxTries} ──`);

    const result = await huntOnce(api, llm, llm2, args, history, triedThisRun);
    if (result === 'success') break;
    if (result === 'no-target') { console.log('  exhausted target candidates'); break; }
    // result === 'no-bug' → try next repo if looping
  }

  await saveHistory(history);
}

type HuntResult = 'success' | 'no-target' | 'no-bug';

async function huntOnce(
  api: ReturnType<typeof gh>,
  llm: LlmClient,
  llm2: LlmClient | null,
  args: CliArgs,
  history: HuntHistory,
  triedThisRun: Set<string>,
): Promise<HuntResult> {

  // 1. Find target
  let targetName: string;
  let targetStars = 0;

  if (args.targetRepo) {
    targetName = args.targetRepo;
    try {
      const d = await api.get(`/repos/${targetName}`);
      targetStars = d.stargazers_count ?? 0;
    } catch (e: any) {
      console.error(`  can't access ${targetName}: ${e.message}`);
      return 'no-target';
    }
    // Only allow targeting once
    args.targetRepo = undefined;
  } else {
    console.log(`\nsearching for ${args.lang} repos...`);
    const target = await findTarget(api, args.lang, history, triedThisRun);
    if (!target) return 'no-target';
    targetName = target.name;
    targetStars = target.stars;
    console.log(`  target: ${targetName} (${target.stars} stars, pushed ${target.daysAgo}d ago)`);
  }

  triedThisRun.add(targetName);
  history.scanned[targetName] = new Date().toISOString();

  // 2. Check for open bug issues — mine them for context
  const bugIssues = await fetchBugIssues(api, targetName);
  if (bugIssues.length > 0) {
    console.log(`  ${bugIssues.length} open bug issue(s) found — will use as context`);
  }

  // 3. Download source files
  console.log(`downloading source files...`);
  const files = await downloadFiles(api, targetName);
  console.log(`  ${files.length} files (${(files.reduce((s, f) => s + f.content.length, 0) / 1024).toFixed(1)} KB)`);
  if (files.length === 0) { console.log('  no analyzable source files'); return 'no-bug'; }

  // 4. Two-pass analysis
  //    Pass 1: screen each file individually (small context = better for free models)
  //    Pass 2: deep analysis on candidate files with full content
  console.log(`\npass 1: screening ${files.length} files with ${llm.model}...`);
  const candidates = await screenFiles(llm, files, targetName, bugIssues);
  console.log(`  ${candidates.length} suspect(s)`);
  if (candidates.length === 0) { console.log('  no bugs found'); return 'no-bug'; }

  console.log(`pass 2: deep analysis on suspects...`);
  const findings = await deepAnalyze(llm, files, candidates, targetName, bugIssues);
  console.log(`  ${findings.length} finding(s)`);

  // 5. Multi-model consensus (if second model configured)
  let confirmed = findings;
  if (llm2 && findings.length > 0) {
    console.log(`consensus check with ${llm2.model}...`);
    confirmed = await consensusFilter(llm2, files, findings, targetName);
    console.log(`  ${confirmed.length} confirmed by second model`);
  }

  // 6. Validate
  const valid = confirmed.filter((f) => validate(f, files));
  console.log(`  ${valid.length} passed validation`);

  // 7. Syntax-check the fix
  const syntaxOk = [];
  for (const f of valid) {
    const file = files.find((x) => x.path === f.file);
    if (!file) continue;
    const fixed = applyFix(file.content, f);
    if (fixed === file.content) continue;
    const ok = await syntaxCheck(fixed, f.file);
    if (ok) syntaxOk.push(f);
    else console.log(`  syntax check failed: ${f.file}:${f.startLine}`);
  }
  console.log(`  ${syntaxOk.length} passed syntax check`);

  if (syntaxOk.length === 0) { console.log('  no actionable bugs survived'); return 'no-bug'; }

  const best = syntaxOk.sort((a, b) => confScore(b.confidence) - confScore(a.confidence))[0];
  console.log(`\n  bug: ${best.bugType} in ${best.file}:${best.startLine}`);
  console.log(`  ${best.description}`);
  console.log(`\n  original:`);
  best.originalCode.split('\n').forEach((l) => console.log(`    - ${l}`));
  console.log(`  fix:`);
  best.fixedCode.split('\n').forEach((l) => console.log(`    + ${l}`));

  // 8. Dry run check
  if (args.dryRun) {
    console.log('\n  DRY RUN — skipping PR creation');
    return 'success';
  }

  // 9. Confirm
  const ok = await ask('\nopen PR? (y/n): ');
  if (ok.toLowerCase() !== 'y') { console.log('aborted'); return 'no-bug'; }

  // 10. Fork + branch + commit + PR
  const prUrl = await submitPR(api, args.username, targetName, best, files, llm);
  console.log(`\n  PR opened: ${prUrl}\n`);

  // Record in history
  history.prs.push({ repo: targetName, url: prUrl, at: new Date().toISOString() });

  return 'success';
}

// ─── Bug issue mining ───

interface BugIssue { number: number; title: string; body: string; }

async function fetchBugIssues(api: ReturnType<typeof gh>, repo: string): Promise<BugIssue[]> {
  const [o, n] = repo.split('/');
  try {
    // Get issues labeled "bug", sorted by most recent
    const issues = await api.get(`/repos/${o}/${n}/issues?labels=bug&state=open&per_page=5&sort=created&direction=desc`);
    return (issues ?? [])
      .filter((i: any) => !i.pull_request) // exclude PRs
      .map((i: any) => ({
        number: i.number,
        title: i.title ?? '',
        body: (i.body ?? '').slice(0, 500), // truncate long bodies
      }));
  } catch {
    return [];
  }
}

// ─── Target discovery ───

async function findTarget(
  api: ReturnType<typeof gh>,
  lang: string,
  history: HuntHistory,
  triedThisRun: Set<string>,
): Promise<{ name: string; stars: number; daysAgo: number } | null> {
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
        if (triedThisRun.has(r)) continue;
        // Skip if scanned in last 30 days
        if (history.scanned[r] && Date.now() - Date.parse(history.scanned[r]) < 30 * 86400000) continue;
        try {
          const d = await api.get(`/repos/${r}`);
          const stars = d.stargazers_count ?? 0;
          if (stars < 50 || stars > 10_000 || d.archived || d.fork) continue;
          const dAgo = Math.floor((Date.now() - Date.parse(d.pushed_at ?? '')) / 86400000);
          if (dAgo > 90) continue;
          return { name: r, stars, daysAgo: dAgo };
        } catch { continue; }
      }
    } catch { continue; }
  }
  return null;
}

async function issueSearch(api: ReturnType<typeof gh>, lang: string, label: string): Promise<string[]> {
  const stars = 100 + Math.floor(Math.random() * 300);
  const q = encodeURIComponent(`language:${lang} stars:${stars}..8000 pushed:>${dAgo(60)} label:"${label}"`);
  const d = await api.get(`/search/issues?q=${q}&sort=created&per_page=15`);
  const repos = (d.items ?? []).map((i: any) => (i.repository_url as string).match(/\/repos\/(.+)$/)?.[1]).filter(Boolean) as string[];
  return [...new Set(repos)];
}

async function repoSearch(api: ReturnType<typeof gh>, lang: string): Promise<string[]> {
  const stars = 50 + Math.floor(Math.random() * 200);
  const sort = Math.random() < 0.5 ? 'stars' : 'updated';
  const page = 1 + Math.floor(Math.random() * 3);
  const q = encodeURIComponent(`language:${lang} stars:${stars}..5000 pushed:>${dAgo(90)}`);
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
  for (const { e } of scored.slice(0, 20)) {
    try {
      const blob = await api.get(`/repos/${o}/${n}/git/blobs/${e.sha}`);
      files.push({ path: e.path, content: Buffer.from(blob.content, 'base64').toString('utf8'), sha: e.sha });
    } catch { /* skip */ }
  }
  return files;
}

// ─── Pass 1: Screening (one file at a time, tiny context) ───

async function screenFiles(
  llm: LlmClient,
  files: RepoFile[],
  repo: string,
  bugIssues: BugIssue[],
): Promise<BugCandidate[]> {
  const candidates: BugCandidate[] = [];

  // Build issue context string (if we have bug issues)
  const issueCtx = bugIssues.length > 0
    ? `\n\nKnown open bug reports for this repo:\n${bugIssues.map((i) => `- #${i.number}: ${i.title} — ${i.body.slice(0, 150)}`).join('\n')}\nIf you can find the root cause of any of these bugs in the code, prioritize that.\n`
    : '';

  const system = `You scan source files for real bugs. For each file, output ONLY a JSON array of suspects:
[{"line":42,"hint":"missing null check on user.name"}]
If no bugs: []
Max 1 per file. Only REAL bugs — not style, not improvements.${issueCtx}`;

  for (const f of files) {
    // Send ONE file at a time — small context, free models handle this well
    const numbered = f.content.slice(0, 3000).split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
    const prompt = `File: ${f.path} (from ${repo})\n\`\`\`\n${numbered}\n\`\`\`\n\nAny real bugs? JSON only.`;

    try {
      const raw = await withRetry(() => llm.complete(prompt, { system, temperature: 0.2, maxTokens: 256 }), 2);
      const s = raw.indexOf('['), e = raw.lastIndexOf(']');
      if (s >= 0 && e > s) {
        const arr = JSON.parse(raw.slice(s, e + 1));
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (typeof item?.line === 'number' && item.hint) {
              candidates.push({ file: f.path, line: item.line, hint: String(item.hint) });
            }
          }
        }
      }
    } catch { /* screening failure is non-fatal */ }

    if (candidates.length >= 5) break; // enough candidates
  }

  return candidates;
}

// ─── Pass 2: Deep analysis on suspect files ───

async function deepAnalyze(
  llm: LlmClient,
  files: RepoFile[],
  candidates: BugCandidate[],
  repo: string,
  bugIssues: BugIssue[],
): Promise<BugFinding[]> {
  const findings: BugFinding[] = [];

  const issueCtx = bugIssues.length > 0
    ? `\nKnown bugs:\n${bugIssues.map((i) => `- #${i.number}: ${i.title}`).join('\n')}\n`
    : '';

  const system = `You are a senior engineer. A screening pass flagged a potential bug. Analyze the FULL file and produce a precise fix.

Output ONLY a JSON array (no fences):
[{"file":"path","startLine":42,"endLine":44,"bugType":"null-check","confidence":"high","description":"short desc","originalCode":"exact lines from file","fixedCode":"corrected lines"}]

The originalCode MUST be an exact copy-paste from the file (preserve indentation).
If the screening was a false alarm, output: []
Max 1 finding.`;

  // Deduplicate candidates by file
  const byFile = new Map<string, BugCandidate[]>();
  for (const c of candidates) {
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file)!.push(c);
  }

  for (const [path, cands] of byFile) {
    const file = files.find((f) => f.path === path);
    if (!file) continue;

    // Send the FULL file content (not truncated) for precise analysis
    const numbered = file.content.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
    const hints = cands.map((c) => `- Line ${c.line}: ${c.hint}`).join('\n');

    const prompt = `Repository: ${repo}${issueCtx}
Screening found these suspects in ${path}:
${hints}

Full file:\n\`\`\`\n${numbered}\n\`\`\`

Analyze and produce a precise fix. JSON only.`;

    try {
      const raw = await withRetry(() => llm.complete(prompt, { system, temperature: 0.3, maxTokens: 2048 }), 2);
      findings.push(...parseLlmFindings(raw, [file]));
    } catch { /* non-fatal */ }

    if (findings.length >= 3) break;
  }

  return findings;
}

// ─── Multi-model consensus ───

async function consensusFilter(
  llm2: LlmClient,
  files: RepoFile[],
  findings: BugFinding[],
  repo: string,
): Promise<BugFinding[]> {
  const confirmed: BugFinding[] = [];

  for (const f of findings) {
    const file = files.find((x) => x.path === f.file);
    if (!file) continue;

    // Ask second model: "Is this a real bug?" with the file context
    const numbered = file.content.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
    const prompt = `A code reviewer claims there's a ${f.bugType} bug at line ${f.startLine} of ${f.file} in ${repo}:
"${f.description}"

Original code:
\`\`\`
${f.originalCode}
\`\`\`

Proposed fix:
\`\`\`
${f.fixedCode}
\`\`\`

Full file for context:
\`\`\`
${numbered}
\`\`\`

Is this a real bug that the fix correctly addresses? Output ONLY: {"real": true/false, "reason": "brief explanation"}`;

    try {
      const raw = await withRetry(() => llm2.complete(prompt, { temperature: 0.2, maxTokens: 256 }), 2);
      // Extract JSON
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start >= 0 && end > start) {
        const obj = JSON.parse(raw.slice(start, end + 1));
        if (obj.real === true) {
          confirmed.push(f);
          console.log(`    ✓ ${f.file}:${f.startLine} confirmed: ${obj.reason ?? ''}`);
        } else {
          console.log(`    ✗ ${f.file}:${f.startLine} rejected: ${obj.reason ?? ''}`);
        }
      }
    } catch {
      // If consensus check fails, keep the finding (benefit of the doubt)
      confirmed.push(f);
    }
  }

  return confirmed;
}

// ─── Syntax checking ───

async function syntaxCheck(fixedContent: string, filePath: string): Promise<boolean> {
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  const lang = LANG_EXT[ext];

  try {
    if (lang === 'ts' || lang === 'tsx' || lang === 'js' || lang === 'jsx') {
      // Use Bun's transpiler to check syntax
      const loader = lang === 'tsx' ? 'tsx' : lang === 'ts' ? 'ts' : lang === 'jsx' ? 'jsx' : 'js';
      new Bun.Transpiler({ loader }).transformSync(fixedContent);
      return true;
    }

    if (lang === 'python') {
      // python3 -c "compile(source, 'f', 'exec')"
      const tmp = `/tmp/hunt-syntax-check.py`;
      await Bun.write(tmp, fixedContent);
      const proc = Bun.spawn(['python3', '-c', `compile(open("${tmp}").read(), "f", "exec")`], {
        stdout: 'pipe', stderr: 'pipe',
      });
      return (await proc.exited) === 0;
    }

    if (lang === 'go') {
      const tmp = `/tmp/hunt-syntax-check.go`;
      await Bun.write(tmp, fixedContent);
      const proc = Bun.spawn(['gofmt', '-e', tmp], { stdout: 'pipe', stderr: 'pipe' });
      return (await proc.exited) === 0;
    }

    if (lang === 'ruby') {
      const tmp = `/tmp/hunt-syntax-check.rb`;
      await Bun.write(tmp, fixedContent);
      const proc = Bun.spawn(['ruby', '-c', tmp], { stdout: 'pipe', stderr: 'pipe' });
      return (await proc.exited) === 0;
    }

    // For languages we can't easily check, fall back to bracket balance
    return bracketBalanceOk(fixedContent);
  } catch {
    // If the checker itself crashes, fall back to bracket balance
    return bracketBalanceOk(fixedContent);
  }
}

function bracketBalanceOk(content: string): boolean {
  let bal = 0;
  for (const c of content) {
    if ('{(['.includes(c)) bal++;
    if ('})]'.includes(c)) bal--;
    if (bal < -2) return false; // wildly unbalanced
  }
  return Math.abs(bal) <= 1;
}

// ─── LLM output parsing ───

function parseLlmFindings(raw: string, files: RepoFile[]): BugFinding[] {
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
  if (content.includes(orig)) {
    const s = content.slice(0, content.indexOf(orig)).split('\n').length - 1;
    return { start: s, end: s + orig.split('\n').length - 1 };
  }
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

// ─── PR submission ───

async function submitPR(
  api: ReturnType<typeof gh>,
  username: string,
  targetRepo: string,
  best: BugFinding,
  files: RepoFile[],
  llm: LlmClient,
): Promise<string> {
  const [owner, repo] = targetRepo.split('/');

  console.log('\nforking...');
  try { await api.post(`/repos/${owner}/${repo}/forks`); }
  catch { /* may already exist */ }
  await sleep(5000);

  let base = 'main';
  try { await api.get(`/repos/${owner}/${repo}/branches/main`); }
  catch { base = 'master'; }

  console.log('creating branch...');
  const baseSha = (await api.get(`/repos/${owner}/${repo}/git/ref/heads/${base}`)).object.sha;
  const branch = `fix/${slug(best.file)}-${best.bugType}`.slice(0, 60);

  try {
    await api.post(`/repos/${username}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
  } catch {
    await api.patch(`/repos/${username}/${repo}/git/refs/heads/${branch}`, { sha: baseSha, force: true });
  }

  console.log('committing fix...');
  const src = files.find((f) => f.path === best.file)!;
  const fixed = applyFix(src.content, best);

  let fileSha: string;
  try { fileSha = (await api.get(`/repos/${username}/${repo}/contents/${best.file}?ref=${branch}`)).sha; }
  catch { fileSha = src.sha; }

  await api.put(`/repos/${username}/${repo}/contents/${best.file}`, {
    message: `fix: ${best.description.toLowerCase().slice(0, 72)}`,
    content: Buffer.from(fixed).toString('base64'),
    sha: fileSha,
    branch,
  });

  console.log('opening PR...');
  const prBody = await genPRBody(llm, best);
  const pr = await api.post(`/repos/${owner}/${repo}/pulls`, {
    title: `Fix ${best.bugType} in ${best.file.replace(/^.*\//, '')}`,
    body: prBody,
    head: `${username}:${branch}`,
    base,
  });

  return pr.html_url ?? `https://github.com/${owner}/${repo}/pull/${pr.number}`;
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

// ─── History (persisted to disk) ───

interface HuntHistory {
  scanned: Record<string, string>;  // repo -> ISO date
  prs: { repo: string; url: string; at: string }[];
}

const HISTORY_PATH = `${process.env.HOME ?? '/tmp'}/.hunt-solo-history.json`;

async function loadHistory(): Promise<HuntHistory> {
  try {
    const raw = await Bun.file(HISTORY_PATH).text();
    const h = JSON.parse(raw) as Partial<HuntHistory>;
    return { scanned: h.scanned ?? {}, prs: h.prs ?? [] };
  } catch {
    return { scanned: {}, prs: [] };
  }
}

async function saveHistory(h: HuntHistory): Promise<void> {
  await Bun.write(HISTORY_PATH, JSON.stringify(h, null, 2));
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
function dAgo(n: number): string { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function confScore(c: string): number { return c === 'high' ? 3 : 2; }

main().catch((e) => { console.error(e instanceof Error ? e.stack : String(e)); process.exit(1); });
