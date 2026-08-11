/**
 * /mode — switch between agent, ask, and teach modes.
 *
 *   agent  default: full tools, normal behavior
 *   ask    read-only Q&A: answer questions and show code, no file writes
 *   teach  education mode: teach from first principles, step by step,
 *          with examples and code review (read-only, learner writes the code)
 *
 * Usage: /mode [agent|ask|teach]   (no args = show current mode)
 * Start on: pi --mode ask
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { block, isSafeBash } from "../lib/bash.ts";

type Mode = "agent" | "ask" | "teach";

const MODES: Mode[] = ["agent", "ask", "teach"];

const READONLY_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;
const WRITE_TOOLS = new Set(["write", "edit"]);
const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export default function (pi: ExtensionAPI) {
  let mode: Mode = "agent";
  let toolsBefore: string[] | undefined;

  pi.registerFlag("mode", {
    description: "Start in a mode (agent|ask|teach)",
    type: "string",
    default: "agent",
  });

  function setStatus(ctx: ExtensionContext) {
    ctx.ui.setStatus(
      "mode",
      mode === "agent" ? undefined : ctx.ui.theme.fg("warning", mode),
    );
  }

  function applyTools() {
    if (mode === "agent") {
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
      agent: "Agent mode — full tools restored",
      ask: "Ask mode — read-only (no write/edit)",
      teach: "Teach mode — step-by-step learning, read-only",
    };
    ctx.ui.notify(notes[mode], "info");
  }

  pi.registerCommand("mode", {
    description: "Switch mode: agent | ask | teach",
    handler: async (args, ctx) => {
      const a = args?.trim() as Mode | undefined;
      if (!a) {
        if (!ctx.hasUI) {
          ctx.ui.notify(
            `Current mode: ${mode}\nUsage: /mode agent | ask | teach`,
            "info",
          );
          return;
        }
        const labels: Record<Mode, string> = {
          agent: "agent — default, full tools",
          ask: "ask — read-only Q&A",
          teach: "teach — first-principles learning, examples + code review",
        };
        const options = MODES.map(
          (m) => `${m === mode ? "● " : "○ "}${labels[m]}`,
        );
        const choice = await ctx.ui.select(`Select mode (current: ${mode})`, options);
        if (!choice) return;
        const picked = MODES[options.indexOf(choice)];
        if (picked) setMode(picked, ctx);
        return;
      }
      if (!MODES.includes(a)) {
        ctx.ui.notify(`Unknown mode: ${a}. Use agent | ask | teach`, "error");
        return;
      }
      setMode(a, ctx);
    },
    getArgumentCompletions: (prefix) =>
      MODES.filter((m) => m.startsWith(prefix)).map((m) => ({
        value: m,
        label: m,
      })),
  });

  pi.on("tool_call", async (event) => {
    if (mode === "agent") return;

    if (WRITE_TOOLS.has(event.toolName)) {
      return block(
        `pi-agent-stuff ${mode} mode: write/edit are disabled. Tell the user to type /mode agent in pi to switch back. Do not invent other slash commands.`,
      );
    }

    if (event.toolName === "bash") {
      const command = String((event.input as { command?: string }).command ?? "");
      if (!isSafeBash(command)) {
        return block(
          `pi-agent-stuff ${mode} mode: bash not allowlisted (read-only only).\nCommand: ${command}\nUser can switch back with /mode agent.`,
        );
      }
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (mode === "agent") return;

    const prompts: Record<Exclude<Mode, "agent">, string> = {
      ask: `# pi-agent-stuff ask mode (active)
This is the Pi coding agent (not Cursor / VS Code). A local extension enabled read-only ask mode.

Allowed: read, grep, find, ls, and read-only bash; answer questions; show proposed code in markdown fences.
Forbidden: write, edit, or any mutating shell. Do not claim you can switch modes yourself.

Exit (only real commands — do not invent others):
- User types: /mode agent
- Mode switching is done ONLY via the /mode command (modes: agent, ask, teach). Never suggest other commands.

If the user needs a file change: give the full code/patch in chat and say they can run /mode agent to leave ask mode.`,

      teach: `# pi-agent-stuff teach mode (active)
This is the Pi coding agent. A local extension enabled read-only TEACH mode: you are now a mentor, not a code-writing assistant.

Teaching approach:
- Teach from first principles: start from fundamental concepts, build up step by step.
- One step at a time: explain, give a small concrete example, then check the learner's understanding before moving on (e.g. ask a question or give a tiny exercise).
- Give runnable, minimal examples in markdown fences. Prefer examples the learner can try themselves.
- Code review: when the learner shares or writes code, read it, point out what is correct and what is wrong, explain WHY from first principles, and suggest improvements — but let the learner apply the changes themselves.
- Adapt to the learner: if they are lost, go back to the underlying principle; if they are fast, skip ahead.
- Teach in the language the learner uses in the conversation.

Tool rules (same as ask mode):
Allowed: read, grep, find, ls, and read-only bash (to inspect and demonstrate).
Forbidden: write, edit, or any mutating shell. Do not claim you can switch modes yourself.

Exit (only real commands — do not invent others):
- User types: /mode agent
- Mode switching is done ONLY via the /mode command (modes: agent, ask, teach). Never suggest other commands.`,
    };

    return { systemPrompt: `${event.systemPrompt}\n\n${prompts[mode]}` };
  });

  pi.on("session_start", async (_event, ctx) => {
    const flag = pi.getFlag("mode");
    if (typeof flag === "string" && MODES.includes(flag as Mode) && flag !== "agent") {
      setMode(flag as Mode, ctx);
    } else {
      setStatus(ctx);
    }
  });
}
