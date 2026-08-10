/**
 * /ask — read-only mode: answer questions and show code, no file writes.
 *
 * Toggle: /ask
 * Start on: pi --ask
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { block, isSafeBash } from "../lib/bash.ts";

const ASK_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;
const WRITE_TOOLS = new Set(["write", "edit"]);

export default function (pi: ExtensionAPI) {
  let askEnabled = false;
  let toolsBeforeAsk: string[] | undefined;

  pi.registerFlag("ask", {
    description: "Start in ask mode (read-only)",
    type: "boolean",
    default: false,
  });

  function setStatus(ctx: ExtensionContext) {
    ctx.ui.setStatus(
      "ask-mode",
      askEnabled ? ctx.ui.theme.fg("warning", "ask") : undefined,
    );
  }

  function enableAsk(ctx: ExtensionContext) {
    if (!askEnabled) {
      toolsBeforeAsk = pi.getActiveTools();
    }
    askEnabled = true;
    const available = new Set(pi.getAllTools().map((t) => t.name));
    pi.setActiveTools(ASK_TOOLS.filter((t) => available.has(t)));
    setStatus(ctx);
    ctx.ui.notify("Ask mode on — read-only (no write/edit)", "info");
  }

  function disableAsk(ctx: ExtensionContext) {
    askEnabled = false;
    pi.setActiveTools(toolsBeforeAsk ?? ["read", "bash", "edit", "write", "grep", "find", "ls"]);
    toolsBeforeAsk = undefined;
    setStatus(ctx);
    ctx.ui.notify("Ask mode off — full tools restored", "info");
  }

  function toggleAsk(ctx: ExtensionContext) {
    if (askEnabled) disableAsk(ctx);
    else enableAsk(ctx);
  }

  pi.registerCommand("ask", {
    description: "Toggle ask mode (read-only Q&A)",
    handler: async (args, ctx) => {
      const a = args?.trim();
      if (a === "on") enableAsk(ctx);
      else if (a === "off") disableAsk(ctx);
      else toggleAsk(ctx);
    },
  });

  pi.on("tool_call", async (event) => {
    if (!askEnabled) return;

    if (WRITE_TOOLS.has(event.toolName)) {
      return block(
        "pi-agent-stuff ask mode: write/edit are disabled. Tell the user to type /ask (or /ask off) in pi. Do not invent other slash commands.",
      );
    }

    if (event.toolName === "bash") {
      const command = String((event.input as { command?: string }).command ?? "");
      if (!isSafeBash(command)) {
        return block(
          `pi-agent-stuff ask mode: bash not allowlisted (read-only only).\nCommand: ${command}\nUser can exit with /ask or /ask off.`,
        );
      }
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!askEnabled) return;
    return {
      systemPrompt: `${event.systemPrompt}

# pi-agent-stuff ask mode (active)
This is the Pi coding agent (not Cursor / VS Code). A local extension enabled read-only ask mode.

Allowed: read, grep, find, ls, and read-only bash; answer questions; show proposed code in markdown fences.
Forbidden: write, edit, or any mutating shell. Do not claim you can switch modes yourself.

Exit (only real commands — do not invent others):
- User types: /ask   or   /ask off
- There is NO /mode command in Pi. Never suggest /mode, /agent, or similar.

If the user needs a file change: give the full code/patch in chat and say they can run /ask to leave ask mode.`,
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("ask") === true) {
      enableAsk(ctx);
    } else {
      setStatus(ctx);
    }
  });
}
