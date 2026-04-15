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
```

## How it works

1. Searches GitHub for repos in your language with open bug/help-wanted issues
2. Downloads source files via API (no local git)
3. Sends code to a free LLM to find real bugs (null checks, dead imports, logic errors, etc.)
4. Validates the fix (fuzzy matching, bracket balance, size checks)
5. Shows you the bug + fix, asks for confirmation
6. Forks, creates branch, commits fix, opens PR — all via GitHub API

## Env vars

| Var | Required | Default | Description |
|-----|----------|---------|-------------|
| `OPENROUTER_API_KEY` | yes | — | Free API key from openrouter.ai |
| `GITHUB_PAT` | no | — | Alternative to passing PAT as argument |
| `HUNT_MODEL` | no | `meta-llama/llama-4-maverick:free` | OpenRouter model to use |

### Free models that work well

```bash
export HUNT_MODEL="meta-llama/llama-4-maverick:free"
export HUNT_MODEL="meta-llama/llama-4-scout:free"
export HUNT_MODEL="google/gemini-2.5-pro-exp-03-25:free"
export HUNT_MODEL="deepseek/deepseek-chat-v3-0324:free"
```

## Requirements

- [Bun](https://bun.sh) runtime
- GitHub PAT with `repo` and `workflow` scopes
- OpenRouter API key (free, no credit card)
