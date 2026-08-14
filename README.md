# agent-stuff

Personal [Pi](https://pi.dev) package: extensions, skills, and prompts.


## What's included

| Path | Role |
|------|------|
| `extensions/itsdangerous.ts` | Block / confirm dangerous bash commands |
| `extensions/mode.ts` | `/ask` `/teach` `/yolo` — one-key mode switching (read-only Q&A / teaching / full tools) |
| `extensions/mode/*.md` | System prompts for ask / teach modes (edit to tweak behavior) |
| `extensions/split.ts` | `/split v\|h` fork session into a new Windows Terminal pane |
| `extensions/answer.ts` | `/answer` extract questions from last assistant message into interactive Q&A |
| `extensions/files.ts` | `/files` browse git-tracked + session-referenced files (Ctrl+Shift+O / Ctrl+Shift+R) |
| `lib/bash.ts` | Shared bash allow/deny helpers (not an extension entry) |
| `skills/` | Skills for the model (add `*/SKILL.md`) |
| `prompts/` | Prompt templates (add `*.md`) |

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

## Develop

1. Edit files under `extensions/`, `skills/`, or `prompts/`
2. In pi: `/reload`
3. To add another extension, create `extensions/foo.ts` and list it in `package.json` → `pi.extensions`
