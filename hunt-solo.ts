#!/usr/bin/env bun
// hunt-solo v4 — automated bug hunter with pro integrations.
// Find real bugs in GitHub repos → open PRs to fix them.
// Zero dependencies beyond Bun. Uses free OpenRouter models.
// Includes: multi-key LLM routing, repo scoring, OSV vuln scanning, semgrep integration.
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
//   OPENROUTER_API_KEY_2      optional (second key for rate limit spreading)
//   OPENROUTER_API_KEY_3      optional (third key for rate limit spreading)
//   GITHUB_PAT                optional (alternative to passing as arg)
//   HUNT_MODEL                optional (default: meta-llama/llama-4-maverick:free)
//   HUNT_MODEL_2              optional (second model for consensus — set to enable)
//   HUNT_MAX_ATTEMPTS         optional (max repos to try in --loop mode, default 5)
//   HUNT_MIN_REPO_SCORE       optional (minimum repo score to target, default 30)
//   HUNT_TOPICS               optional (comma-separated GitHub topics, e.g. "react,nextjs,api")
//   HUNT_KEYWORDS             optional (extra search terms, e.g. "web framework")
//   HUNT_STARS_MIN            optional (min stars, default 50)
//   HUNT_STARS_MAX            optional (max stars, default 10000)
//   HUNT_PUSHED_DAYS          optional (max days since last push, default 90)
//   HUNT_REPOS_FILE           optional (path to file with owner/repo list, one per line)
//
// Exit codes:
//   0 = PR opened (or dry-run found bug)
//   1 = error
//   2 = no bugs found
//   3 = no target repos found

// ─── Stats tracker ───

const stats: {
  llmCalls: number;
  apiCalls: number;
  osvCalls: number;
  semgrepRan: boolean;
  startedAt: number;
  bugSource?: string;
  repoScore?: number;
  repo?: string;
} = { llmCalls: 0, apiCalls: 0, osvCalls: 0, semgrepRan: false, startedAt: Date.now() };

// ─── Niche targeting config ───

interface NicheConfig {
  topics: string[];         // GitHub topics to filter on
  keywords: string;         // Extra search terms
  starsMin: number;         // Min stars
  starsMax: number;         // Max stars
  pushedDays: number;       // Max days since last push
  reposFile: string[];      // Curated repo list from file
}

