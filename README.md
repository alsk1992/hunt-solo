# hunt-solo

One-shot bug hunter. Finds real bugs in GitHub repos and opens PRs to fix them. Uses free LLMs via OpenRouter.

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
bun run hunt-solo.ts <github-username> <github-pat> typescript

# Target a specific repo
bun run hunt-solo.ts <username> <pat> typescript owner/repo

# Loop mode — tries multiple repos until it finds a bug
bun run hunt-solo.ts <username> <pat> python --loop

# Dry run — show bugs without opening PRs
bun run hunt-solo.ts <username> <pat> go --dry-run

# Combine flags
bun run hunt-solo.ts <username> <pat> typescript --loop --dry-run
```

## How it works

1. Searches GitHub for repos in your language with open bug/help-wanted issues
2. Downloads source files via API (no local git clone needed)
3. **Pass 1 — Screening**: sends each file individually to an LLM (small context = better accuracy on free models)
4. **Pass 2 — Deep analysis**: focuses on suspect files with full content for precise fix generation
5. **Consensus check** (optional): a second model independently confirms the bug is real
6. **Syntax check**: verifies the fix compiles/parses (Bun transpiler for TS/JS, python3 for Python, gofmt for Go, ruby -c for Ruby)
7. Shows you the bug + fix, asks for confirmation
8. Forks, creates branch, commits fix, opens PR — all via GitHub API

## Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--loop` | `-l` | Try multiple repos until a bug is found (up to `HUNT_MAX_ATTEMPTS`) |
| `--dry-run` | `-n` | Show bugs without opening PRs |

## Env vars

| Var | Required | Default | Description |
|-----|----------|---------|-------------|
| `OPENROUTER_API_KEY` | yes | — | Free API key from openrouter.ai |
| `GITHUB_PAT` | no | — | Alternative to passing PAT as argument |
| `HUNT_MODEL` | no | `meta-llama/llama-4-maverick:free` | Primary OpenRouter model |
| `HUNT_MODEL_2` | no | — | Second model for consensus mode (set to enable) |
| `HUNT_MAX_ATTEMPTS` | no | `5` | Max repos to try in `--loop` mode |

### Free models that work well

```bash
export HUNT_MODEL="meta-llama/llama-4-maverick:free"
export HUNT_MODEL="meta-llama/llama-4-scout:free"
export HUNT_MODEL="google/gemini-2.5-pro-exp-03-25:free"
export HUNT_MODEL="deepseek/deepseek-chat-v3-0324:free"
```

### Multi-model consensus

Set `HUNT_MODEL_2` to a different free model. Both models must agree a bug is real before a PR is opened. This dramatically reduces false positives.

```bash
export HUNT_MODEL="meta-llama/llama-4-maverick:free"
export HUNT_MODEL_2="deepseek/deepseek-chat-v3-0324:free"
```

## Features

- **Two-pass analysis** — screening pass keeps context small (one file at a time, 256 tokens), deep pass gets precise fixes
- **Multi-model consensus** — optional second model independently verifies bugs
- **Syntax checking** — fixes are verified to compile/parse before committing
- **Bug issue mining** — fetches open issues labeled "bug" from target repos and uses them as context
- **History tracking** — `~/.hunt-solo-history.json` deduplicates repos (30-day window) and tracks opened PRs
- **Loop mode** — keeps trying repos until it finds a real bug
- **Dry run** — inspect bugs without opening PRs
- **Target specific repos** — pass `owner/repo` to scan a particular project

## Requirements

- [Bun](https://bun.sh) runtime
- GitHub PAT with `repo` and `workflow` scopes
- OpenRouter API key (free, no credit card)
