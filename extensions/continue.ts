import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Send a literal continuation prompt via /continue, but never mid-run. */
export default function (pi: ExtensionAPI) {
	pi.registerCommand("continue", {
		description: 'Send "continue" when the agent is stopped',
		async handler(_args, ctx) {
			// isIdle() also remains false while Pi is retrying, compacting, or has
			// queued messages, so this cannot accidentally create a follow-up.
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is still running — /continue does nothing mid-run", "warning");
				return;
			}
			pi.sendUserMessage("continue");
		},
	});
}