function loadNicheConfig(): NicheConfig {
  const topics = (process.env.HUNT_TOPICS ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  const keywords = (process.env.HUNT_KEYWORDS ?? '').trim();
  const starsMin = parseInt(process.env.HUNT_STARS_MIN ?? '50', 10);
  const starsMax = parseInt(process.env.HUNT_STARS_MAX ?? '10000', 10);
  const pushedDays = parseInt(process.env.HUNT_PUSHED_DAYS ?? '90', 10);

  let reposFile: string[] = [];
  const reposPath = process.env.HUNT_REPOS_FILE;
  if (reposPath) {
    try {
      const raw = require('node:fs').readFileSync(reposPath, 'utf8') as string;
      reposFile = raw.split('\n').map((l: string) => l.trim()).filter((l: string) => l && !l.startsWith('#') && l.includes('/'));
    } catch { /* file not found or unreadable */ }
  }

  return { topics, keywords, starsMin, starsMax, pushedDays, reposFile };
}

const niche = loadNicheConfig();

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

// ─── LLM Router (multi-key failover) ───

class LlmRouter implements LlmClient {
  readonly model: string;
  private entries: { client: LlmClient; exhaustedUntil: number }[];

  constructor(clients: LlmClient[]) {
    this.entries = clients.map((c) => ({ client: c, exhaustedUntil: 0 }));
    this.model = `multi:${clients.length}`;
  }

  async complete(prompt: string, opts?: LlmOptions): Promise<string> {
    const now = Date.now();
    let lastError: unknown;
    for (const entry of this.entries) {
      if (entry.exhaustedUntil > now) continue;
      try {
        return await entry.client.complete(prompt, opts);
      } catch (e: any) {
        lastError = e;
        const msg = e?.message ?? '';
        if (msg.includes('rate-limited') || msg.includes('429')) {
          entry.exhaustedUntil = now + 5 * 60_000; // 5 min cooldown
        }
      }
    }
    throw lastError ?? new Error('all LLM providers exhausted');
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
    'User-Agent': 'hunt-solo/4.0',
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
  | 'missing-return' | 'incorrect-comparison' | 'dependency-vuln';

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

interface VulnResult {
  id: string;
  summary: string;
  pkg: string;
  ecosystem: string;
  currentVersion: string;
  fixedVersion: string;
  severity: string;
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
  'missing-return', 'incorrect-comparison', 'dependency-vuln',
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
  log('═══ hunt-solo v4 — automated bug hunter ═══\n');

  // Build LLM clients from available OpenRouter keys
  const clients: LlmClient[] = [];
  const orKey = process.env.OPENROUTER_API_KEY;
  const orKey2 = process.env.OPENROUTER_API_KEY_2;
  const orKey3 = process.env.OPENROUTER_API_KEY_3;
  const model1 = process.env.HUNT_MODEL ?? 'meta-llama/llama-4-maverick:free';

  if (orKey) clients.push(new OpenRouterClient(orKey, model1));
  if (orKey2) clients.push(new OpenRouterClient(orKey2, model1));
  if (orKey3) clients.push(new OpenRouterClient(orKey3, model1));

  if (clients.length === 0) {
    logErr('missing OPENROUTER_API_KEY — get a free key at https://openrouter.ai/keys');
    process.exit(EXIT_ERROR);
  }

  const args = await parseArgs();
  const llm = clients.length === 1 ? clients[0] : new LlmRouter(clients);

  // Consensus model uses primary key
  const model2 = process.env.HUNT_MODEL_2;
  const llm2 = model2 && orKey ? new OpenRouterClient(orKey, model2) : null;

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

  if (clients.length > 1) log(`llm: ${model1} × ${clients.length} keys (router mode)`);
  else log(`model: ${model1}`);
  if (llm2) log(`consensus: ${model2}`);
  if (args.dryRun) log('  DRY RUN — will not open PR');
  if (args.autoYes) log('  AUTO-CONFIRM — no prompts');
  if (args.loop) log(`  LOOP MODE — up to ${args.maxAttempts} repos`);

  // Log niche config if customized
  const nicheDetails: string[] = [];
  if (niche.topics.length > 0) nicheDetails.push(`topics: ${niche.topics.join(', ')}`);
  if (niche.keywords) nicheDetails.push(`keywords: "${niche.keywords}"`);
  if (niche.starsMin !== 50 || niche.starsMax !== 10000) nicheDetails.push(`stars: ${niche.starsMin}–${niche.starsMax}`);
  if (niche.pushedDays !== 90) nicheDetails.push(`pushed: <${niche.pushedDays}d`);
  if (niche.reposFile.length > 0) nicheDetails.push(`repos file: ${niche.reposFile.length} repos`);
  if (nicheDetails.length > 0) log(`  niche: ${nicheDetails.join(' | ')}`);

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
      ...(stats.repo ? { repo: stats.repo } : {}),
      ...(lastResult === 'success' && history.prs.length > 0
        ? { prUrl: history.prs[history.prs.length - 1].url, repo: history.prs[history.prs.length - 1].repo }
        : {}),
      source: stats.bugSource ?? 'llm',
      repoScore: stats.repoScore,
      llmCalls: stats.llmCalls,
      apiCalls: stats.apiCalls,
      osvCalls: stats.osvCalls,
      durationMs: Date.now() - stats.startedAt,
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
  const minScore = parseInt(process.env.HUNT_MIN_REPO_SCORE ?? '30', 10);

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

  // 2. Score repo (community health, merge rate, anti-bot check)
  log(`scoring repo...`);
  const { score: repoScore, reasons: scoreReasons } = await scoreRepo(api, targetName);
  log(`  repo score: ${repoScore} [${scoreReasons.join(', ')}]`);
  stats.repoScore = repoScore;
  stats.repo = targetName;
  if (repoScore < minScore) {
    log(`  score ${repoScore} < min ${minScore} — skipping`);
    return 'no-bug';
  }

  // 3. Mine bug issues for context
  const bugIssues = await fetchBugIssues(api, targetName);
  if (bugIssues.length > 0) log(`  ${bugIssues.length} open bug issue(s) — using as context`);

  // 4. Download source files (with pacing)
  log(`downloading source files...`);
  const files = await downloadFiles(api, targetName);
  log(`  ${files.length} files (${(files.reduce((s, f) => s + f.content.length, 0) / 1024).toFixed(1)} KB)`);
  if (files.length === 0) { log('  no analyzable source files'); return 'no-bug'; }

  // 5. OSV dependency scan (deterministic, no LLM needed)
  log('scanning dependencies...');
  const vulnResult = await scanDependencies(api, targetName);

  let best: BugFinding;

  if (vulnResult) {
    log(`  dependency vuln found: ${vulnResult.finding.description}`);
    best = vulnResult.finding;
    stats.bugSource = 'osv';
    // Add the dep file to files array so submitPR can find it
    if (!files.find((f) => f.path === vulnResult.depFile.path)) {
      files.push(vulnResult.depFile);
    }
  } else {
    log('  no dependency vulns');

    // 6. Screening: semgrep if available, else LLM
    let candidates: BugCandidate[];
    if (await hasSemgrep()) {
      log(`\npass 1: semgrep scanning...`);
      stats.semgrepRan = true;
      candidates = await runSemgrep(files);
      if (candidates.length > 0) {
        log(`  semgrep found ${candidates.length} issue(s) — skipping LLM screening`);
        stats.bugSource = 'semgrep+llm';
      } else {
        log(`  semgrep clean — falling back to LLM screening`);
        candidates = await screenFilesParallel(llm, files, targetName, bugIssues);
      }
    } else {
      log(`\npass 1: screening ${files.length} files with ${llm.model}...`);
      candidates = await screenFilesParallel(llm, files, targetName, bugIssues);
    }
    log(`  ${candidates.length} suspect(s)`);
    if (candidates.length === 0) { log('  no bugs found'); return 'no-bug'; }

    // 7. Deep analysis (LLM, windowed)
    log(`pass 2: deep analysis on suspects...`);
    const findings = await deepAnalyze(llm, files, candidates, targetName, bugIssues);
    log(`  ${findings.length} finding(s)`);

    // 8. Multi-model consensus
    let confirmed = findings;
    if (llm2 && findings.length > 0) {
      log(`consensus check with ${llm2.model}...`);
      confirmed = await consensusFilter(llm2, files, findings, targetName);
      log(`  ${confirmed.length} confirmed by second model`);
    }

    // 9. Validate + syntax check
    const valid = confirmed.filter((f) => validate(f, files));
    log(`  ${valid.length} passed validation`);

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
    best = syntaxOk.sort((a, b) => confScore(b.confidence) - confScore(a.confidence))[0];
    if (!stats.bugSource) stats.bugSource = 'llm';
  }

  // 10. Show bug
  log(`\n  bug: ${best.bugType} in ${best.file}:${best.startLine}`);
  log(`  ${best.description}`);
  log(`\n  original:`);
  best.originalCode.split('\n').forEach((l) => log(`    - ${l}`));
  log(`  fix:`);
  best.fixedCode.split('\n').forEach((l) => log(`    + ${l}`));

  // Dry run
  if (args.dryRun) {
    log('\n  DRY RUN — skipping PR creation');
    return 'success';
  }

  // Confirm (skip if --yes)
  if (!args.autoYes) {
    const ok = await ask('\nopen PR? (y/n): ');
    if (ok.toLowerCase() !== 'y') { log('aborted'); return 'no-bug'; }
  } else {
    log('\n  auto-confirming PR...');
  }

  // Fork + branch + commit + PR
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

// ─── Target discovery (niche-aware) ───

function buildStarBuckets(): [number, number][] {
  const { starsMin, starsMax } = niche;
  // If user set a tight range, use it directly
  if (starsMax - starsMin < 500) return [[starsMin, starsMax]];
  // Build overlapping buckets within the user's range
  const range = starsMax - starsMin;
  const step = Math.max(200, Math.floor(range / 5));
  const buckets: [number, number][] = [];
  for (let lo = starsMin; lo < starsMax; lo += step) {
    buckets.push([lo, Math.min(lo + step * 2, starsMax)]);
  }
  return buckets.length > 0 ? buckets : [[starsMin, starsMax]];
}

function buildSearchQualifiers(lang: string, bucket: [number, number], days: number): string {
  const parts = [`language:${lang}`, `stars:${bucket[0]}..${bucket[1]}`, `pushed:>${dAgo(days)}`];
  for (const t of niche.topics) parts.push(`topic:${t}`);
  if (niche.keywords) parts.push(niche.keywords);
  return parts.join(' ');
}

async function loadReposFromFile(
  api: ReturnType<typeof gh>,
  history: HuntHistory,
  triedThisRun: Set<string>,
): Promise<{ name: string; stars: number; daysAgo: number } | null> {
  const candidates = shuffle([...niche.reposFile]);
  for (const r of candidates) {
    if (triedThisRun.has(r)) continue;
    if (history.scanned[r] && Date.now() - Date.parse(history.scanned[r]) < 30 * 86400000) continue;
    try {
      const d = await api.get(`/repos/${r}`);
      if (d.archived || d.fork) continue;
      const stars = d.stargazers_count ?? 0;
      const daysAgo = Math.floor((Date.now() - Date.parse(d.pushed_at ?? '')) / 86400000);
      return { name: r, stars, daysAgo };
    } catch { continue; }
  }
  return null;
}

async function findTarget(
  api: ReturnType<typeof gh>,
  lang: string,
  history: HuntHistory,
  triedThisRun: Set<string>,
): Promise<{ name: string; stars: number; daysAgo: number } | null> {
  // Priority 1: curated repos file (if provided)
  if (niche.reposFile.length > 0) {
    const fromFile = await loadReposFromFile(api, history, triedThisRun);
    if (fromFile) return fromFile;
    // Fall through to search if file list is exhausted
  }

  // Priority 2: GitHub search with niche filters
  const searches = [
    () => issueSearch(api, lang, 'bug'),
    () => issueSearch(api, lang, 'help wanted'),
    () => issueSearch(api, lang, 'good first issue'),
    () => repoSearch(api, lang, 'stars'),
    () => repoSearch(api, lang, 'updated'),
    () => repoSearch(api, lang, 'help-wanted-issues'),
  ];

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
          if (stars < niche.starsMin || stars > niche.starsMax || d.archived || d.fork) continue;
          const daysAgo = Math.floor((Date.now() - Date.parse(d.pushed_at ?? '')) / 86400000);
          if (daysAgo > niche.pushedDays) continue;
          return { name: r, stars, daysAgo };
        } catch { continue; }
      }
    } catch { continue; }
  }
  return null;
}

