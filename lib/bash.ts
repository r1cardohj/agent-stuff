/** Shared bash policy helpers for itsdangerous + ask-mode. */

export type GuardAction = "deny" | "ask";

export type BashRule = {
  name: string;
  action: GuardAction;
  test: (command: string) => boolean;
};

/** Wrap a regex as a rule matcher (resets lastIndex defensively). */
const rx = (pattern: RegExp): ((command: string) => boolean) => {
  return (command: string) => {
    pattern.lastIndex = 0;
    return pattern.test(command);
  };
};

/** Split a command into pipeline pieces across && || ; and | */
export function bashPipelineParts(command: string): string[] {
  const parts: string[] = [];
  for (const segment of command.split(/&&|\|\||;/)) {
    for (const pipe of segment.split("|")) {
      const trimmed = pipe.trim();
      if (trimmed) parts.push(trimmed);
    }
  }
  return parts;
}

/** Tokenize each pipeline part (not shell-quote aware — good enough for policy checks). */
function commandTokenList(command: string): string[][] {
  return bashPipelineParts(command).map((part) => part.split(/\s+/).filter(Boolean));
}

/** Strip leading `command` / `builtin` / `sudo` prefixes and return the invoked binary's basename + args. */
function invokedCommand(tokens: string[]): { base: string; rest: string[] } | null {
  let i = 0;
  while (tokens[i] === "command" || tokens[i] === "builtin") i++;
  if (tokens[i] === "sudo") {
    i++;
    while (tokens[i]?.startsWith("-")) i++; // sudo's own flags (flag values not approximated)
    while (tokens[i] === "command" || tokens[i] === "builtin") i++;
  }
  const cmd = tokens[i];
  if (!cmd) return null;
  return { base: cmd.split("/").pop() ?? cmd, rest: tokens.slice(i + 1) };
}

/**
 * `rm` with both recursive and force flags — combined (`-rf`), separate (`-r -f`),
 * long flags, or flags after operands (`rm dir -rf`).
 */
function isRecursiveForceRm(command: string): boolean {
  for (const tokens of commandTokenList(command)) {
    const invoked = invokedCommand(tokens);
    if (!invoked || invoked.base !== "rm") continue;
    let recursive = false;
    let force = false;
    for (const tok of invoked.rest) {
      if (tok === "--") break;
      if (tok === "--recursive") recursive = true;
      else if (tok === "--force") force = true;
      else if (/^-[^-]/.test(tok)) {
        const flags = tok.slice(1).toLowerCase();
        if (flags.includes("r")) recursive = true;
        if (flags.includes("f")) force = true;
      }
    }
    if (recursive && force) return true;
  }
  return false;
}

/** `git push` with force flags, including combined short flags like `-fu`. */
function isForcePush(command: string): boolean {
  for (const tokens of commandTokenList(command)) {
    const invoked = invokedCommand(tokens);
    if (!invoked || invoked.base !== "git") continue;
    if (invoked.rest[0] !== "push") continue;
    for (const tok of invoked.rest.slice(1)) {
      if (tok === "--") break;
      // --force, --force-with-lease, --force-if-includes
      if (/^--force($|-)/.test(tok)) return true;
      // -f, -fu, -vf…
      if (/^-[^-]/.test(tok) && tok.slice(1).includes("f")) return true;
    }
  }
  return false;
}

/** `git clean -f…` permanently deletes untracked files. */
function isForceClean(command: string): boolean {
  for (const tokens of commandTokenList(command)) {
    const invoked = invokedCommand(tokens);
    if (!invoked || invoked.base !== "git") continue;
    if (invoked.rest[0] !== "clean") continue;
    for (const tok of invoked.rest.slice(1)) {
      if (tok === "--") break;
      if (tok === "--force") return true;
      if (/^-[^-]/.test(tok) && tok.slice(1).includes("f")) return true;
    }
  }
  return false;
}

/** Destructive / high-risk patterns (itsdangerous denylist). */
export const DANGEROUS_BASH_RULES: BashRule[] = [
  { name: "rm recursive force", action: "deny", test: isRecursiveForceRm },
  {
    name: "curl|sh / wget|sh",
    action: "deny",
    test: rx(/\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba)?sh\b/i),
  },
  {
    name: "disk wipe (dd/mkfs/mkswap)",
    action: "deny",
    test: rx(/\b(dd|mkfs(\.\w+)?|mkswap)\b/i),
  },
  {
    name: "sudo",
    action: "ask",
    test: rx(/(^|[;&|]|&&|\|\|)\s*sudo\b|\bsudo\s+/i),
  },
  { name: "git force push", action: "ask", test: isForcePush },
  { name: "git clean --force", action: "ask", test: isForceClean },
  {
    name: "git reset --hard",
    action: "ask",
    test: rx(/\bgit\s+reset\s+--hard\b/i),
  },
];

const SAFE_BASH = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "ls",
  "pwd",
  "file",
  "stat",
  "du",
  "df",
  "tree",
  "wc",
  "sort",
  "uniq",
  "diff",
  "grep",
  "rg",
  "fd",
  "find",
  "echo",
  "printf",
  "printenv",
  "uname",
  "whoami",
  "id",
  "date",
  "which",
  "type",
  "git",
  "jq",
  "node",
  "python",
  "python3",
  "npm",
  "pnpm",
  "yarn",
  "cargo",
  "go",
  "rustc",
]);

