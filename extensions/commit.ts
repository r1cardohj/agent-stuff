/**
 * Commit Extension
 *
 * /commit — commit the current changes following the local "commit" skill
 * (Conventional Commits subject). Does NOT push.
 * /commitpush (alias /cp) — same, then push to the tracking branch.
 *
 * Usage:
 * - `/commit` - commit all changes (staged + unstaged), no push
 * - `/commit files.ts src/` - limit to specific files or globs
 * - `/commitpush` / `/cp` - commit and push
 * - `/commitpush --amend` - amend the previous commit, then push --force-with-lease
 *
 * The model drives the flow: it reviews status/diff, asks when ambiguous,
 * stages, and commits with a skill-style subject.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_INSTRUCTIONS = `Commit the current changes following these rules.

1. Read the skill at /home/houjun/proj/agent-stuff/skills/commit/SKILL.md and follow it for subject format (<type>(<scope>): <summary>, imperative, <=72 chars, no trailing period).
2. Review \`git status\` and \`git diff\` (staged and unstaged) to understand the changes.
3. If there are ambiguous extra files, ask the user which to include before committing. If there are no changes at all, say so and stop.
4. Stage only the intended files, then \`git commit -m "<subject>"\` (add a short body only if it genuinely helps).`;

const PUSH_INSTRUCTIONS = `5. After the commit succeeds, \`git push\`. Report the commit hash and the push result.`;

const buildPrompt = (args: string, push: boolean): string => {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const flags = parts.filter((p) => p.startsWith("--"));
	const files = parts.filter((p) => !p.startsWith("--"));

	const lines = [BASE_INSTRUCTIONS];
	if (files.length > 0) {
		lines.push(`Only stage and commit these paths (nothing else): ${files.join(" ")}`);
	}
	if (push) {
		lines.push(PUSH_INSTRUCTIONS);
	} else {
		lines.push("Do NOT push. Stop after the commit.");
	}
	if (flags.includes("--amend")) {
		lines.push(
			push
				? "Amend the previous commit instead of creating a new one (git commit --amend), then push with --force-with-lease."
				: "Amend the previous commit instead of creating a new one (git commit --amend).",
		);
	}
	return lines.join("\n");
};

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("commit", {
		description: "Commit changes (commit skill style); no push",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Committing…", "info");
			}
			pi.sendUserMessage(buildPrompt(args, false));
		},
	});

	pi.registerCommand("commitpush", {
		description: "Commit changes (commit skill style), then push",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Committing and pushing…", "info");
			}
			pi.sendUserMessage(buildPrompt(args, true));
		},
	});

	pi.registerCommand("cp", {
		description: "Alias for /commitpush",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Committing and pushing…", "info");
			}
			pi.sendUserMessage(buildPrompt(args, true));
		},
	});
}