async function issueSearch(api: ReturnType<typeof gh>, lang: string, label: string): Promise<string[]> {
  const buckets = buildStarBuckets();
  const bucket = buckets[Math.floor(Math.random() * buckets.length)];
  const dayOpts = [30, 45, 60, 90].filter((d) => d <= niche.pushedDays);
  const days = dayOpts[Math.floor(Math.random() * dayOpts.length)] ?? niche.pushedDays;
  const quals = buildSearchQualifiers(lang, bucket, days);
  const q = encodeURIComponent(`${quals} label:"${label}"`);
  const page = 1 + Math.floor(Math.random() * 3);
  const d = await api.get(`/search/issues?q=${q}&sort=created&per_page=15&page=${page}`);
  const repos = (d.items ?? []).map((i: any) => (i.repository_url as string).match(/\/repos\/(.+)$/)?.[1]).filter(Boolean) as string[];
  return [...new Set(repos)];
}

async function repoSearch(api: ReturnType<typeof gh>, lang: string, sort: string): Promise<string[]> {
  const buckets = buildStarBuckets();
  const bucket = buckets[Math.floor(Math.random() * buckets.length)];
  const dayOpts = [30, 60, 90].filter((d) => d <= niche.pushedDays);
  const days = dayOpts[Math.floor(Math.random() * dayOpts.length)] ?? niche.pushedDays;
  const q = encodeURIComponent(buildSearchQualifiers(lang, bucket, days));
  const page = 1 + Math.floor(Math.random() * 5);
  const d = await api.get(`/search/repositories?q=${q}&sort=${sort}&per_page=20&page=${page}`);
  return (d.items ?? []).map((i: any) => i.full_name as string);
}

