<div align="center">

# hunt-solo

### Autonomous AI Bug Hunter for GitHub

**Finds real bugs in open-source repos. Opens pull requests to fix them. Runs unattended.**

Combines AI-powered code review, dependency vulnerability scanning (OSV.dev), and static analysis (semgrep) in a single file with zero npm dependencies.

[![Bun](https://img.shields.io/badge/runtime-Bun-f472b6)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Single File](https://img.shields.io/badge/architecture-single%20file-brightgreen)](#architecture)
[![LLM](https://img.shields.io/badge/LLM-OpenRouter%20(free)-orange)](https://openrouter.ai)

[Quick Start](#quick-start) · [How It Works](#how-it-works) · [Niche Targeting](#niche-targeting) · [Environment Variables](#environment-variables)

</div>

---

## Why hunt-solo

Most automated code review tools require complex setup, paid APIs, and extensive configuration. hunt-solo is different:

- **Single TypeScript file** — 1600 LOC, audit in one sitting, deploy with `scp`
- **Zero npm dependencies** — only needs the Bun runtime
- **Free LLMs** — uses OpenRouter's free tier (Llama, Gemini, DeepSeek)
- **Deterministic-first** — dependency vuln fixes need zero LLM calls
- **Unattended mode** — `--loop --yes` for cron jobs and CI pipelines
- **Smart targeting** — scores repos by merge rate, skips anti-bot repos

---

## Quick Start

```bash
git clone https://github.com/alsk1992/hunt-solo && cd hunt-solo
bun install

export OPENROUTER_API_KEY="sk-or-v1-..."  # free at openrouter.ai/keys

bun run hunt-solo.ts <github-user> <github-pat> typescript
```

---

## How It Works

hunt-solo runs a 10-step automated pipeline for each target repository:

```
 1. Find target         Curated repos file or niche-filtered GitHub search
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

**The key insight:** deterministic tools (OSV, semgrep) run first. The LLM only fires when needed, saving rate limit budget and improving accuracy.

---

## Usage Examples

```bash
# Interactive — prompts for language, confirms before PR
bun run hunt-solo.ts <user> <pat>

# Target a specific repo
bun run hunt-solo.ts <user> <pat> python owner/repo

# Fully automated — loop repos, auto-confirm PRs
bun run hunt-solo.ts <user> <pat> go --loop --yes

# Dry run — find bugs without opening PRs
bun run hunt-solo.ts <user> <pat> rust --dry-run

# Machine-readable JSON output for scripts and CI
bun run hunt-solo.ts <user> <pat> typescript --loop --yes --json

# Cron — run daily at 2am
0 2 * * * cd /path/to/hunt-solo && OPENROUTER_API_KEY=... bun run hunt-solo.ts user pat typescript --loop --yes >> /tmp/hunt.log 2>&1
```

### CLI Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--loop` | `-l` | Keep trying repos until a bug is found |
| `--dry-run` | `-n` | Show bugs without opening PRs |
| `--yes` | `-y` | Auto-confirm PR creation (unattended) |
| `--json` | `-j` | JSON output only (suppresses logs) |

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | PR opened (or bug found in `--dry-run`) |
| `1` | Error |
| `2` | No bugs found |
| `3` | No target repos found |

---

## Features

### Dependency Vulnerability Scanning

Fetches dependency manifests (`package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, `Gemfile.lock`) and queries the [OSV.dev](https://osv.dev) batch API for known vulnerabilities with published fixes.

When a vuln is found, hunt-solo produces a deterministic version bump PR — **zero LLM calls, 100% accuracy, instant.**

**Supported ecosystems:** npm, PyPI, Go, crates.io, RubyGems

### Static Analysis with Semgrep

If [semgrep](https://semgrep.dev) is installed locally, hunt-solo runs it on downloaded files before calling the LLM. Semgrep findings go straight to deep analysis, skipping the LLM screening pass entirely.

```bash
# Optional but recommended
pip install semgrep
```

### AI-Powered Code Review

Two-pass LLM analysis using free models via OpenRouter:

1. **Parallel screening** — files sent in batches of 4, small context per file
2. **Windowed deep analysis** — ±60 lines around suspects, precise fix generation

Supports multi-model consensus where a second model independently verifies each finding.

### Multi-Key LLM Routing

Spread rate limits across multiple OpenRouter API keys. The router tries each key in order; on a 429, it marks that key exhausted for 5 minutes and moves to the next.

```bash
export OPENROUTER_API_KEY="sk-or-v1-primary"
export OPENROUTER_API_KEY_2="sk-or-v1-secondary"
export OPENROUTER_API_KEY_3="sk-or-v1-tertiary"
```

### Repo Scoring & Anti-Bot Detection

Every candidate repo is scored before any files are downloaded:

| Signal | Points |
|--------|--------|
| Community health % | 0–20 |
| Has `CONTRIBUTING.md` | +15 |
| Has PR template | +5 |
| External PR merge rate >50% | +25 |
| External PR merge rate >30% | +15 |
| External PR merge rate <20% | -20 |

**Auto-reject (score → 0):**
- CI workflows with `contributor-report`, `ai-moderator`, `spam-detection`
- `CONTRIBUTING.md` with prompt injection traps

### Anti-Fingerprinting

Every run randomizes PR titles (6 templates), branch names (5 patterns), commit messages (4 styles), PR body stories (8 variants), and search strategy (random star buckets + page offsets).

---

## Niche Targeting

Refine exactly what repos to hunt. All filters compose together.

### Topics & Keywords

```bash
# Only target repos tagged with specific GitHub topics
export HUNT_TOPICS="react,nextjs"

# Add extra search terms
export HUNT_KEYWORDS="web framework"
```

### Star Range & Recency

```bash
# Small repos (easier to get PRs merged)
export HUNT_STARS_MIN=50
export HUNT_STARS_MAX=500

# Only repos pushed in the last 2 weeks
export HUNT_PUSHED_DAYS=14
```

### Curated Repos File

For maximum control, point to a file with specific repos:

```bash
export HUNT_REPOS_FILE=~/.hunt-repos.txt
```

```text
# one owner/repo per line, # comments supported
vercel/next.js
facebook/react
sharkdp/bat
```

### Example Niche Setups

```bash
# Python ML repos, small and active
HUNT_TOPICS="machine-learning,deep-learning" HUNT_STARS_MIN=100 HUNT_STARS_MAX=2000 \
  bun run hunt-solo.ts user pat python --loop --yes

# Hand-picked TypeScript targets
HUNT_REPOS_FILE=~/.ts-targets.txt HUNT_MIN_REPO_SCORE=20 \
  bun run hunt-solo.ts user pat typescript --loop --yes

# Fresh, active Go repos that welcome contributors
HUNT_PUSHED_DAYS=14 HUNT_STARS_MIN=200 HUNT_STARS_MAX=5000 \
  bun run hunt-solo.ts user pat go --loop --yes
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENROUTER_API_KEY` | **yes** | — | Primary OpenRouter API key ([free](https://openrouter.ai/keys)) |
| `OPENROUTER_API_KEY_2` | no | — | Second key for rate limit spreading |
| `OPENROUTER_API_KEY_3` | no | — | Third key for rate limit spreading |
| `GITHUB_PAT` | no | — | Alternative to passing PAT as argument |
| `HUNT_MODEL` | no | `meta-llama/llama-4-maverick:free` | OpenRouter model for analysis |
| `HUNT_MODEL_2` | no | — | Second model for consensus mode |
| `HUNT_MAX_ATTEMPTS` | no | `5` | Max repos to try in `--loop` mode |
| `HUNT_MIN_REPO_SCORE` | no | `30` | Minimum repo score threshold |
| `HUNT_TOPICS` | no | — | Comma-separated GitHub topics |
| `HUNT_KEYWORDS` | no | — | Extra search terms |
| `HUNT_STARS_MIN` | no | `50` | Minimum stars for target repos |
| `HUNT_STARS_MAX` | no | `10000` | Maximum stars for target repos |
| `HUNT_PUSHED_DAYS` | no | `90` | Max days since last push |
| `HUNT_REPOS_FILE` | no | — | Path to curated `owner/repo` list |

### Recommended Free Models

```bash
HUNT_MODEL="meta-llama/llama-4-maverick:free"        # strong reasoning
HUNT_MODEL="meta-llama/llama-4-scout:free"            # fast
HUNT_MODEL="google/gemini-2.5-pro-exp-03-25:free"     # large context
HUNT_MODEL="deepseek/deepseek-chat-v3-0324:free"      # strong code understanding
```

---

## JSON Output

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
| `llm` | Full LLM screening + analysis |

---

## Architecture

```
hunt-solo.ts (single file, ~1600 LOC)
├── LLM layer           OpenRouterClient + LlmRouter (multi-key failover)
├── GitHub API           Rate-limit-aware REST client with auto-backoff
├── Niche config         Topics, keywords, star range, repos file
├── Target discovery     Curated list → niche-filtered GitHub search
├── Repo scoring         Community health + merge rate + anti-bot
├── OSV scanning         Dependency parsing + OSV.dev batch API
├── Semgrep              Optional static analysis pre-filter
├── LLM pipeline         Parallel screening → windowed deep analysis → consensus
├── Validation           Code matching + syntax checking
├── PR submission        Fork sync + dedup check + randomized naming
└── History              ~/.hunt-solo-history.json (30-day dedup)
```

**Why single file?** One file to audit, deploy, and fork. No build step. `scp` it anywhere with Bun and it runs.

---

## Supported Languages

TypeScript, JavaScript, Python, Go, Rust, Java, Ruby, Swift, Kotlin, C, C++

**Syntax checking:** TypeScript/JavaScript (Bun transpiler), Python (`python3`), Go (`gofmt`), Ruby (`ruby -c`). Other languages use bracket balance heuristics.

---

## Requirements

- [Bun](https://bun.sh) v1.0+
- GitHub PAT with `repo` and `workflow` scopes
- [OpenRouter API key](https://openrouter.ai/keys) (free, no credit card)
- *(optional)* [semgrep](https://semgrep.dev) for static analysis

---

## License

MIT
