# Comment conventions

Comment rules for writing or modifying code. Follow them strictly.

## Do not write

1. **Intent, purpose, or high-level design comments.** Never use comments to restate what the code does, why it exists, or how the overall architecture works (e.g. `// this module handles…`, `// for performance`, `// entry point: initializes all subsystems`). Intent should be expressed by structure and naming; design explanations belong in commit messages and docs, not in code.
2. **Bugfix narration or decision justification.** Never narrate bug history or rationalize decisions (e.g. `// fixed crash when x is empty`, `// the upstream API returns null here, so…`, `// previously used approach A which caused B, hence C`). Such claims get overturned the moment the code changes, the upstream fixes itself, or the premise disappears — while the comment stays behind and becomes a lie. History belongs in `git log`; rationale belongs in commit messages, PRs, and docs.
3. **Change-log comments.** No `// added feature xx in 2026-11`, version histories, or vague `// TODO: optimize` (unless it carries concrete, actionable content).

## Do write (facts that stay true as the code evolves)

1. **Non-obvious constraints and invariants**: e.g. `// must hold lock X before calling Y`, `// this array is kept sorted`, magic numbers bound to real physical or protocol limits.
2. **External references**: links to the spec / RFC / issue that a magic number, protocol quirk, or compatibility hack is based on.
3. **Machine directives**: `// eslint-disable-next-line <rule>` and the like — always name the specific rule, keep the scope minimal.
4. **Boundaries that look wrong but are intentional**: a one-line pointer to where the real reason is recorded (issue / PR / commit), e.g. `// order matters: see #123` — a pointer only, not the story.
5. **Doc comments on public APIs**: parameters, return values, and error contracts of exported interfaces.

## When modifying existing code

- If a comment no longer matches the code you touched, delete or fix the comment — never preserve stale comments.
- Never copy a stale comment into new code.
- When unsure whether to write a comment, don't.