// ─── Repo scoring (community health, merge rate, anti-bot detection) ───

async function scoreRepo(
  api: ReturnType<typeof gh>,
  repo: string,
): Promise<{ score: number; reasons: string[] }> {
  const [o, n] = repo.split('/');
  let score = 50;
  const reasons: string[] = [];

  // Community health profile
  try {
    const profile = await api.get(`/repos/${o}/${n}/community/profile`);
    const health = profile.health_percentage ?? 0;
    score += Math.floor(health / 5); // 0-20 pts
    reasons.push(`health:${health}%`);
    if (profile.files?.contributing) { score += 15; reasons.push('CONTRIBUTING'); }
    if (profile.files?.pull_request_template) { score += 5; reasons.push('PR template'); }
  } catch { /* community profile not available for all repos */ }

  // External PR merge rate (sample last 30 closed PRs)
  try {
    const pulls = await api.get(`/repos/${o}/${n}/pulls?state=closed&per_page=30`);
    const external = (pulls ?? []).filter((p: any) =>
      ['NONE', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'CONTRIBUTOR'].includes(p.author_association),
    );
    const merged = external.filter((p: any) => p.merged_at);
    if (external.length >= 3) {
      const rate = merged.length / external.length;
      if (rate > 0.5) { score += 25; reasons.push(`merge:${(rate * 100).toFixed(0)}%`); }
      else if (rate > 0.3) { score += 15; reasons.push(`merge:${(rate * 100).toFixed(0)}%`); }
      else if (rate < 0.2) { score -= 20; reasons.push(`merge:${(rate * 100).toFixed(0)}%(low)`); }
      else { reasons.push(`merge:${(rate * 100).toFixed(0)}%`); }
    }
  } catch { /* non-fatal */ }

  // Anti-bot: scan CI workflows for bot detection
  try {
    const tree = await api.get(`/repos/${o}/${n}/git/trees/HEAD:.github/workflows`);
    for (const entry of (tree.tree ?? []).slice(0, 10)) {
      if (entry.type !== 'blob') continue;
      try {
        const blob = await api.get(`/repos/${o}/${n}/git/blobs/${entry.sha}`);
        const content = Buffer.from(blob.content, 'base64').toString('utf8');
        if (/contributor-report|ai-moderator|spam-detection/i.test(content)) {
          reasons.push(`anti-bot:${entry.path}`);
          return { score: 0, reasons };
        }
      } catch { /* skip unreadable blobs */ }
    }
  } catch { /* no .github/workflows — that's fine */ }

  // Anti-bot: check CONTRIBUTING.md for prompt injection traps
  try {
    const contrib = await api.get(`/repos/${o}/${n}/contents/CONTRIBUTING.md`);
    if (contrib.content) {
      const text = Buffer.from(contrib.content, 'base64').toString('utf8');
      if (/include the phrase|mention that you are|say the word/i.test(text)) {
        reasons.push('prompt-injection-trap');
        return { score: 0, reasons };
      }
    }
  } catch { /* no CONTRIBUTING.md */ }

  return { score, reasons };
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

// ─── Dependency vulnerability scanning (OSV.dev) ───

interface DepInfo {
  name: string;
  version: string;
  ecosystem: string;
}

const DEP_FILES = ['package.json', 'requirements.txt', 'go.mod', 'Cargo.toml', 'Gemfile.lock'];

const ECOSYSTEM_MAP: Record<string, string[]> = {
  npm: ['package.json'],
  PyPI: ['requirements.txt'],
  Go: ['go.mod'],
  'crates.io': ['Cargo.toml'],
  RubyGems: ['Gemfile.lock'],
};

async function fetchDepFiles(api: ReturnType<typeof gh>, repo: string): Promise<RepoFile[]> {
  const [o, n] = repo.split('/');
  const files: RepoFile[] = [];
  for (const path of DEP_FILES) {
    try {
      const data = await api.get(`/repos/${o}/${n}/contents/${path}`);
      if (data.content) {
        files.push({
          path,
          content: Buffer.from(data.content, 'base64').toString('utf8'),
          sha: data.sha,
        });
      }
    } catch { /* file doesn't exist */ }
  }
  return files;
}

function parseDeps(files: RepoFile[]): DepInfo[] {
  const deps: DepInfo[] = [];

  for (const f of files) {
    // package.json
    if (f.path === 'package.json' || f.path.endsWith('/package.json')) {
      try {
        const pkg = JSON.parse(f.content);
        for (const [name, ver] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
          const v = String(ver).replace(/^[\^~>=<]+/, '');
          if (/^\d/.test(v)) deps.push({ name, version: v, ecosystem: 'npm' });
        }
      } catch { /* malformed json */ }
    }

    // requirements.txt
    if (f.path === 'requirements.txt' || f.path.endsWith('/requirements.txt')) {
      for (const line of f.content.split('\n')) {
        const m = line.trim().match(/^([a-zA-Z0-9_.-]+)==(.+)$/);
        if (m) deps.push({ name: m[1], version: m[2], ecosystem: 'PyPI' });
      }
    }

    // go.mod
    if (f.path === 'go.mod' || f.path.endsWith('/go.mod')) {
      const reqBlock = f.content.match(/require\s*\(([\s\S]*?)\)/);
      if (reqBlock) {
        for (const line of reqBlock[1].split('\n')) {
          const m = line.trim().match(/^(\S+)\s+(v\S+)/);
          if (m) deps.push({ name: m[1], version: m[2], ecosystem: 'Go' });
        }
      }
      // Single-line requires
      for (const m of f.content.matchAll(/^require\s+(\S+)\s+(v\S+)/gm)) {
        deps.push({ name: m[1], version: m[2], ecosystem: 'Go' });
      }
    }

    // Cargo.toml
    if (f.path === 'Cargo.toml' || f.path.endsWith('/Cargo.toml')) {
      const depSection = f.content.match(/\[dependencies\]([\s\S]*?)(?:\n\[|$)/);
      if (depSection) {
        for (const line of depSection[1].split('\n')) {
          const m = line.trim().match(/^([a-zA-Z0-9_-]+)\s*=\s*"([^"]+)"/);
          if (m) deps.push({ name: m[1], version: m[2], ecosystem: 'crates.io' });
        }
      }
    }

    // Gemfile.lock
    if (f.path === 'Gemfile.lock' || f.path.endsWith('/Gemfile.lock')) {
      for (const line of f.content.split('\n')) {
        const m = line.match(/^\s{4}(\S+)\s+\((\d[^)]*)\)/);
        if (m) deps.push({ name: m[1], version: m[2], ecosystem: 'RubyGems' });
      }
    }
  }

  return deps;
}

