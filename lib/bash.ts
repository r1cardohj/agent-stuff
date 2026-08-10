/** Shared bash policy helpers for itsdangerous + ask-mode. */

export type GuardAction = "deny" | "ask";

export type BashRule = {
  name: string;
  pattern: RegExp;
  action: GuardAction;
};

/** Destructive / high-risk patterns (itsdangerous denylist). */
export const DANGEROUS_BASH_RULES: BashRule[] = [
  {
    name: "rm recursive force",
    pattern:
      /\brm\s+(-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r|--recursive\b[^\n]*--force|--force\b[^\n]*--recursive)\b/i,
    action: "deny",
  },
  {
    name: "curl|sh / wget|sh",
    pattern: /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba)?sh\b/i,
    action: "deny",
  },
  {
    name: "disk wipe (dd/mkfs/mkswap)",
    pattern: /\b(dd\b|mkfs(\.\w+)?\b|mkswap\b)/i,
    action: "deny",
  },
  {
    name: "sudo",
    pattern: /(^|[;&|]|&&|\|\|)\s*sudo\b|\bsudo\s+/i,
    action: "ask",
  },
  {
    name: "git force push",
    pattern: /\bgit\s+push\b[^\n]*(--force(-with-lease)?|\s-f\b)/i,
    action: "ask",
  },
  {
    name: "git reset --hard",
    pattern: /\bgit\s+reset\s+--hard\b/i,
    action: "ask",
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
  "env",
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

const MUTATING_TOKENS =
  /\b(rm|mv|cp|mkdir|touch|chmod|chown|tee|dd|mkfs|sudo|kill|pkill)\b/i;

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

export function matchDangerousBash(
  command: string,
  rules: BashRule[] = DANGEROUS_BASH_RULES,
): BashRule | undefined {
  return rules.find((r) => r.pattern.test(command));
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

    if (cmd === "git") {
      const sub = tokens[1];
      if (!sub || !SAFE_GIT.has(sub)) return false;
      if (sub === "stash" && tokens[2] && !["list", "show"].includes(tokens[2])) {
        return false;
      }
      if (sub === "config") {
        const rest = tokens.slice(2);
        const readOk =
          rest.includes("--list") ||
          rest.includes("-l") ||
          rest.includes("--get") ||
          rest.includes("--get-regexp");
        if (!readOk || rest.includes("--unset") || rest.includes("--add")) return false;
      }
    }

    if ((cmd === "npm" || cmd === "pnpm" || cmd === "yarn") && tokens[1] && !SAFE_PKG.has(tokens[1])) {
      return false;
    }

    if (cmd === "node" || cmd === "python" || cmd === "python3") {
      const flag = tokens[1];
      if (flag && !["--version", "-v", "-V", "--help", "-h"].includes(flag)) return false;
    }
  }
  return true;
}

export function block(reason: string): { block: true; reason: string } {
  return { block: true, reason };
}
