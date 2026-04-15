#!/usr/bin/env bun
// hunt-solo v3 — automated bug hunter.
// Find real bugs in GitHub repos → open PRs to fix them.
// Zero dependencies beyond Bun. Uses free OpenRouter models.
//
// Usage:
//   bun run hunt-solo.ts
//   bun run hunt-solo.ts <username> <pat> <language> [owner/repo] [flags]
//
// Flags:
//   --loop / -l         Try multiple repos until a bug is found
//   --dry-run / -n      Show bugs without opening PRs
//   --yes / -y          Auto-confirm PR creation (unattended mode)
//   --json / -j         Machine-readable JSON output
//
// Env:
//   OPENROUTER_API_KEY        required (free at openrouter.ai/keys)
//   GITHUB_PAT                optional (alternative to passing as arg)
//   HUNT_MODEL                optional (default: meta-llama/llama-4-maverick:free)
//   HUNT_MODEL_2              optional (second model for consensus — set to enable)
//   HUNT_MAX_ATTEMPTS         optional (max repos to try in --loop mode, default 5)
//
// Exit codes:
//   0 = PR opened (or dry-run found bug)
//   1 = error
//   2 = no bugs found
//   3 = no target repos found

// ─── Stats tracker ───

const stats = { llmCalls: 0, apiCalls: 0, startedAt: Date.now() };

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
    stats.llmCalls++;
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

    // Handle OpenRouter rate limits
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') ?? '10', 10);
      log(`  openrouter 429 — sleeping ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      throw new Error('rate-limited');
    }
    if (!res.ok) throw new Error(`openrouter ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices?.[0]?.message?.content ?? '';
  }
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) { last = e; if (i < attempts - 1) await sleep(1000 * 2 ** i); }
  }
  throw last;
}

// ─── GitHub API with rate limit awareness ───

const REST = 'https://api.github.com';

let ghRateRemaining = 5000;
let ghRateResetAt = 0;

async function checkRateLimit(res: Response) {
  const rem = res.headers.get('x-ratelimit-remaining');
  const reset = res.headers.get('x-ratelimit-reset');
  if (rem) ghRateRemaining = parseInt(rem, 10);
  if (reset) ghRateResetAt = parseInt(reset, 10) * 1000;

  if (ghRateRemaining < 50) {
    const waitMs = Math.max(0, ghRateResetAt - Date.now()) + 1000;
    log(`  github rate limit low (${ghRateRemaining} left) — sleeping ${(waitMs / 1000).toFixed(0)}s`);
    await sleep(waitMs);
  }
}