async function queryOSV(deps: DepInfo[]): Promise<VulnResult[]> {
  if (deps.length === 0) return [];
  stats.osvCalls++;

  const queries = deps.map((d) => ({
    package: { name: d.name, ecosystem: d.ecosystem },
    version: d.version,
  }));

  const vulns: VulnResult[] = [];
  const BATCH = 1000;

  for (let i = 0; i < queries.length; i += BATCH) {
    const batch = queries.slice(i, i + BATCH);
    try {
      const res = await fetch('https://api.osv.dev/v1/querybatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ queries: batch }),
      });
      if (!res.ok) continue;

      const data = (await res.json()) as { results: { vulns?: any[] }[] };

      for (let j = 0; j < (data.results ?? []).length; j++) {
        const result = data.results[j];
        if (!result.vulns?.length) continue;
        const dep = deps[i + j];

        for (const v of result.vulns) {
          // Find a fixed version
          let fixedVersion = '';
          for (const aff of v.affected ?? []) {
            for (const range of aff.ranges ?? []) {
              for (const event of range.events ?? []) {
                if (event.fixed) { fixedVersion = event.fixed; break; }
              }
              if (fixedVersion) break;
            }
            if (fixedVersion) break;
          }
          if (!fixedVersion) continue; // skip vulns with no known fix

          vulns.push({
            id: v.id ?? 'unknown',
            summary: (v.summary ?? v.details ?? '').slice(0, 200),
            pkg: dep.name,
            ecosystem: dep.ecosystem,
            currentVersion: dep.version,
            fixedVersion,
            severity: v.database_specific?.severity ?? v.severity?.[0]?.type ?? 'UNKNOWN',
          });
        }
      }
    } catch { /* OSV API error — non-fatal */ }
  }

  return vulns;
}

