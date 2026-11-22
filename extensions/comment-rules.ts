/**
 * Comment Rules Extension
 *
 * Appends the comment conventions in lib/comments.md to the system prompt
 * on every turn, so the rules are always active without invoking anything.
 * The file lives outside prompts/ on purpose: it is a system-prompt resource,
 * not a `/` command.
 *
 * Edit lib/comments.md to change the rules; /reload picks it up.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RULES_PATH = fileURLToPath(new URL("../lib/comments.md", import.meta.url));

function loadRules(): string {
	try {
		return readFileSync(RULES_PATH, "utf8").trim();
	} catch {
		return "";
	}
}

export default function commentRulesExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => {
		const rules = loadRules();
		if (!rules) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${rules}` };
	});
}
