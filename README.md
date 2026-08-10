# agent-stuff

Personal [Pi](https://pi.dev) package: extensions, skills, and prompts.


## What's included

| Path | Role |
|------|------|
| `extensions/itsdangerous.ts` | Block / confirm dangerous bash commands |
| `extensions/ask-mode.ts` | `/ask` read-only Q&A (no write/edit) |
| `lib/bash.ts` | Shared bash allow/deny helpers (not an extension entry) |
| `skills/` | Skills for the model (add `*/SKILL.md`) |
| `prompts/` | Prompt templates (add `*.md`) |

### /ask

```text
/ask        # toggle
/ask on     # force on
/ask off    # restore tools
pi --ask    # start in ask mode
```

Active tools: `read`, `grep`, `find`, `ls`, `bash` (read-only allowlist). Model should answer in chat with code fences, not edit files.

### itsdangerous

- **Deny:** recursive `rm`, `curl\|sh` / `wget\|sh`, `dd` / `mkfs` / `mkswap`
- **Ask** (TUI): `sudo`, `git push --force`, `git reset --hard`
- No UI (`-p` / JSON): ask rules also deny

## Develop

1. Edit files under `extensions/`, `skills/`, or `prompts/`
2. In pi: `/reload`
3. To add another extension, create `extensions/foo.ts` and list it in `package.json` → `pi.extensions`