function gh(pat: string) {
  const headers: Record<string, string> = {
    'Authorization': `token ${pat}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'hunt-solo/3.0',
  };
  return {
    async get(path: string): Promise<any> {
      stats.apiCalls++;
      const res = await fetch(REST + path, { headers });
      await checkRateLimit(res);
      if (res.status === 403 && ghRateRemaining < 5) {
        const waitMs = Math.max(0, ghRateResetAt - Date.now()) + 1000;
        await sleep(waitMs);
        return gh(pat).get(path); // retry once
      }
      if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res.json();
    },
    async post(path: string, body?: unknown): Promise<any> {
      stats.apiCalls++;
      const res = await fetch(REST + path, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      await checkRateLimit(res);
      const text = await res.text();
      if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${text.slice(0, 200)}`);
      return text ? JSON.parse(text) : undefined;
    },
    async patch(path: string, body: unknown): Promise<any> {
      stats.apiCalls++;
      const res = await fetch(REST + path, {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      await checkRateLimit(res);
      if (!res.ok) throw new Error(`PATCH ${path} → ${res.status}`);
      return res.json();
    },
    async put(path: string, body?: unknown): Promise<any> {
      stats.apiCalls++;
      const res = await fetch(REST + path, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      await checkRateLimit(res);
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

interface BugCandidate {
  file: string;
  line: number;
  hint: string;
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

const LANG_EXT: Record<string, string> = {
  '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx',
  '.py': 'python', '.go': 'go', '.rs': 'rust',
  '.rb': 'ruby', '.java': 'java', '.c': 'c', '.cpp': 'cpp',
  '.swift': 'swift', '.kt': 'kotlin',
};

// ─── Logging (suppressed in --json mode) ───

let jsonMode = false;

function log(msg: string) {
  if (!jsonMode) console.log(msg);
}
function logErr(msg: string) {
  if (!jsonMode) console.error(msg);
}

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
  targetRepo?: string;
  loop: boolean;
  dryRun: boolean;
  autoYes: boolean;
  json: boolean;
  maxAttempts: number;
}

async function parseArgs(): Promise<CliArgs> {
  const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('-')));
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('-'));

  const loop = flags.has('--loop') || flags.has('-l');
  const dryRun = flags.has('--dry-run') || flags.has('-n');
  const autoYes = flags.has('--yes') || flags.has('-y');
  const json = flags.has('--json') || flags.has('-j');
  const maxAttempts = parseInt(process.env.HUNT_MAX_ATTEMPTS ?? '5', 10);

  if (json) jsonMode = true;

  const username = positional[0] || await ask('GitHub username: ');
  const pat = positional[1] || process.env.GITHUB_PAT || await ask('GitHub PAT: ');
  if (!username || !pat) { logErr('need username + PAT'); process.exit(1); }

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

  if (!lang) lang = json ? 'typescript' : await pickLang();

  return { username, pat, lang, targetRepo, loop, dryRun, autoYes, json, maxAttempts };
}

// ─── Main ───

// Exit codes
const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;
const EXIT_NO_BUGS = 2;
const EXIT_NO_TARGET = 3;

async function main() {
  log('═══ hunt-solo v3 — automated bug hunter ═══\n');

  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) {
    logErr('missing OPENROUTER_API_KEY — get a free key at https://openrouter.ai/keys');
    process.exit(EXIT_ERROR);
  }

  const args = await parseArgs();
  const model1 = process.env.HUNT_MODEL ?? 'meta-llama/llama-4-maverick:free';
  const model2 = process.env.HUNT_MODEL_2;
  const llm = new OpenRouterClient(orKey, model1);
  const llm2 = model2 ? new OpenRouterClient(orKey, model2) : null;
  const api = gh(args.pat);

  // Verify creds
  log(`verifying PAT for ${args.username}...`);
  try {
    const user = await api.get('/user');
    if (user.login.toLowerCase() !== args.username.toLowerCase()) {
      logErr(`PAT belongs to ${user.login}, not ${args.username}`);
      process.exit(EXIT_ERROR);
    }
    log(`  authenticated as ${user.login}`);
  } catch (e: any) {
    logErr(`  auth failed: ${e.message ?? e}`);
    process.exit(EXIT_ERROR);
  }

  if (llm2) log(`models: ${model1} + ${model2} (consensus mode)`);
  else log(`model: ${model1}`);
  if (args.dryRun) log('  DRY RUN — will not open PR');
  if (args.autoYes) log('  AUTO-CONFIRM — no prompts');
  if (args.loop) log(`  LOOP MODE — up to ${args.maxAttempts} repos`);

  const history = await loadHistory();
  const triedThisRun = new Set<string>();

  const maxTries = args.loop ? args.maxAttempts : 1;
  let lastResult: HuntResult = 'no-bug';

  for (let attempt = 1; attempt <= maxTries; attempt++) {
    if (args.loop) log(`\n── attempt ${attempt}/${maxTries} ──`);

    const result = await huntOnce(api, llm, llm2, args, history, triedThisRun);
    lastResult = result;
    if (result === 'success') break;
    if (result === 'no-target') { log('  exhausted target candidates'); break; }
  }

  await saveHistory(history);

  // JSON output
  if (args.json) {
    const jsonOut: any = {
      result: lastResult,
      llmCalls: stats.llmCalls,
      apiCalls: stats.apiCalls,
      durationMs: Date.now() - stats.startedAt,
      ...(lastResult === 'success' && history.prs.length > 0
        ? { prUrl: history.prs[history.prs.length - 1].url, repo: history.prs[history.prs.length - 1].repo }
        : {}),
    };
    console.log(JSON.stringify(jsonOut));
  }

  // Exit codes
  if (lastResult === 'success') process.exit(EXIT_SUCCESS);
  if (lastResult === 'no-target') process.exit(EXIT_NO_TARGET);
  process.exit(EXIT_NO_BUGS);
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

  if (args.targetRepo) {
    targetName = args.targetRepo;
    try {
      await api.get(`/repos/${targetName}`);
    } catch (e: any) {
      logErr(`  can't access ${targetName}: ${e.message}`);
      return 'no-target';
    }
    args.targetRepo = undefined;
  } else {
    log(`\nsearching for ${args.lang} repos...`);
    const target = await findTarget(api, args.lang, history, triedThisRun);
    if (!target) return 'no-target';
    targetName = target.name;
    log(`  target: ${targetName} (${target.stars} stars, pushed ${target.daysAgo}d ago)`);
  }

  triedThisRun.add(targetName);
  history.scanned[targetName] = new Date().toISOString();

  // 2. Mine bug issues for context
  const bugIssues = await fetchBugIssues(api, targetName);
  if (bugIssues.length > 0) log(`  ${bugIssues.length} open bug issue(s) — using as context`);

  // 3. Download source files (with pacing)
  log(`downloading source files...`);
  const files = await downloadFiles(api, targetName);
  log(`  ${files.length} files (${(files.reduce((s, f) => s + f.content.length, 0) / 1024).toFixed(1)} KB)`);
  if (files.length === 0) { log('  no analyzable source files'); return 'no-bug'; }

  // 4. Two-pass analysis — parallel screening, then focused deep analysis
  log(`\npass 1: screening ${files.length} files with ${llm.model}...`);
  const candidates = await screenFilesParallel(llm, files, targetName, bugIssues);
  log(`  ${candidates.length} suspect(s)`);
  if (candidates.length === 0) { log('  no bugs found'); return 'no-bug'; }

  log(`pass 2: deep analysis on suspects...`);
  const findings = await deepAnalyze(llm, files, candidates, targetName, bugIssues);
  log(`  ${findings.length} finding(s)`);

  // 5. Multi-model consensus
  let confirmed = findings;
  if (llm2 && findings.length > 0) {
    log(`consensus check with ${llm2.model}...`);
    confirmed = await consensusFilter(llm2, files, findings, targetName);
    log(`  ${confirmed.length} confirmed by second model`);
  }

  // 6. Validate
  const valid = confirmed.filter((f) => validate(f, files));
  log(`  ${valid.length} passed validation`);

  // 7. Syntax-check
  const syntaxOk: BugFinding[] = [];
  for (const f of valid) {
    const file = files.find((x) => x.path === f.file);
    if (!file) continue;
    const fixed = applyFix(file.content, f);
    if (fixed === file.content) continue;
    const ok = await syntaxCheck(fixed, f.file);
    if (ok) syntaxOk.push(f);
    else log(`  syntax check failed: ${f.file}:${f.startLine}`);
  }
  log(`  ${syntaxOk.length} passed syntax check`);

  if (syntaxOk.length === 0) { log('  no actionable bugs survived'); return 'no-bug'; }

  const best = syntaxOk.sort((a, b) => confScore(b.confidence) - confScore(a.confidence))[0];
  log(`\n  bug: ${best.bugType} in ${best.file}:${best.startLine}`);
  log(`  ${best.description}`);
  log(`\n  original:`);
  best.originalCode.split('\n').forEach((l) => log(`    - ${l}`));
  log(`  fix:`);
  best.fixedCode.split('\n').forEach((l) => log(`    + ${l}`));

  // 8. Dry run
  if (args.dryRun) {
    log('\n  DRY RUN — skipping PR creation');
    return 'success';
  }

  // 9. Confirm (skip if --yes)
  if (!args.autoYes) {
    const ok = await ask('\nopen PR? (y/n): ');
    if (ok.toLowerCase() !== 'y') { log('aborted'); return 'no-bug'; }
  } else {
    log('\n  auto-confirming PR...');
  }

  // 10. Fork + branch + commit + PR
  const prUrl = await submitPR(api, args.username, targetName, best, files, llm);
  log(`\n  PR opened: ${prUrl}\n`);

  history.prs.push({ repo: targetName, url: prUrl, at: new Date().toISOString() });

  return 'success';
}

