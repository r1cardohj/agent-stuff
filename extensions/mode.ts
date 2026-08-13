/**
 * One-command mode switching:
 *
 *   /yolo   full tools, unrestricted (default)
 *   /ask    read-only Q&A: answer questions and show code, no file writes
 *   /teach  education mode: teach from first principles, step by step,
 *           with examples and code review (read-only, learner writes the code)
 *
 * /mode is gone — use the dedicated commands: /yolo, /ask, /teach.
 * Start on: pi --mode ask
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { block, isSafeBash } from "../lib/bash.ts";

type Mode = "yolo" | "ask" | "teach";

const MODES: Mode[] = ["yolo", "ask", "teach"];

const READONLY_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;
const WRITE_TOOLS = new Set(["write", "edit"]);
const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const PROMPT_DIR = join(dirname(fileURLToPath(import.meta.url)), "mode");

function loadPrompt(name: string): string {
  return readFileSync(join(PROMPT_DIR, `${name}.md`), "utf8").trim();
}

function normalizeMode(value: string): Mode | undefined {
  if (value === "agent") return "yolo"; // legacy alias
  return (MODES as string[]).includes(value) ? (value as Mode) : undefined;
}

export default function (pi: ExtensionAPI) {
  let mode: Mode = "yolo";
  let toolsBefore: string[] | undefined;

  pi.registerFlag("mode", {
    description: "Start in a mode (yolo|ask|teach)",
    type: "string",
    default: "yolo",
  });

  function setStatus(ctx: ExtensionContext) {
    ctx.ui.setStatus(
      "mode",
      mode === "yolo" ? undefined : ctx.ui.theme.fg("warning", mode),
    );
  }

  function applyTools() {
    if (mode === "yolo") {
      pi.setActiveTools(toolsBefore ?? DEFAULT_TOOLS);
      toolsBefore = undefined;
    } else {
      if (toolsBefore === undefined) {
        toolsBefore = pi.getActiveTools();
      }
      const available = new Set(pi.getAllTools().map((t) => t.name));
      pi.setActiveTools(READONLY_TOOLS.filter((t) => available.has(t)));
    }
  }

  function setMode(next: Mode, ctx: ExtensionContext) {
    if (next === mode) {
      ctx.ui.notify(`Already in ${mode} mode`, "info");
      return;
    }
    mode = next;
    applyTools();
    setStatus(ctx);
    const notes: Record<Mode, string> = {
      yolo: "Yolo mode — full tools, no restrictions",
      ask: "Ask mode — read-only (no write/edit)",
      teach: "Teach mode — step-by-step learning, read-only",
    };
    ctx.ui.notify(notes[mode], "info");
  }

  function registerModeCommand(
    name: string,
    target: Mode,
    description: string,
  ) {
    pi.registerCommand(name, {
      description,
      handler: async (_args, ctx) => {
        setMode(target, ctx);
      },
    });
  }

  registerModeCommand(
    "yolo",
    "yolo",
    "Switch to yolo mode — full tools, no restrictions",
  );
  registerModeCommand(
    "ask",
    "ask",
    "Switch to ask mode — read-only Q&A",
  );
  registerModeCommand(
    "teach",
    "teach",
    "Switch to teach mode — first-principles learning, examples + code review",
  );

  pi.on("tool_call", async (event) => {
    if (mode === "yolo") return;

    if (WRITE_TOOLS.has(event.toolName)) {
      return block(
        `pi-agent-stuff ${mode} mode: write/edit are disabled. Tell the user to type /yolo in pi to switch back. Do not invent other slash commands.`,
      );
    }

    if (event.toolName === "bash") {
      const command = String((event.input as { command?: string }).command ?? "");
      if (!isSafeBash(command)) {
        return block(
          `pi-agent-stuff ${mode} mode: bash not allowlisted (read-only only).\nCommand: ${command}\nUser can switch back with /yolo.`,
        );
      }
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (mode === "yolo") return;
    return { systemPrompt: `${event.systemPrompt}\n\n${loadPrompt(mode)}` };
  });

  pi.on("session_start", async (_event, ctx) => {
    const flag = pi.getFlag("mode");
    if (typeof flag === "string") {
      const normalized = normalizeMode(flag);
      if (normalized && normalized !== "yolo") {
        setMode(normalized, ctx);
        return;
      }
    }
    setStatus(ctx);
  });
}
