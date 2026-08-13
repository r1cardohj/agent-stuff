/**
 * /split — Split the current Windows Terminal window into a new pane
 * and fork the current pi session into it.
 *
 * Usage:
 *   /split v   vertical split (side by side)
 *   /split h   horizontal split (stacked)
 *   /split     pick direction interactively
 *
 * Notes:
 * - wt.exe treats ";" as a subcommand separator, so the fork command is
 *   written to a temp script and executed via `bash -l <script>` to keep
 *   the wt command line free of semicolons/inner quotes.
 * - `-w 0` targets the most recently used Windows Terminal window
 *   (i.e. the current one) instead of opening a new window.
 * - pi does NOT write the session file to disk until the first assistant
 *   reply (see SessionManager._persist). Forking before that fails with
 *   "source session file is empty or invalid", so we verify the file
 *   exists and has a valid header before spawning wt.exe.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { existsSync, openSync, readSync, closeSync, writeFileSync, unlink } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Delete the temp launcher script shortly after spawning wt.exe. */
function cleanupLater(path: string) {
  const timer = setTimeout(() => unlink(path, () => {}), 30_000);
  timer.unref?.();
}

/**
 * Pi defers writing the session file until the first assistant message.
 * Returns true only if the file exists on disk and starts with a valid
 * session header (i.e. `pi --fork` can load it).
 */
function isSessionFileForkable(path: string): boolean {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(4096);
      const n = readSync(fd, buf, 0, buf.length, 0);
      if (n === 0) return false;
      const firstLine = buf.subarray(0, n).toString("utf8").split("\n", 1)[0];
      const header = JSON.parse(firstLine);
      return header?.type === "session" && typeof header?.id === "string";
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("split", {
    description: "Split Windows Terminal pane (v/h) and fork the current session into it",

    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items: AutocompleteItem[] = [
        { value: "v", label: "v — vertical split (side by side)" },
        { value: "h", label: "h — horizontal split (stacked)" },
      ];
      const filtered = items.filter((i) => i.value.startsWith(prefix.toLowerCase()));
      return filtered.length > 0 ? filtered : null;
    },

    handler: async (args, ctx) => {
      // 1. Resolve direction
      let dir = (args ?? "").trim().toLowerCase();
      if (!dir) {
        const choice = await ctx.ui.select("Split direction", [
          "v — vertical (side by side)",
          "h — horizontal (stacked)",
        ]);
        if (!choice) return;
        dir = choice.startsWith("v") ? "v" : "h";
      }

      let flag: "-V" | "-H";
      if (dir === "v" || dir === "vertical") flag = "-V";
      else if (dir === "h" || dir === "horizontal") flag = "-H";
      else {
        ctx.ui.notify("Usage: /split v|h", "error");
        return;
      }

      // 2. Need a persisted session file to fork.
      //    getSessionFile() returns the in-memory path even before pi has
      //    written anything to disk (file is created on first assistant
      //    reply), so check the file itself.
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify(
          "Current session is ephemeral (no session file). Cannot fork.",
          "error",
        );
        return;
      }
      if (!existsSync(sessionFile) || !isSessionFileForkable(sessionFile)) {
        ctx.ui.notify(
          "Session file is not on disk yet — pi writes it on the first assistant reply. Send a message first, then /split.",
          "error",
        );
        return;
      }

      // 3. Write a temp launcher script (avoids wt.exe ";"/quote parsing)
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const distro = process.env.WSL_DISTRO_NAME;
      let scriptPath: string;
      let wtArgs: string[];

      if (process.platform === "win32") {
        // Native Windows
        scriptPath = join(tmpdir(), `pi-split-${id}.cmd`);
        writeFileSync(scriptPath, `@echo off\r\npi --fork "${sessionFile}"\r\n`);
        wtArgs = [
          "-w", "0",
          "split-pane", flag,
          "--title", "pi (fork)",
          "--startingDirectory", ctx.cwd,
          "cmd.exe", "/c", scriptPath,
        ];
      } else if (distro) {
        // WSL: relaunch into the same distro and cwd.
        // `bash -l` does not read ~/.bashrc, so nvm is missing there.
        // Prepend the bin dir of the node running this pi process (pi's
        // global bin lives next to it) and fall back to sourcing nvm.
        const nodeBinDir = dirname(process.execPath);
        scriptPath = join(tmpdir(), `pi-split-${id}.sh`);
        writeFileSync(
          scriptPath,
          [
            "#!/usr/bin/env bash",
            `export PATH=${shellQuote(nodeBinDir)}":$PATH"`,
            "if ! command -v pi >/dev/null 2>&1",
            "then",
            '  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
            '  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
            "fi",
            "if ! command -v pi >/dev/null 2>&1",
            "then",
            '  echo "pi not found in PATH."',
            "  exec bash",
            "fi",
            `exec pi --fork ${shellQuote(sessionFile)}`,
            "",
          ].join("\n"),
          { mode: 0o755 },
        );
        wtArgs = [
          "-w", "0",
          "split-pane", flag,
          "--title", "pi (fork)",
          "wsl.exe", "-d", distro, "--cd", ctx.cwd,
          "bash", "-l", scriptPath,
        ];
      } else {
        ctx.ui.notify(
          "wt.exe split is only supported under WSL or native Windows.",
          "error",
        );
        return;
      }

      // 4. Spawn wt.exe in the most recently used (current) window.
      //    wt.exe returns immediately after telling the window to split,
      //    so plain execFile is enough (no `detached` — that's spawn-only).
      execFile("wt.exe", wtArgs, (err) => {
        if (err) {
          unlink(scriptPath, () => {});
          ctx.ui.notify(`wt.exe failed: ${err.message}`, "error");
        }
      });
      cleanupLater(scriptPath);

      ctx.ui.notify(
        `Splitting ${flag === "-V" ? "vertically" : "horizontally"} and forking session into the new pane…`,
        "info",
      );
    },
  });
}
