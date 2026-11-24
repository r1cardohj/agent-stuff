# agent-stuff

Personal [Pi](https://pi.dev) package: extensions, skills, and prompts.


## What's included

| Path | Role |
|------|------|
| `extensions/itsdangerous.ts` | Block / confirm dangerous bash commands |
| `extensions/mode.ts` | `/ask` `/teach` `/yolo` — one-key mode switching (read-only Q&A / teaching / full tools) |
| `extensions/mode/*.md` | System prompts for ask / teach modes (edit to tweak behavior) |
| `extensions/answer.ts` | `/answer` extract questions from last assistant message into interactive Q&A |
| `extensions/misslee.ts` | `/misslee` Chinese ↔ English helper: idiomatic translations + grammar/style review |
| `extensions/files.ts` | `/files` browse git-tracked + session-referenced files (Ctrl+Shift+O / Ctrl+Shift+R) |
| `extensions/review.ts` | `/review` code review (PR / branch / commit / uncommitted / folder) + `/end-review` |
| `extensions/commit.ts` | `/commit` (commit only) and `/commitpush` / `/cp` (commit + push), per commit skill |
| `extensions/continue.ts` | `/continue` send "continue" when the agent is idle |
| `extensions/websearch.ts` | `search` tool: DeepSeek Search API, reads pi's stored deepseek key |
| `extensions/fetch.ts` | `fetch` tool: download a URL, return Markdown via Defuddle (HTML) or plain text |
| `extensions/comment-rules.ts` | Appends `lib/comments.md` comment conventions to the system prompt every turn |
| `extensions/auto-route.ts` | `router/auto` virtual model: intent scoring + failover across configured models |
| `extensions/uv.ts` | Redirects Python tooling to uv: blocks legacy commands in bash with uv equivalents |
| `intercepted-commands/` | PATH shims used by the uv extension |
| `extensions/btw.ts` | `/btw` side-chat popover: ask side questions, optionally summarize into main chat |
| `extensions/subagent.ts` | `subagent` tool: run delegated tasks in a herdr-managed Pi session |
| `extensions/notify.ts` | Desktop notification (OSC 777) when a run ends and waits for input |
| `extensions/pretty.ts` | Neon styling: rounded gradient editor frame, custom footer, moon-phase spinner, header banner |
| `skills/herdr/` | `herdr-background-runs` skill for long tests/builds/services via `hc` |
| `lib/bash.ts` | Shared bash allow/deny helpers (not an extension entry) |
| `skills/` | Skills for the model: `commit`, `github`, `herdr-background-runs`, `summarize`, `uv`, `web-browser`, `websearch` |
| `prompts/` | Prompt templates (add `*.md`) |
| `themes/` | `tokyonight_moon` theme |

### /ask /teach /yolo

```text
/yolo    # full tools, unrestricted (default)
/ask     # read-only Q&A: answer questions and show code, no file writes
/teach   # education mode: first-principles, step-by-step, examples + code review
pi --agent-mode ask # start in a specific mode (yolo|ask|teach); NOT --mode (built-in output flag)
```

`ask` and `teach` are read-only: active tools are `read`, `grep`, `find`, `ls`, `bash` (read-only allowlist). Model should answer in chat with code fences, not edit files.

### itsdangerous

- **Deny:** recursive `rm`, `curl\|sh` / `wget\|sh`, `dd` / `mkfs` / `mkswap`
- **Ask** (TUI): `sudo`, `git push --force`, `git reset --hard`
- No UI (`-p` / JSON): ask rules also deny

### /misslee

```text
/misslee 吃饭了吗          # Chinese → 2-3 idiomatic English versions with usage notes
/misslee Have you had your meal?   # English → review in Chinese: grammar, word choice,
                                   # plus more natural alternatives
```

Detects whether your input contains Chinese characters and picks the direction automatically.

> Named after my high school English teacher, Miss Lee. 🍎

### /review

```text
/review                          # interactive selector (smart default based on git state)
/review uncommitted              # staged + unstaged + untracked changes
/review branch main              # diff against a base branch (merge-base)
/review commit abc123            # a specific commit
/review pr 123                   # GitHub PR (checks it out locally; needs gh + clean tree)
/review folder src docs          # snapshot review of paths (not a diff)
/review branch main --extra "focus on performance"   # extra instruction, any mode
/end-review                      # finish: return only / return + fix findings / return + summarize
```

- Prioritized findings ([P0]–[P3]) + verdict, with tab completion for subcommands, branches, and commits
- Selector can toggle **loop fixing** (review → auto-fix → re-review, up to 10 passes) and **custom review instructions**
- Optional `REVIEW_GUIDELINES.md` next to `.pi/` is appended to every review prompt

### /commit and /commitpush

```text
/commit              # commit per the commit skill (Conventional Commits); never pushes
/commitpush          # same, then push
/cp                  # alias for /commitpush
/commit src/ docs/   # limit to specific paths
/commitpush --amend  # amend, then push --force-with-lease
```

### search (websearch)

Model-callable `search` tool backed by DeepSeek's Search API. Credentials resolve
from `DEEPSEEK_API_KEY`, falling back to the `deepseek` key pi stores via `/login`
(including `!command` keys). The `websearch` skill documents query operators
(`site:`, `"..."`, `lang:`, `after:`) and result triage; it loads on demand.

### fetch

Model-callable `fetch` tool: downloads a URL with undici (env-proxy aware via
`EnvHttpProxyAgent`, retries on 429/5xx, 20MB cap) and returns bounded Markdown.
HTML extraction uses Defuddle (`defuddle/node`); JSON/source/raw text is returned
as-is with charset detection. Output truncates at 12k chars by default
(`max_chars` parameter, 50k cap). Ported from agent7's `web_fetch.py`.

### uv extension + skill

The `uv` skill teaches uv usage (`uv run`, `uv add`, inline script metadata,
`uv_build`). The `uv` extension enforces it: bash calls to legacy Python tooling
are blocked at spawn time with the uv equivalent suggested, via PATH shims plus
command scanning. Quoted arguments (e.g. commit messages) are never scanned.

### web-browser skill

Drive Chrome/Chromium over the Chrome DevTools Protocol: `start.js` (prefer
`--headless`), `nav.js`, `eval.js`, `screenshot.js`, device emulation, cookie
consent dismissal, console/network logs. Auto-detects WSL and falls back to the
Windows host's Chrome via interop (stopping uses CDP `Browser.close`).

### subagent (herdr)

`subagent` tool: run a delegated task in a separate Pi process inside a herdr-managed
terminal (`hc run --bg`). By default the child runs on a randomly chosen model from
`PI_SUBAGENT_MODEL` (comma-separated candidates) or a built-in default list
(`kimi-coding/kimi-for-coding` or `deepseek/deepseek-flash`); provider/model/thinking
are overridable per call, and thinking defaults to the main session's level. Calls are serialized,
output streams back via `hc read`, and you can attach with `hc attach`. When the child
settles, its result is captured and returned to the main conversation.

### herdr background runs

The `herdr-background-runs` skill teaches the model to use `hc run --bg --no-notify`
for long tests, builds, or services, then `hc wait`, `hc read`, and `hc rm`/`hc kill`
to collect results and clean up. Use it for anything expected to take over ~60 seconds.

### notify

Sends a native desktop notification via the OSC 777 escape sequence when the agent
finishes a run and is waiting for input. Supported terminals include Ghostty, iTerm2,
WezTerm, and rxvt-unicode.

### pretty (neon)

Always-on, no command. The editor gets a closed rounded box (`╭╮╰╯` corners plus `│`
side borders drawn in the padding columns, so the frame has no gaps) whose top/bottom
border gradients from the current thinking-level border color to neon pink, preserving
the thinking / bash-mode color signal. Content is padded inside the frame so text and
the cursor never cross the border. The footer shows cwd, git branch, session name,
model + thinking level, token/cost stats, and a 10-cell context bar (warning above 70%,
error above 90%).

Also styled:

- Working spinner: moon phases `🌑🌒🌓🌔🌕🌖🌗🌘` at 160ms.
- Startup header: `◆ project` + session name + model/thinking over a gradient rule.

Tool call/result rendering and the area above the editor stay built-in. Plain Unicode
glyphs, no nerd font required.

### /btw

`/btw` opens a side-chat popover seeded with main-conversation context, running
on the active model with read/bash/edit/write tools. Threads persist across
session restore and tree navigation; closing can summarize the thread into the
main chat. `/btw <question>` asks directly without opening the popover.

### /pr

```text
/pr                              # create a PR for the current changes (title picked from the diff)
/pr fix the flaky login test     # use this as the PR title
```

Reviews the diff, cuts a branch off the default branch if you're on it (kebab-case slug from the title),
commits per the commit skill, pushes, and opens the PR with `gh pr create`. Refuses to duplicate an
existing open PR for the current branch.

## Develop

1. Edit files under `extensions/`, `skills/`, or `prompts/`
2. In pi: `/reload`
3. To add another extension, create `extensions/foo.ts` and list it in `package.json` → `pi.extensions`