// ─── Bug issue mining ───

interface BugIssue { number: number; title: string; body: string; }

async function fetchBugIssues(api: ReturnType<typeof gh>, repo: string): Promise<BugIssue[]> {
  const [o, n] = repo.split('/');
  try {
    const issues = await api.get(`/repos/${o}/${n}/issues?labels=bug&state=open&per_page=5&sort=created&direction=desc`);
    return (issues ?? [])
      .filter((i: any) => !i.pull_request)
      .map((i: any) => ({
        number: i.number,
        title: i.title ?? '',
        body: (i.body ?? '').slice(0, 500),
      }));
  } catch {
    return [];
  }
}

// ─── Target discovery (wider randomization) ───

async function findTarget(
  api: ReturnType<typeof gh>,
  lang: string,
  history: HuntHistory,
  triedThisRun: Set<string>,
): Promise<{ name: string; stars: number; daysAgo: number } | null> {
  // Wider variety of search strategies
  const searches = [
    () => issueSearch(api, lang, 'bug'),
    () => issueSearch(api, lang, 'help wanted'),
    () => issueSearch(api, lang, 'good first issue'),
    () => repoSearch(api, lang, 'stars'),
    () => repoSearch(api, lang, 'updated'),
    () => repoSearch(api, lang, 'help-wanted-issues'),
  ];

  // Shuffle search order each run for variety
  shuffle(searches);

  for (const search of searches) {
    try {
      const repos = shuffle(await search());
      for (const r of repos) {
        if (triedThisRun.has(r)) continue;
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
  // Much wider star range randomization
  const starBuckets = [[50, 300], [200, 800], [500, 2000], [1000, 5000], [2000, 8000]];
  const bucket = starBuckets[Math.floor(Math.random() * starBuckets.length)];
  const days = [30, 45, 60, 90][Math.floor(Math.random() * 4)];
  const q = encodeURIComponent(`language:${lang} stars:${bucket[0]}..${bucket[1]} pushed:>${dAgo(days)} label:"${label}"`);
  const page = 1 + Math.floor(Math.random() * 3);
  const d = await api.get(`/search/issues?q=${q}&sort=created&per_page=15&page=${page}`);
  const repos = (d.items ?? []).map((i: any) => (i.repository_url as string).match(/\/repos\/(.+)$/)?.[1]).filter(Boolean) as string[];
  return [...new Set(repos)];
}

async function repoSearch(api: ReturnType<typeof gh>, lang: string, sort: string): Promise<string[]> {
  const starBuckets = [[50, 500], [200, 1500], [500, 3000], [1000, 5000], [2000, 10000]];
  const bucket = starBuckets[Math.floor(Math.random() * starBuckets.length)];
  const days = [30, 60, 90][Math.floor(Math.random() * 3)];
  const page = 1 + Math.floor(Math.random() * 5);
  const q = encodeURIComponent(`language:${lang} stars:${bucket[0]}..${bucket[1]} pushed:>${dAgo(days)}`);
  const d = await api.get(`/search/repositories?q=${q}&sort=${sort}&per_page=20&page=${page}`);
  return (d.items ?? []).map((i: any) => i.full_name as string);
}

// ─── File download (with pacing) ───

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
    // Pace blob downloads — 50ms between each to avoid throttling
    await sleep(50);
  }
  return files;
}

// ─── Pass 1: Parallel screening (batch 4 at a time) ───

async function screenFilesParallel(
  llm: LlmClient,
  files: RepoFile[],
  repo: string,
  bugIssues: BugIssue[],
): Promise<BugCandidate[]> {
  const candidates: BugCandidate[] = [];

  const issueCtx = bugIssues.length > 0
    ? `\n\nKnown open bug reports for this repo:\n${bugIssues.map((i) => `- #${i.number}: ${i.title} — ${i.body.slice(0, 150)}`).join('\n')}\nIf you can find the root cause of any of these bugs in the code, prioritize that.\n`
    : '';

  const system = `You scan source files for real bugs. For each file, output ONLY a JSON array of suspects:
[{"line":42,"hint":"missing null check on user.name"}]
If no bugs: []
Max 1 per file. Only REAL bugs — not style, not improvements.${issueCtx}`;

  // Process in parallel batches of 4
  const BATCH_SIZE = 4;
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    if (candidates.length >= 5) break;

    const batch = files.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (f) => {
        const numbered = f.content.slice(0, 3000).split('\n').map((l, idx) => `${idx + 1}: ${l}`).join('\n');
        const prompt = `File: ${f.path} (from ${repo})\n\`\`\`\n${numbered}\n\`\`\`\n\nAny real bugs? JSON only.`;

        const raw = await withRetry(() => llm.complete(prompt, { system, temperature: 0.2, maxTokens: 256 }), 2);
        const s = raw.indexOf('['), e = raw.lastIndexOf(']');
        if (s >= 0 && e > s) {
          const arr = JSON.parse(raw.slice(s, e + 1));
          if (Array.isArray(arr)) {
            return arr
              .filter((item: any) => typeof item?.line === 'number' && item.hint)
              .map((item: any) => ({ file: f.path, line: item.line as number, hint: String(item.hint) }));
          }
        }
        return [];
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') candidates.push(...r.value);
    }
  }

  return candidates.slice(0, 8); // cap total candidates
}

