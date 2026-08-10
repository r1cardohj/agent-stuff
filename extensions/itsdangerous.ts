/**
 * itsdangerous — block or confirm risky bash commands before they run.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { block, matchDangerousBash } from "../lib/bash.ts";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.notify("itsdangerous loaded", "info");
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const cmd = event.input.command;
    const hit = matchDangerousBash(cmd);
    if (!hit) return;

    if (hit.action === "deny" || !ctx.hasUI) {
      return block(`Blocked by itsdangerous (${hit.name}): ${cmd}`);
    }

    const ok = await ctx.ui.confirm(
      `Risky: ${hit.name}`,
      `Allow this command?\n\n${cmd}`,
    );
    if (!ok) {
      return block(`Denied by user via itsdangerous (${hit.name}): ${cmd}`);
    }
  });
}
