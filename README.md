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
| `lib/bash.ts` | Shared bash allow/deny helpers (not an extension entry) |
| `skills/` | Skills for the model: `commit`, `github`, `summarize` |
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

## Develop

1. Edit files under `extensions/`, `skills/`, or `prompts/`
2. In pi: `/reload`
3. To add another extension, create `extensions/foo.ts` and list it in `package.json` → `pi.extensions`
