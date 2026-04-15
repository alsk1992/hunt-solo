<div align="center">

# hunt-solo

**Autonomous bug hunter for GitHub. Finds real bugs. Opens real PRs.**

Single file. Zero npm deps. Free LLMs. Runs unattended.

[![Bun](https://img.shields.io/badge/runtime-Bun-f472b6)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Single File](https://img.shields.io/badge/single%20file-1600%20LOC-brightgreen)](#architecture)

</div>

---

## What is this

hunt-solo finds real, mergeable bugs in public GitHub repos and opens pull requests to fix them. It combines deterministic analysis (dependency vulnerability scanning, static analysis) with LLM-powered code review, so it can ship fixes that range from zero-LLM-call dependency bumps to nuanced logic bug patches.

It targets repos that actually merge external PRs, avoids repos with anti-bot detection, and randomizes its git fingerprint across every run.

```
$ bun run hunt-solo.ts myuser ghp_xxx typescript --loop --yes

═══ hunt-solo v4 — automated bug hunter ═══

verifying PAT for myuser...
  authenticated as myuser
model: meta-llama/llama-4-maverick:free

searching for typescript repos...
  target: acme/utils (342 stars, pushed 3d ago)
scoring repo...
  repo score: 85 [health:78%, CONTRIBUTING, merge:67%]
  2 open bug issue(s) — using as context
downloading source files...
  14 files (28.3 KB)
scanning dependencies...
  42 deps across 1 manifest(s) — querying OSV.dev...
  1 vuln(s) with known fixes
  dependency vuln found: GHSA-xxxx: Prototype pollution in lodash — upgrade lodash from 4.17.20 to 4.17.21

  bug: dependency-vuln in package.json:18
  ...
  auto-confirming PR...
  PR opened: https://github.com/acme/utils/pull/47
```

## Quick start

```bash
# Install
git clone https://github.com/yourusername/hunt-solo && cd hunt-solo
bun install

# Set your free OpenRouter key
export OPENROUTER_API_KEY="sk-or-v1-..."  # openrouter.ai/keys (free, no card)

# Run
bun run hunt-solo.ts <github-user> <github-pat> typescript
```

## Usage

```bash
# Interactive — prompts for language, confirms before PR
bun run hunt-solo.ts <user> <pat>

# Target a specific repo
bun run hunt-solo.ts <user> <pat> python owner/repo

# Fully automated — loop repos, auto-confirm PRs
bun run hunt-solo.ts <user> <pat> go --loop --yes

# Dry run — find bugs without opening PRs
bun run hunt-solo.ts <user> <pat> rust --dry-run

# Machine-readable JSON output
bun run hunt-solo.ts <user> <pat> typescript --loop --yes --json

# Cron — run daily at 2am
0 2 * * * cd /path/to/hunt-solo && OPENROUTER_API_KEY=sk-or-... bun run hunt-solo.ts myuser ghp_xxx typescript --loop --yes >> /tmp/hunt-solo.log 2>&1
```

### Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--loop` | `-l` | Keep trying repos until a bug is found |
| `--dry-run` | `-n` | Show bugs without opening PRs |
| `--yes` | `-y` | Auto-confirm PR creation (unattended) |
| `--json` | `-j` | JSON output only (suppresses logs) |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | PR opened (or bug found in `--dry-run`) |
| `1` | Error |
| `2` | No bugs found |
| `3` | No target repos found |

## Pipeline

hunt-solo runs a 10-step pipeline per repo:

```
 1. Find target         Search GitHub for repos with bug/help-wanted issues
 2. Score repo          Community health, external PR merge rate, anti-bot check
 3. Fetch bug issues    Open issues labeled "bug" — used as LLM context
 4. Download source     Top 20 source files via GitHub tree + blob API
 5. OSV scan            Query OSV.dev for dependency vulns with known fixes
                        └─ if vuln found → skip to step 10 (zero LLM calls)
 6. Screening           Semgrep (if installed) or LLM parallel screening
 7. Deep analysis       LLM windowed analysis on suspects (±60 lines)
 8. Consensus           Optional second model independently confirms bug
 9. Validation          Code match + syntax check (Bun/python3/gofmt/ruby)
10. Submit PR           Fork → sync → branch → commit → PR (all via API)
```

Steps 5 and 6 are the key optimization: deterministic tools run first, LLM only fires when needed.

## Dependency scanning

Fetches `package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, or `Gemfile.lock` from the target repo and queries the [OSV.dev](https://osv.dev) batch API for known vulnerabilities with published fixes.

When a vuln is found, hunt-solo skips the entire LLM pipeline and produces a deterministic version bump PR. Zero LLM calls, 100% accuracy, instant.

**Supported ecosystems:** npm, PyPI, Go, crates.io, RubyGems

## Static analysis

If [semgrep](https://semgrep.dev) is installed locally, hunt-solo runs it against downloaded files before calling the LLM. Semgrep findings become `BugCandidate`s that go straight to deep analysis, skipping the LLM screening pass.

```bash
# Optional — install semgrep for better detection
pip install semgrep
# or: brew install semgrep
```

When semgrep is not installed, hunt-solo falls back to LLM-only screening. No functionality is lost.

## Multi-key routing

Spread rate limits across multiple OpenRouter API keys. The router tries each key in order; on a 429, it marks that key exhausted for 5 minutes and moves to the next.

```bash
export OPENROUTER_API_KEY="sk-or-v1-primary"
export OPENROUTER_API_KEY_2="sk-or-v1-secondary"
export OPENROUTER_API_KEY_3="sk-or-v1-tertiary"
```

With 3 free-tier keys you get ~3x the rate limit headroom. All keys use the same model (`HUNT_MODEL`).

## Repo scoring

Every candidate repo is scored before any files are downloaded:

| Signal | Points | Source |
|--------|--------|--------|
| Community health % | 0–20 | `GET /community/profile` |
| Has `CONTRIBUTING.md` | +15 | Community profile |
| Has PR template | +5 | Community profile |
| External PR merge rate >50% | +25 | Sample 30 closed PRs |
| External PR merge rate >30% | +15 | Sample 30 closed PRs |
| External PR merge rate <20% | -20 | Sample 30 closed PRs |

**Anti-bot detection** (auto-reject, score → 0):
- CI workflows containing `contributor-report`, `ai-moderator`, or `spam-detection`
- `CONTRIBUTING.md` with prompt injection traps ("include the phrase", "mention that you are", "say the word")

Repos scoring below `HUNT_MIN_REPO_SCORE` (default 30) are skipped.

## Multi-model consensus

Set `HUNT_MODEL_2` to a different model. Both must independently agree a bug is real before a PR opens.

```bash
export HUNT_MODEL="meta-llama/llama-4-maverick:free"
export HUNT_MODEL_2="deepseek/deepseek-chat-v3-0324:free"
```

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENROUTER_API_KEY` | **yes** | — | Primary OpenRouter API key |
| `OPENROUTER_API_KEY_2` | no | — | Second key for rate limit spreading |
| `OPENROUTER_API_KEY_3` | no | — | Third key for rate limit spreading |
| `GITHUB_PAT` | no | — | Alternative to passing PAT as argument |
| `HUNT_MODEL` | no | `meta-llama/llama-4-maverick:free` | OpenRouter model for analysis |
| `HUNT_MODEL_2` | no | — | Second model for consensus mode |
| `HUNT_MAX_ATTEMPTS` | no | `5` | Max repos to try in `--loop` mode |
| `HUNT_MIN_REPO_SCORE` | no | `30` | Minimum repo score to target |

### Recommended free models

```bash
HUNT_MODEL="meta-llama/llama-4-maverick:free"        # strong reasoning, good for code
HUNT_MODEL="meta-llama/llama-4-scout:free"            # fast, decent accuracy
HUNT_MODEL="google/gemini-2.5-pro-exp-03-25:free"     # large context, good at code
HUNT_MODEL="deepseek/deepseek-chat-v3-0324:free"      # strong code understanding
```

## JSON output

With `--json`, stdout is a single JSON object:

```json
{
  "result": "success",
  "repo": "owner/repo",
  "prUrl": "https://github.com/owner/repo/pull/123",
  "source": "osv",
  "repoScore": 85,
  "llmCalls": 0,
  "apiCalls": 28,
  "osvCalls": 1,
  "durationMs": 15000
}
```

| `source` | Meaning |
|----------|---------|
| `osv` | Dependency vulnerability fix (zero LLM calls) |
| `semgrep+llm` | Semgrep detection + LLM fix generation |
| `llm` | Pure LLM screening + analysis |

On failure: `{ "result": "no-bug", ... }` or `{ "result": "error", "error": "...", ... }`

## Architecture

Single file, zero runtime dependencies.

```
hunt-solo.ts (1600 LOC)
├── LLM layer         OpenRouterClient + LlmRouter (multi-key failover)
├── GitHub API        Rate-limit-aware REST client
├── Target discovery  Issue search + repo search (randomized)
├── Repo scoring      Community health + merge rate + anti-bot
├── OSV scanning      Dependency parsing + OSV.dev batch API
├── Semgrep           Optional static analysis pre-filter
├── LLM pipeline      Parallel screening → windowed deep analysis → consensus
├── Validation        Code matching + syntax checking
├── PR submission     Fork sync + dedup + randomized naming
└── History           ~/.hunt-solo-history.json (30-day dedup)
```

**Why single file?** Easier to audit, deploy, and fork. No build step. `scp` it anywhere with Bun and it runs.

## Anti-fingerprinting

Every run randomizes:
- **PR titles** — 6 templates (`Fix X in Y`, `fix: description`, `Resolve X issue`, ...)
- **Branch names** — 5 patterns (`fix/`, `patch/`, `bugfix/`, ...)
- **Commit messages** — 4 styles (conventional, scoped, imperative, descriptive)
- **PR body** — 8 discovery story variants, LLM-generated descriptions
- **Search strategy** — shuffled between issue search + repo search with random star buckets and page offsets

## Supported languages

TypeScript, JavaScript, Python, Go, Rust, Java, Ruby, Swift, Kotlin, C, C++

Syntax checking available for: TypeScript/JavaScript (Bun transpiler), Python (`python3`), Go (`gofmt`), Ruby (`ruby -c`). Other languages use bracket balance heuristics.

## Requirements

- [Bun](https://bun.sh) v1.0+
- GitHub PAT with `repo` and `workflow` scopes
- OpenRouter API key ([free, no credit card](https://openrouter.ai/keys))
- *(optional)* [semgrep](https://semgrep.dev) for static analysis pre-filtering

## License

MIT
