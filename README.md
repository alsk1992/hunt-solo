# hunt-solo

Automated bug hunter. Finds real bugs in GitHub repos and opens PRs to fix them. Uses free LLMs via OpenRouter. Designed to run unattended.

## Setup

```bash
bun install
export OPENROUTER_API_KEY="sk-or-v1-..."  # free at openrouter.ai/keys
```

## Run

```bash
# Interactive — prompts for everything
bun run hunt-solo.ts

# One-liner
bun run hunt-solo.ts <username> <pat> typescript

# Target a specific repo
bun run hunt-solo.ts <username> <pat> typescript owner/repo

# Fully automated — no prompts, loops until it finds a bug
bun run hunt-solo.ts <username> <pat> python --loop --yes

# Dry run — show bugs without opening PRs
bun run hunt-solo.ts <username> <pat> go --dry-run

# Machine-readable output for scripts
bun run hunt-solo.ts <username> <pat> typescript --loop --yes --json

# Cron — run daily at 2am
# 0 2 * * * cd /path/to/hunt-solo && OPENROUTER_API_KEY=sk-or-... bun run hunt-solo.ts myuser ghp_xxx typescript --loop --yes >> /tmp/hunt-solo.log 2>&1
```

## How it works

1. Searches GitHub for repos in your language with open bug/help-wanted issues
2. Downloads source files via API (no local git clone needed)
3. **Pass 1 — Parallel screening**: sends files in batches of 4 to an LLM (small context per file)
4. **Pass 2 — Windowed deep analysis**: focuses ±60 lines around suspects (keeps context small for free models)
5. **Consensus check** (optional): a second model independently confirms the bug
6. **Syntax check**: verifies the fix compiles/parses before committing
7. **Duplicate check**: won't open a PR if you already have one against the repo
8. **Fork sync**: syncs stale forks with upstream before branching
9. Shows bug + fix, asks for confirmation (or auto-confirms with `--yes`)
10. Forks, creates branch, commits fix, opens PR — all via GitHub API

## Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--loop` | `-l` | Try multiple repos until a bug is found |
| `--dry-run` | `-n` | Show bugs without opening PRs |
| `--yes` | `-y` | Auto-confirm PR creation (unattended mode) |
| `--json` | `-j` | Machine-readable JSON output (suppresses human-readable logs) |

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | PR opened (or bug found in dry-run) |
| `1` | Error |
| `2` | No bugs found |
| `3` | No target repos found |

Useful for wrapper scripts: `bun run hunt-solo.ts ... --yes; echo "exit: $?"`

## Env vars

| Var | Required | Default | Description |
|-----|----------|---------|-------------|
| `OPENROUTER_API_KEY` | yes | — | Free API key from openrouter.ai |
| `GITHUB_PAT` | no | — | Alternative to passing PAT as argument |
| `HUNT_MODEL` | no | `meta-llama/llama-4-maverick:free` | Primary OpenRouter model |
| `HUNT_MODEL_2` | no | — | Second model for consensus mode |
| `HUNT_MAX_ATTEMPTS` | no | `5` | Max repos to try in `--loop` mode |

### Free models that work well

```bash
export HUNT_MODEL="meta-llama/llama-4-maverick:free"
export HUNT_MODEL="meta-llama/llama-4-scout:free"
export HUNT_MODEL="google/gemini-2.5-pro-exp-03-25:free"
export HUNT_MODEL="deepseek/deepseek-chat-v3-0324:free"
```

### Multi-model consensus

Set `HUNT_MODEL_2` to a different free model. Both models must agree a bug is real before a PR is opened.

```bash
export HUNT_MODEL="meta-llama/llama-4-maverick:free"
export HUNT_MODEL_2="deepseek/deepseek-chat-v3-0324:free"
```

### JSON output

With `--json`, the only stdout is a single JSON object:

```json
{
  "result": "success",
  "repo": "owner/repo",
  "prUrl": "https://github.com/owner/repo/pull/123",
  "llmCalls": 12,
  "apiCalls": 34,
  "durationMs": 45000
}
```

On failure: `{ "result": "no-bug", "llmCalls": 8, ... }` or `{ "result": "error", "error": "message", ... }`

## Features

- **Parallel screening** — files screened in batches of 4 (cuts screening time ~4x)
- **Windowed deep analysis** — only sends ±60 lines around suspect, not the full file (free models stay accurate)
- **Multi-model consensus** — optional second model independently verifies bugs
- **Syntax checking** — fixes verified to compile/parse (Bun transpiler for TS/JS, python3 for Python, gofmt for Go, ruby -c for Ruby)
- **Bug issue mining** — fetches open issues labeled "bug" and uses them as LLM context
- **Rate limit handling** — reads GitHub `X-RateLimit-Remaining`, backs off automatically; handles OpenRouter 429s with `Retry-After`
- **Fork sync** — syncs stale forks with upstream via `merge-upstream` before branching
- **Duplicate PR check** — won't open a PR if you already have one open against the target repo
- **Anti-fingerprinting** — PR titles (6 templates), branch names (5 patterns), commit messages (4 styles), discovery stories (8 variants) all randomized
- **History tracking** — `~/.hunt-solo-history.json` deduplicates repos (30-day window, auto-pruned)
- **Loop mode** — keeps trying repos until it finds a real bug
- **Dry run** — inspect bugs without opening PRs
- **Unattended mode** — `--yes` skips all prompts, ready for cron
- **JSON output** — `--json` for machine-readable results
- **Exit codes** — 0/1/2/3 for success/error/no-bugs/no-target
- **Download pacing** — 50ms between blob fetches to avoid GitHub throttling

## Requirements

- [Bun](https://bun.sh) runtime
- GitHub PAT with `repo` and `workflow` scopes
- OpenRouter API key (free, no credit card)