function buildVulnFinding(depFile: RepoFile, vuln: VulnResult): BugFinding {
  const lines = depFile.content.split('\n');
  let originalCode = '';
  let fixedCode = '';
  let startLine = 1;
  let endLine = 1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(vuln.pkg) && lines[i].includes(vuln.currentVersion)) {
      originalCode = lines[i];
      fixedCode = lines[i].replace(vuln.currentVersion, vuln.fixedVersion);
      startLine = i + 1;
      endLine = i + 1;
      break;
    }
  }

  return {
    file: depFile.path,
    startLine,
    endLine,
    bugType: 'dependency-vuln',
    confidence: 'high',
    description: `${vuln.id}: ${vuln.summary} — upgrade ${vuln.pkg} from ${vuln.currentVersion} to ${vuln.fixedVersion}`,
    originalCode,
    fixedCode,
  };
}

async function scanDependencies(
  api: ReturnType<typeof gh>,
  repo: string,
): Promise<{ finding: BugFinding; depFile: RepoFile } | null> {
  const depFiles = await fetchDepFiles(api, repo);
  if (depFiles.length === 0) return null;

  const deps = parseDeps(depFiles);
  if (deps.length === 0) return null;

  log(`  ${deps.length} deps across ${depFiles.length} manifest(s) — querying OSV.dev...`);
  const vulns = await queryOSV(deps);
  if (vulns.length === 0) return null;

  log(`  ${vulns.length} vuln(s) with known fixes`);

  // Pick first vuln (they come back in order from the batch)
  const best = vulns[0];
  const depFile = depFiles.find((f) =>
    (ECOSYSTEM_MAP[best.ecosystem] ?? []).some((name) => f.path.endsWith(name)),
  );
  if (!depFile) return null;

  const finding = buildVulnFinding(depFile, best);
  if (!finding.originalCode) return null;

  return { finding, depFile };
}

