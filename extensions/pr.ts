/**
 * PR Extension
 *
 * /pr [title] — open a new pull request for the current changes.
 *
 * The model drives the flow: it reviews status/diff, cuts a branch if needed,
 * commits, pushes, and creates the PR with `gh`.
 *
 * Usage:
 * - `/pr` - pick a title from the changes, then create the PR
 * - `/pr fix the flaky login test` - use this as the PR title
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const buildPrompt = (args: string): string => {
	const title = args.trim();
	const lines = [
		`Create a new pull request for the current changes in this repository.`,
		``,
		`1. Run \`git status\` and \`git diff\` (staged + unstaged) to understand the changes. If there are no changes, say so and stop.`,
		`2. If the current branch already has an open PR (check with \`gh pr view\`) or its commits are already pushed, do NOT create a duplicate — report the existing PR instead.`,
		`3. Choose a PR title${title ? ` — use exactly this: "${title}"` : ` based on the changes (imperative, concise)`}. If the title is ambiguous, ask the user before continuing.`,
		`4. If on the default branch (check with \`gh repo view --json defaultBranchRef --jq .defaultBranchRef.name\`), create a new branch first: a short kebab-case slug derived from the title.`,
		`5. Stage and commit all intended changes (follow the commit conventions from /home/houjun/project/agent-stuff/skills/commit/SKILL.md), then \`git push -u origin HEAD\`.`,
		`6. Create the PR: \`gh pr create --title "<title>" --body "<body>"\`. Write the body as a short summary of the changes (what/why), derived from the diff.`,
		`7. Report the PR URL.`,
	];
	return lines.join("\n");
};

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("pr", {
		description: "Open a new PR for the current changes (branch, commit, push, gh pr create)",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Creating PR…", "info");
			}
			pi.sendUserMessage(buildPrompt(args));
		},
	});
}