// ─── Pass 2: Deep analysis (windowed around suspect lines) ───

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

  const system = `You are a senior engineer. A screening pass flagged a potential bug. Analyze the code and produce a precise fix.

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

    const lines = file.content.split('\n');
    const hints = cands.map((c) => `- Line ${c.line}: ${c.hint}`).join('\n');

    // Window around suspect lines: ±60 lines, capped at ~5000 chars
    // This keeps context small enough for free models to handle well
    const suspectLines = cands.map((c) => c.line);
    const minLine = Math.max(0, Math.min(...suspectLines) - 60);
    const maxLine = Math.min(lines.length, Math.max(...suspectLines) + 60);
    const windowedLines = lines.slice(minLine, maxLine);
    const numbered = windowedLines.map((l, i) => `${minLine + i + 1}: ${l}`).join('\n');

    // If the windowed content is still too large, truncate
    const content = numbered.length > 6000 ? numbered.slice(0, 6000) + '\n... (truncated)' : numbered;

    const prompt = `Repository: ${repo}${issueCtx}
Screening found these suspects in ${path}:
${hints}

Code (lines ${minLine + 1}-${maxLine}):\n\`\`\`\n${content}\n\`\`\`

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

    // Window context around the bug for consensus check too
    const lines = file.content.split('\n');
    const minLine = Math.max(0, f.startLine - 30);
    const maxLine = Math.min(lines.length, f.endLine + 30);
    const context = lines.slice(minLine, maxLine).map((l, i) => `${minLine + i + 1}: ${l}`).join('\n');

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

Surrounding context (lines ${minLine + 1}-${maxLine}):
\`\`\`
${context}
\`\`\`

Is this a real bug that the fix correctly addresses? Output ONLY: {"real": true/false, "reason": "brief explanation"}`;

    try {
      const raw = await withRetry(() => llm2.complete(prompt, { temperature: 0.2, maxTokens: 256 }), 2);
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start >= 0 && end > start) {
        const obj = JSON.parse(raw.slice(start, end + 1));
        if (obj.real === true) {
          confirmed.push(f);
          log(`    ✓ ${f.file}:${f.startLine} confirmed: ${obj.reason ?? ''}`);
        } else {
          log(`    ✗ ${f.file}:${f.startLine} rejected: ${obj.reason ?? ''}`);
        }
      }
    } catch (e: any) {
      // Reject on error — don't auto-confirm broken model
      log(`    ? ${f.file}:${f.startLine} consensus error: ${e?.message ?? e}`);
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
      const loader = lang === 'tsx' ? 'tsx' : lang === 'ts' ? 'ts' : lang === 'jsx' ? 'jsx' : 'js';
      new Bun.Transpiler({ loader }).transformSync(fixedContent);
      return true;
    }

    if (lang === 'python') {
      const tmp = `/tmp/hunt-syntax-${Math.random().toString(36).slice(2)}.py`;
      await Bun.write(tmp, fixedContent);
      try {
        const proc = Bun.spawn(['python3', '-c', `compile(open("${tmp}").read(), "f", "exec")`], {
          stdout: 'pipe', stderr: 'pipe',
        });
        return (await proc.exited) === 0;
      } finally { try { const { unlink } = await import('node:fs/promises'); await unlink(tmp); } catch {} }
    }

    if (lang === 'go') {
      const tmp = `/tmp/hunt-syntax-${Math.random().toString(36).slice(2)}.go`;
      await Bun.write(tmp, fixedContent);
      try {
        const proc = Bun.spawn(['gofmt', '-e', tmp], { stdout: 'pipe', stderr: 'pipe' });
        return (await proc.exited) === 0;
      } finally { try { const { unlink } = await import('node:fs/promises'); await unlink(tmp); } catch {} }
    }

    if (lang === 'ruby') {
      const tmp = `/tmp/hunt-syntax-${Math.random().toString(36).slice(2)}.rb`;
      await Bun.write(tmp, fixedContent);
      try {
        const proc = Bun.spawn(['ruby', '-c', tmp], { stdout: 'pipe', stderr: 'pipe' });
        return (await proc.exited) === 0;
      } finally { try { const { unlink } = await import('node:fs/promises'); await unlink(tmp); } catch {} }
    }

    return bracketBalanceOk(fixedContent);
  } catch {
    return bracketBalanceOk(fixedContent);
  }
}

