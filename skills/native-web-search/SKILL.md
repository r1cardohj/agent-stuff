---
name: native-web-search
description: "Search the web to discover and synthesize info from multiple sources (use when you don't know the source URL). NOT for known machine-readable APIs or specific URLs — use curl directly for those."
---

# Native Web Search

Use this skill to run a **fast model with native web search enabled** and get a concise research summary with explicit full URLs.

## When to use this skill

Use native web search when the answer requires **discovery + synthesis**:
- you don't know which site/URL has the answer (need a search engine)
- the topic needs comparing multiple sources, resolving disagreements, or gathering canonical links
- you want a human-readable research summary (not raw data)

## When NOT to use — use `curl` instead

Skip this skill and call the source directly with `curl` when:

- **A machine-readable API already has the exact answer.** This is faster, cheaper, and more accurate than a search summary. Common examples:
  - Node.js versions: `curl -s https://nodejs.org/dist/index.json`
  - npm package version: `curl -s https://registry.npmjs.org/<pkg>/latest`
  - PyPI package version: `curl -s https://pypi.org/pypi/<pkg>/json`
  - GitHub releases: `curl -s https://api.github.com/repos/<owner>/<repo>/releases/latest`
- **You already know the exact URL to read** — fetch it directly with `curl` (pipe to `python3 -c` / `jq` for JSON, or use the `summarize` skill to convert HTML/PDF to Markdown).

Rule of thumb: **exact data from a known endpoint → `curl`; fuzzy research across unknown sources → this skill.**

## Script

- `search.mjs`

## Usage

Run from this skill directory:

```bash
node search.mjs "<what to search>" --purpose "<why you need this>"
```

Examples:

```bash
node search.mjs "vite 7 breaking changes" --purpose "prepare migration checklist"
node search.mjs "HTTP/3 browser support comparison" --purpose "decide whether to enable it"
```

Optional flags:

- `--provider kimi-coding|deepseek`
- `--model <model-id>`
- `--timeout <ms>`
- `--json`

## Providers

Default provider is **kimi-coding** (`k3`), the only local credential with true native web search (server-side execution via the Anthropic-compatible `web_search_20250305` tool).

| Provider | Model | Web search | Credential |
|----------|-------|-----------|------------|
| `kimi-coding` (default) | `k3` | ✅ native | OAuth token in `~/.pi/agent/auth.json` |
| `deepseek` | `deepseek-v4-flash` | ❌ (API only accepts `function` tools) | `DEEPSEEK_API_KEY` env var |

Notes on behavior:

- kimi-coding may occasionally **decline to call the search tool** for queries it thinks it already knows (e.g. some "latest X version" phrasings) and reply from model knowledge. If that happens, prefer a direct `curl` to the authoritative source (see above) — it is more reliable anyway.
- `--provider deepseek`: the API always rejects the `web_search` tool, so the script auto-falls back to kimi-coding for a real search if a kimi credential exists; otherwise it answers from model knowledge with a `[note]`.

## Output expectations

The script instructs the model to:
- search the internet for the requested topic
- provide a concise summary for the given purpose
- include full canonical URLs (`https://...`) for each key finding
- highlight disagreements between sources

## Notes

- No extra npm install is required.
- If module resolution fails, set `PI_AI_MODULE_PATH` to `@earendil-works/pi-ai`'s `dist/index.js` path.
- If OAuth helper resolution fails, set `PI_AI_OAUTH_MODULE_PATH` to `@earendil-works/pi-ai`'s `dist/oauth.js` path.
- The bundled `@earendil-works/pi-ai@0.84.1` has an empty `dist/oauth.js` (no `getOAuthApiKey` export), so OAuth **refresh** is not available — the script uses the still-valid cached `access` token from `~/.pi/agent/auth.json`. If the kimi token expires, re-authenticate in pi (`pi auth login` or `/auth`) to refresh it.