const SAFE_GIT = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "remote",
  "tag",
  "stash",
  "blame",
  "rev-parse",
  "describe",
  "ls-files",
  "ls-tree",
  "config",
]);

const SAFE_PKG = new Set([
  "list",
  "ls",
  "view",
  "info",
  "search",
  "outdated",
  "why",
  "explain",
]);

const SAFE_VERSION_FLAGS = new Set(["--version", "-v", "-V", "--help", "-h"]);

/** find flags that delete files, execute commands, or write output files. */
const FIND_WRITE_FLAGS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
]);

/** Long flags that mutate refs for `git branch` / `git tag`. */
const GIT_BRANCH_MUTATING_LONG = new Set([
  "--delete",
  "--move",
  "--copy",
  "--force",
  "--set-upstream-to",
  "--unset-upstream",
  "--edit-description",
]);
const GIT_TAG_MUTATING_LONG = new Set([
  "--delete",
  "--annotate",
  "--sign",
  "--message",
  "--force",
  "--replace",
]);

/** `git remote` subcommands that only read. */
const SAFE_GIT_REMOTE = new Set(["show", "get-url"]);

const MUTATING_TOKENS =
  /\b(rm|mv|cp|mkdir|touch|chmod|chown|tee|dd|mkfs|sudo|kill|pkill)\b/i;

/** True for short-option tokens (e.g. `-o`, `-ofile`) and `--output[=file]`. */
function isOutputFlag(tok: string): boolean {
  if (tok.startsWith("--output")) return true;
  return /^-o/.test(tok) && !tok.startsWith("--");
}

export function matchDangerousBash(
  command: string,
  rules: BashRule[] = DANGEROUS_BASH_RULES,
): BashRule | undefined {
  return rules.find((r) => r.test(command));
}

/**
 * Allowlist check for read-only ask mode.
 * Rejects redirects, subshells, mutators, and unknown first tokens.
 */
export function isSafeBash(command: string): boolean {
  if (/[>`]|\$\(|`|\n/.test(command)) return false;
  if (MUTATING_TOKENS.test(command)) return false;

  for (const part of bashPipelineParts(command)) {
    const tokens = part.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const cmd = tokens[0]!.replace(/^\\/, "");
    if (!SAFE_BASH.has(cmd)) return false;
    const rest = tokens.slice(1);

    if (cmd === "find") {
      if (rest.some((t) => FIND_WRITE_FLAGS.has(t))) return false;
    }

    // sort -o file / tree -o file write output files
    if ((cmd === "sort" || cmd === "tree") && rest.some(isOutputFlag)) {
      return false;
    }

    if (cmd === "git") {
      const sub = tokens[1];
      if (!sub || !SAFE_GIT.has(sub)) return false;
      const args = tokens.slice(2);

      // git log/diff --output=file writes files
      if (args.some((t) => t.startsWith("--output"))) return false;

      // bare `git stash` is `stash push` (mutating) — only list/show are read-only
      if (sub === "stash") {
        if (!args[0] || !["list", "show"].includes(args[0])) return false;
      }

      if (sub === "config") {
        const readOk =
          args.includes("--list") ||
          args.includes("-l") ||
          args.includes("--get") ||
          args.includes("--get-regexp");
        if (!readOk || args.includes("--unset") || args.includes("--add")) return false;
      }

      if (sub === "branch") {
        for (const tok of args) {
          // bare name creates/renames a branch
          if (!tok.startsWith("-")) return false;
          if (GIT_BRANCH_MUTATING_LONG.has(tok)) return false;
          if (/^-[^-]/.test(tok) && /[dDmMcCuf]/.test(tok.slice(1))) return false;
        }
      }

      if (sub === "tag") {
        for (const tok of args) {
          // bare name creates a tag
          if (!tok.startsWith("-")) return false;
          if (GIT_TAG_MUTATING_LONG.has(tok)) return false;
          if (/^-[^-]/.test(tok) && /[dasfum]/.test(tok.slice(1))) return false;
        }
      }

      if (sub === "remote") {
        const remoteSub = args[0];
        if (remoteSub && remoteSub !== "-v" && remoteSub !== "--verbose" && !SAFE_GIT_REMOTE.has(remoteSub)) {
          return false;
        }
      }
    }

    if ((cmd === "npm" || cmd === "pnpm" || cmd === "yarn") && tokens[1] && !SAFE_PKG.has(tokens[1])) {
      return false;
    }

    // Interpreters/build tools: version/help only. Bare `node`/`python3` would
    // read a program from stdin (e.g. `cat x.js | node`), so require the flag.
    if (cmd === "node" || cmd === "python" || cmd === "python3" || cmd === "cargo" || cmd === "rustc") {
      const flag = tokens[1];
      if (!flag || !SAFE_VERSION_FLAGS.has(flag)) return false;
    }

    if (cmd === "go") {
      const sub = tokens[1];
      if (!sub || !["version", "help", "--help", "-h"].includes(sub)) return false;
    }
  }
  return true;
}

export function block(reason: string): { block: true; reason: string } {
  return { block: true, reason };
}