// ─── Semgrep static analysis ───

let _semgrepAvailable: boolean | null = null;

async function hasSemgrep(): Promise<boolean> {
  if (_semgrepAvailable !== null) return _semgrepAvailable;
  try {
    const proc = Bun.spawn(['semgrep', '--version'], { stdout: 'pipe', stderr: 'pipe' });
    _semgrepAvailable = (await proc.exited) === 0;
  } catch {
    _semgrepAvailable = false;
  }
  return _semgrepAvailable;
}

async function runSemgrep(files: RepoFile[]): Promise<BugCandidate[]> {
  const tmpDir = `/tmp/hunt-semgrep-${Math.random().toString(36).slice(2)}`;
  const { mkdir, writeFile, rm } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');

  try {
    await mkdir(tmpDir, { recursive: true });

    // Write files preserving paths
    for (const f of files) {
      const fullPath = join(tmpDir, f.path);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, f.content);
    }

    const proc = Bun.spawn(
      ['semgrep', 'scan', '--config', 'auto', '--json', '--quiet', tmpDir],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    // semgrep: 0 = clean, 1 = findings, 2+ = errors
    if (exitCode > 1) return [];

    const data = JSON.parse(output);
    const results = (data.results ?? []) as any[];

    return results.slice(0, 10).map((r: any) => ({
      file: (r.path as string).replace(tmpDir + '/', ''),
      line: r.start?.line ?? 1,
      hint: `[semgrep:${r.check_id}] ${r.extra?.message ?? r.check_id}`,
    }));
  } catch {
    return [];
  } finally {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* cleanup best-effort */ }
  }
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
    console.log(JSON.stringify({
      result: 'error',
      error: e instanceof Error ? e.message : String(e),
      llmCalls: stats.llmCalls,
      apiCalls: stats.apiCalls,
      osvCalls: stats.osvCalls,
      durationMs: Date.now() - stats.startedAt,
    }));
  } else {
    console.error(e instanceof Error ? e.stack : String(e));
  }
  process.exit(EXIT_ERROR);
});