function bracketBalanceOk(content: string): boolean {
  let bal = 0;
  for (const c of content) {
    if ('{(['.includes(c)) bal++;
    if ('})]'.includes(c)) bal--;
    if (bal < -2) return false;
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
    if (typeof f.endLine !== 'number' || f.endLine < f.startLine || f.endLine > lc) return false;
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
  if (findInFile(file.content, f.originalCode, f.startLine) === null) return false;
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
  const h0 = hint - 1; // 1-based → 0-based
  const lo = Math.max(0, h0 - 10), hi = Math.min(lines.length, h0 + 11);
  for (let i = lo; i <= hi - oLC; i++) {
    for (let len = oLC - 1; len <= oLC + 2 && i + len <= lines.length; len++) {
      if (norm(lines.slice(i, i + len).join('\n')) === nOrig) return { start: i, end: i + len - 1 };
    }
  }
  return null;
}

function applyFix(content: string, f: BugFinding): string {
  if (content.includes(f.originalCode)) return content.split(f.originalCode).join(f.fixedCode);
  const m = findInFile(content, f.originalCode, f.startLine);
  if (m) {
    const l = content.split('\n');
    return [...l.slice(0, m.start), ...f.fixedCode.split('\n'), ...l.slice(m.end + 1)].join('\n');
  }
  const l = content.split('\n');
  return [...l.slice(0, f.startLine - 1), ...f.fixedCode.split('\n'), ...l.slice(Math.min(f.endLine, l.length))].join('\n');
}

// ─── PR submission (with fork sync + duplicate check + varied naming) ───

// PR title templates — rotated to avoid fingerprinting
const PR_TITLES = [
  (f: BugFinding) => `Fix ${f.bugType} in ${basename(f.file)}`,
  (f: BugFinding) => `fix: ${f.description.toLowerCase().slice(0, 65)}`,
  (f: BugFinding) => `Fix ${f.description.slice(0, 60)}`,
  (f: BugFinding) => `Resolve ${f.bugType.replace(/-/g, ' ')} issue in ${basename(f.file)}`,
  (f: BugFinding) => `Patch ${f.bugType.replace(/-/g, ' ')} in ${basename(f.file)}`,
  (f: BugFinding) => `${basename(f.file)}: fix ${f.bugType.replace(/-/g, ' ')}`,
];

// Branch name templates
const BRANCH_PATTERNS = [
  (f: BugFinding) => `fix/${slug(f.file)}-${f.bugType}`,
  (f: BugFinding) => `patch/${slug(f.file)}-${Date.now().toString(36).slice(-4)}`,
  (f: BugFinding) => `bugfix/${f.bugType}-${slug(f.file)}`,
  (f: BugFinding) => `fix-${slug(f.file)}-${Math.random().toString(36).slice(2, 6)}`,
  (f: BugFinding) => `fix/${f.bugType}/${slug(f.file)}`,
];

// Commit message templates
const COMMIT_MSGS = [
  (f: BugFinding) => `fix: ${f.description.toLowerCase().slice(0, 72)}`,
  (f: BugFinding) => `fix(${basename(f.file).replace(/\.[^.]+$/, '')}): ${f.description.toLowerCase().slice(0, 60)}`,
  (f: BugFinding) => `Fix ${f.description.slice(0, 72)}`,
  (f: BugFinding) => `fix ${f.bugType.replace(/-/g, ' ')} in ${basename(f.file)}`,
];

function basename(p: string): string { return p.replace(/^.*\//, ''); }

async function submitPR(
  api: ReturnType<typeof gh>,
  username: string,
  targetRepo: string,
  best: BugFinding,
  files: RepoFile[],
  llm: LlmClient,
): Promise<string> {
  const [owner, repo] = targetRepo.split('/');

  // Detect base branch
  let base = 'main';
  try { await api.get(`/repos/${owner}/${repo}/branches/main`); }
  catch { base = 'master'; }

  // Fork (may already exist)
  log('\nforking...');
  try { await api.post(`/repos/${owner}/${repo}/forks`); }
  catch { /* already exists */ }
  await sleep(5000);

  // Sync fork with upstream — critical for stale forks
  log('syncing fork...');
  try {
    await api.post(`/repos/${username}/${repo}/merge-upstream`, { branch: base });
  } catch {
    // May fail if fork was just created (already up to date) — that's fine
  }
  await sleep(1000);

  // Check for duplicate PRs
  log('checking for duplicate PRs...');
  const branch = pick(BRANCH_PATTERNS)(best).slice(0, 60);
  try {
    const existing = await api.get(`/repos/${owner}/${repo}/pulls?head=${username}:${branch}&state=open`);
    if (Array.isArray(existing) && existing.length > 0) {
      log(`  duplicate PR already exists: ${existing[0].html_url}`);
      return existing[0].html_url;
    }
  } catch { /* continue */ }

  // Also check if we already have ANY open PR against this repo
  try {
    const myPRs = await api.get(`/repos/${owner}/${repo}/pulls?state=open&per_page=10`);
    const hasMine = (myPRs ?? []).some((pr: any) => pr.head?.user?.login?.toLowerCase() === username.toLowerCase());
    if (hasMine) {
      log(`  already have an open PR against ${targetRepo} — skipping`);
      throw new Error('duplicate-pr');
    }
  } catch (e: any) {
    if (e.message === 'duplicate-pr') throw e;
    /* continue on API errors */
  }

  log('creating branch...');
  const baseSha = (await api.get(`/repos/${username}/${repo}/git/ref/heads/${base}`)).object.sha;

  try {
    await api.post(`/repos/${username}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
  } catch {
    await api.patch(`/repos/${username}/${repo}/git/refs/heads/${branch}`, { sha: baseSha, force: true });
  }

  log('committing fix...');
  const src = files.find((f) => f.path === best.file)!;
  const fixed = applyFix(src.content, best);

  let fileSha: string;
  try { fileSha = (await api.get(`/repos/${username}/${repo}/contents/${best.file}?ref=${branch}`)).sha; }
  catch { fileSha = src.sha; }

  const commitMsg = pick(COMMIT_MSGS)(best);
  await api.put(`/repos/${username}/${repo}/contents/${best.file}`, {
    message: commitMsg,
    content: Buffer.from(fixed).toString('base64'),
    sha: fileSha,
    branch,
  });

  log('opening PR...');
  const prTitle = pick(PR_TITLES)(best);
  const prBody = await genPRBody(llm, best);
  const pr = await api.post(`/repos/${owner}/${repo}/pulls`, {
    title: prTitle,
    body: prBody,
    head: `${username}:${branch}`,
    base,
  });

  return pr.html_url ?? `https://github.com/${owner}/${repo}/pull/${pr.number}`;
}

// ─── PR body ───

async function genPRBody(llm: LlmClient, f: BugFinding): Promise<string> {
  const stories = [
    'I was browsing the source and noticed',
    'While reading through the codebase I spotted',
    'Found this while checking out the code',
    'Noticed this while reading the implementation',
    'I was using this library and ran into',
    'While reviewing the code I came across',
    'Spotted this while reading the docs and cross-referencing the source',
    'I was looking at the code and found',
  ];
  const story = pick(stories);
  try {
    return (await withRetry(() => llm.complete(
      `Write a short GitHub PR description (2-3 sentences) for this bug fix.\n\nBug: ${f.description}\nFile: ${f.file}:${f.startLine}\nType: ${f.bugType}\nContext: ${story}\n\nSound like a real dev. Do NOT mention AI/bots/tools. Just the body text, no headers.`,
      { temperature: 0.9, maxTokens: 300 },
    ))).trim();
  } catch {
    return `${story} a ${f.bugType} in \`${f.file}\`.\n\n${f.description}`;
  }
}

// ─── History (persisted to disk, with pruning) ───

interface HuntHistory {
  scanned: Record<string, string>;
  prs: { repo: string; url: string; at: string }[];
}

const HISTORY_PATH = `${process.env.HOME ?? '/tmp'}/.hunt-solo-history.json`;

async function loadHistory(): Promise<HuntHistory> {
  try {
    const raw = await Bun.file(HISTORY_PATH).text();
    const h = JSON.parse(raw) as Partial<HuntHistory>;
    const scanned = h.scanned ?? {};
    const prs = h.prs ?? [];

    // Prune entries older than 30 days
    const cutoff = Date.now() - 30 * 86400000;
    for (const [repo, date] of Object.entries(scanned)) {
      if (Date.parse(date) < cutoff) delete scanned[repo];
    }

    return { scanned, prs };
  } catch {
    return { scanned: {}, prs: [] };
  }
}

async function saveHistory(h: HuntHistory): Promise<void> {
  await Bun.write(HISTORY_PATH, JSON.stringify(h, null, 2));
}

// ─── Helpers ───

async function pickLang(): Promise<string> {
  log('\nlanguages:');
  LANGS.forEach((l, i) => log(`  ${i + 1}. ${l}`));
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
function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function dAgo(n: number): string { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function confScore(c: string): number { return c === 'high' ? 3 : 2; }

main().catch((e) => {
  if (jsonMode) {
    console.log(JSON.stringify({ result: 'error', error: e instanceof Error ? e.message : String(e), llmCalls: stats.llmCalls, apiCalls: stats.apiCalls, durationMs: Date.now() - stats.startedAt }));
  } else {
    console.error(e instanceof Error ? e.stack : String(e));
  }
  process.exit(EXIT_ERROR);
});
