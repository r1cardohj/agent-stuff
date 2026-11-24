import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export interface TodoItem {
  step: number;
  text: string;
  completed: boolean;
}

export function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

// Thinking blocks included: plan drafts and [DONE:n] tags can land in thinking
// rather than the visible text.
export function getTextContent(message: AssistantMessage): string {
  return message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return block.thinking;
      return "";
    })
    .join("\n");
}

export function cleanStepText(text: string): string {
  let cleaned = text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(
      /^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  return cleaned;
}

export function extractTodoItems(message: string): TodoItem[] {
  const items: TodoItem[] = [];
  // Last "Plan:" header wins: a draft in the thinking block precedes the
  // user-visible plan in content order.
  const headers = [...message.matchAll(/\*{0,2}Plan:\*{0,2}\s*\n/gi)];
  if (headers.length === 0) return items;
  const lastHeader = headers[headers.length - 1];
  const planSection = message.slice((lastHeader.index ?? 0) + lastHeader[0].length);
  const numberedPattern = /^\s*(\d+)[.)]\s+(.+)$/gm;

  for (const match of planSection.matchAll(numberedPattern)) {
    const text = match[2]
      .trim()
      .replace(/\*{1,2}$/, "")
      .trim();
    if (text.length > 5 && !text.startsWith("/") && !text.startsWith("-")) {
      const cleaned = cleanStepText(text);
      if (cleaned.length > 3) {
        items.push({ step: items.length + 1, text: cleaned, completed: false });
      }
    }
  }
  return items;
}

export function extractDoneSteps(message: string): number[] {
  const steps: number[] = [];
  for (const match of message.matchAll(/\[DONE\s*:?\s*(\d+)\]/gi)) {
    steps.push(Number(match[1]));
  }
  for (const match of message.matchAll(/\bDone\s*:\s*(\d+)\b/gi)) {
    steps.push(Number(match[1]));
  }
  // Adjacency-anchored: "Step 9 is not done" / "Step 9 incomplete" must not match.
  for (const match of message.matchAll(/\bStep\s*(\d+)\s+(?:is\s+)?(?:done|complete|completed|finished)\b/gi)) {
    steps.push(Number(match[1]));
  }
  return [...new Set(steps)];
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
  const doneSteps = extractDoneSteps(text);
  let marked = 0;
  for (const step of doneSteps) {
    const item = items.find((t) => t.step === step && !t.completed);
    if (item) {
      item.completed = true;
      marked++;
    }
  }
  return marked;
}

// Fallback for a final message that wraps up without [DONE:n] tags; only
// consulted on the run's last assistant message.
export function allStepsComplete(message: string): boolean {
  return (
    /(?:all|every)\s+steps?\s+(?:are\s+|is\s+)?(?:done|complete|completed|finished)/i.test(message) ||
    /\b(?:the\s+)?plan\s+(?:is\s+)?(?:complete|completed|done)\b/i.test(message)
  );
}
