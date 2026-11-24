/**
 * One-command mode switching:
 *
 *   /yolo   full tools, unrestricted (default)
 *   /ask    read-only Q&A: answer questions and show code, no file writes
 *   /teach  education mode: teach from first principles, step by step,
 *           with examples and code review (read-only, learner writes the code)
 *   /plan   read-only planning: explore (search/fetch allowed), propose a
 *           numbered plan, user approves to execute with progress tracking
 *
 * Start on: pi --agent-mode ask  (NOT --mode: that's pi's built-in output-mode flag)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { block, isSafeBash } from "../lib/bash.ts";
import {
  allStepsComplete,
  extractTodoItems,
  getTextContent,
  isAssistantMessage,
  markCompletedSteps,
  type TodoItem,
} from "../lib/plan.ts";

type Mode = "yolo" | "ask" | "teach" | "plan";

const MODES: Mode[] = ["yolo", "ask", "teach", "plan"];

const READONLY_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;
const PLAN_TOOLS = ["read", "grep", "find", "ls", "bash", "search", "fetch"] as const;
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

interface PersistedState {
  mode: Mode;
  todos: TodoItem[];
  executing: boolean;
  toolsBefore?: string[];
}

export default function (pi: ExtensionAPI) {
  let mode: Mode = "yolo";
  let toolsBefore: string[] | undefined;
  let todos: TodoItem[] = [];
  let executing = false;

  pi.registerFlag("agent-mode", {
    description: "Start in a mode (yolo|ask|teach|plan)",
    type: "string",
    default: "yolo",
  });

  function updateStatus(ctx: ExtensionContext) {
    let badge: string | undefined;
    if (executing && todos.length > 0) {
      const completed = todos.filter((t) => t.completed).length;
      badge = ctx.ui.theme.fg("accent", `📋 ${completed}/${todos.length}`);
      ctx.ui.setStatus("mode", badge);
      const lines = todos.map((item) => {
        const text = item.text.length > 60 ? `${item.text.slice(0, 57)}...` : item.text;
        if (item.completed) {
          return ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(text));
        }
        return `${ctx.ui.theme.fg("muted", "☐ ")}${text}`;
      });
      ctx.ui.setWidget("plan-todos", lines);
    } else {
      badge = mode === "yolo" ? undefined : ctx.ui.theme.fg("warning", mode);
      ctx.ui.setStatus("mode", badge);
      ctx.ui.setWidget("plan-todos", undefined);
    }
    // Consumed by extensions/pretty.ts (editor border badge).
    pi.events.emit("agent-stuff:mode-status", { text: badge });
  }

  function applyTools() {
    if (mode === "yolo") {
      pi.setActiveTools(toolsBefore ?? DEFAULT_TOOLS);
      toolsBefore = undefined;
      return;
    }
    if (toolsBefore === undefined) {
      toolsBefore = pi.getActiveTools();
    }
    const available = new Set(pi.getAllTools().map((t) => t.name));
    const list = mode === "plan" ? PLAN_TOOLS : READONLY_TOOLS;
    pi.setActiveTools(list.filter((t) => available.has(t)));
  }

  function persist() {
    pi.appendEntry("agent-mode", { mode, todos, executing, toolsBefore });
  }

  function setMode(next: Mode, ctx: ExtensionContext) {
    if (next === mode) {
      ctx.ui.notify(`Already in ${mode} mode`, "info");
      return;
    }
    if (next === "plan") {
      executing = false;
      todos = [];
    } else if (mode === "plan" && !executing) {
      todos = [];
    }
    mode = next;
    applyTools();
    updateStatus(ctx);
    persist();
    const notes: Record<Mode, string> = {
      yolo: "Yolo mode — full tools, no restrictions",
      ask: "Ask mode — read-only (no write/edit)",
      teach: "Teach mode — step-by-step learning, read-only",
      plan: "Plan mode — read-only exploration (search/fetch allowed), propose a numbered plan",
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

  function togglePlan(ctx: ExtensionContext) {
    setMode(mode === "plan" ? "yolo" : "plan", ctx);
  }

  pi.registerCommand("plan", {
    description: "Toggle plan mode — read-only planning, approve to execute",
    handler: async (_args, ctx) => togglePlan(ctx),
  });

  pi.registerShortcut("ctrl+alt+p", {
    description: "Toggle plan mode",
    handler: async (ctx) => togglePlan(ctx),
  });

  pi.registerCommand("todos", {
    description: "Show current plan progress",
    handler: async (_args, ctx) => {
      if (todos.length === 0) {
        ctx.ui.notify("No plan. Create one with /plan", "info");
        return;
      }
      const list = todos
        .map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`)
        .join("\n");
      ctx.ui.notify(`Plan progress:\n${list}`, "info");
    },
  });

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
    if (mode !== "yolo") {
      return { systemPrompt: `${event.systemPrompt}\n\n${loadPrompt(mode)}` };
    }
    if (executing && todos.length > 0) {
      const remaining = todos.filter((t) => !t.completed);
      if (remaining.length === 0) return;
      const list = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
      const context = `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${list}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`;
      return { systemPrompt: `${event.systemPrompt}\n\n${context}` };
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!executing || todos.length === 0) return;
    if (!isAssistantMessage(event.message)) return;
    markCompletedSteps(getTextContent(event.message), todos);
    updateStatus(ctx);
    persist();
  });

  pi.on("agent_end", async (event, ctx) => {
    if (executing && todos.length > 0) {
      const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
      if (lastAssistant && allStepsComplete(getTextContent(lastAssistant))) {
        for (const t of todos) t.completed = true;
      }
      if (todos.every((t) => t.completed)) {
        const completedList = todos.map((t) => `~~${t.text}~~`).join("\n");
        pi.sendMessage(
          { customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
          // nextTurn: delivered with the next user prompt instead of triggering
          // an extra LLM turn to acknowledge the card.
          { deliverAs: "nextTurn" },
        );
        executing = false;
        todos = [];
        updateStatus(ctx);
        persist();
      }
      return;
    }

    if (mode !== "plan" || !ctx.hasUI) return;

    const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
    if (lastAssistant) {
      const extracted = extractTodoItems(getTextContent(lastAssistant));
      if (extracted.length > 0) todos = extracted;
    }
    if (todos.length === 0) return;
    persist();

    const todoListText = todos.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
    const planCard = {
      customType: "plan-todo-list",
      content: `**Plan Steps (${todos.length}):**\n\n${todoListText}`,
      display: true,
    };

    const choice = await ctx.ui.select("Plan mode - what next?", [
      "Execute the plan (track progress)",
      "Stay in plan mode",
      "Refine the plan",
    ]);

    if (choice?.startsWith("Execute")) {
      const first = todos[0];
      if (!first) return;
      // executing before setMode: leaving plan mode otherwise discards the todos.
      executing = true;
      setMode("yolo", ctx);
      updateStatus(ctx);

      const remainingList = todos.map((t) => `${t.step}. ${t.text}`).join("\n");
      const execMessage = `Execute the plan.

Remaining steps:
${remainingList}

Start with: ${first.text}
After completing a step, include a [DONE:n] tag in your response.`;
      pi.sendMessage(planCard, { deliverAs: "followUp" });
      pi.sendMessage(
        { customType: "plan-mode-execute", content: execMessage, display: true },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } else if (choice === "Refine the plan") {
      const refinement = await ctx.ui.editor("Refine the plan:", "");
      if (refinement?.trim()) {
        pi.sendMessage(planCard, { deliverAs: "followUp" });
        pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
      }
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    const saved = entries
      .filter((e) => e.type === "custom" && e.customType === "agent-mode")
      .pop() as { data?: PersistedState } | undefined;
    if (saved?.data) {
      const restored = normalizeMode(saved.data.mode);
      if (restored) mode = restored;
      todos = saved.data.todos ?? [];
      executing = saved.data.executing ?? false;
      toolsBefore = saved.data.toolsBefore;
    }

    const flag = pi.getFlag("agent-mode");
    if (typeof flag === "string") {
      const normalized = normalizeMode(flag);
      if (normalized && normalized !== "yolo") mode = normalized;
    }

    // Rebuild completion state from messages after the last execute marker,
    // so [DONE:n] tags from earlier plans are not picked up.
    if (executing && todos.length > 0) {
      let executeIndex = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        if ((entries[i] as { customType?: string }).customType === "plan-mode-execute") {
          executeIndex = i;
          break;
        }
      }
      const texts: string[] = [];
      for (let i = executeIndex + 1; i < entries.length; i++) {
        const entry = entries[i] as { type: string; message?: AgentMessage };
        if (entry.type === "message" && entry.message && isAssistantMessage(entry.message)) {
          texts.push(getTextContent(entry.message));
        }
      }
      markCompletedSteps(texts.join("\n"), todos);
    }

    if (mode !== "yolo") applyTools();
    updateStatus(ctx);
  });
}
