import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
	CustomEditor,
	type ContextUsage,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	type Color,
	type EditorTheme,
	foregroundAnsi,
	indexedColor,
	mixColors,
	rgbColor,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

interface PrettyStyle {
	name: string;
	line: string;
	// TL, TR, BL, BR
	corners: [string, string, string, string];
	glow: ThemeColor;
	sep: string;
	barFill: string;
	barEmpty: string;
	icon: string;
}

const STYLE: PrettyStyle = {
	name: "neon",
	line: "─",
	corners: ["╭", "╮", "╰", "╯"],
	glow: "customMessageLabel",
	sep: "┃",
	barFill: "▓",
	barEmpty: "░",
	icon: "◆",
};

let gradientCache: { key: string; theme: Theme; ansi: string[] } | undefined;
let statsCache: { key: string; input: number; output: number; cost: number } | undefined;

// Unicode has no heavy rounded corners, so thickness comes from SGR bold on the
// light box glyphs instead of swapping to heavy (square-cornered) line characters.
const BOLD_ON = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";

function parseFgAnsi(prefix: string): Color | undefined {
	const matches = [...prefix.matchAll(/\x1b\[(?:38;2;(\d+);(\d+);(\d+)|38;5;(\d+)|([39][0-7]))m/g)];
	const m = matches[matches.length - 1];
	if (!m) return undefined;
	if (m[1] !== undefined) return rgbColor(Number(m[1]), Number(m[2]), Number(m[3]));
	if (m[4] !== undefined) return indexedColor(Number(m[4]));
	const code = Number(m[5]);
	return indexedColor(code >= 90 ? code - 90 + 8 : code - 30);
}

function gradientAnsi(theme: Theme, base: Color, glow: Color, count: number, prefix: string): string[] {
	const key = `${STYLE.name}|${count}|${prefix}|${theme.getColorMode()}`;
	if (gradientCache && gradientCache.key === key && gradientCache.theme === theme) return gradientCache.ansi;
	const mode = theme.getColorMode();
	const ansi: string[] = [];
	for (let i = 0; i < count; i++) {
		const t = count <= 1 ? 0 : i / (count - 1);
		ansi.push(foregroundAnsi(mixColors(base, glow, t, "oklch"), mode));
	}
	gradientCache = { key, theme, ansi };
	return ansi;
}

class PrettyEditor extends CustomEditor {
	private appBorderColor: (str: string) => string;
	private borderSide: "top" | "bottom" = "top";

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private ctx: ExtensionContext,
	) {
		super(tui, theme, keybindings);
		this.appBorderColor = this.borderColor;
		// pi reassigns borderColor on thinking-level and bash-mode changes; the accessor
		// keeps those assignments flowing into the decorator instead of replacing it.
		Object.defineProperty(this, "borderColor", {
			get: () => (raw: string) => this.paintBorder(raw),
			set: (fn: (str: string) => string) => {
				this.appBorderColor = fn;
				this.invalidate();
				this.tui.requestRender();
			},
		});
		this.setPaddingX(this.getPaddingX());
	}

	// Box-drawing strokes sit at cell centers, so full-bleed text would overlap the
	// frame; keep >=2 columns of padding so text/cursor stay inside the corners.
	setPaddingX(padding: number): void {
		super.setPaddingX(Math.max(2, padding));
	}

	protected renderTopBorder(width: number, hiddenLineCount: number): string {
		this.borderSide = "top";
		return super.renderTopBorder(width, hiddenLineCount);
	}

	protected renderBottomBorder(width: number, hiddenLineCount: number): string {
		this.borderSide = "bottom";
		return super.renderBottomBorder(width, hiddenLineCount);
	}

	// Rounded corners imply a closed box; draw the missing left/right sides in the
	// padding columns (always spaces at paddingX>=2) so the frame has no gaps.
	render(width: number): string[] {
		const lines = [...super.render(width)];
		const side = BOLD_ON + this.appBorderColor("│") + BOLD_OFF;
		for (let i = 1; i < lines.length - 1; i++) {
			let l = lines[i]!;
			if (l.startsWith(" ")) l = side + l.slice(1);
			if (l.endsWith(" ")) l = l.slice(0, -1) + side;
			lines[i] = l;
		}
		return lines;
	}

	invalidate(): void {
		super.invalidate();
		gradientCache = undefined;
	}

	private paintBorder(raw: string): string {
		const chars = [...raw.replaceAll("─", STYLE.line)];
		const n = chars.length;
		if (n >= 3 && chars[0] === STYLE.line && chars[n - 1] === STYLE.line) {
			chars[0] = this.borderSide === "top" ? STYLE.corners[0] : STYLE.corners[2];
			chars[n - 1] = this.borderSide === "top" ? STYLE.corners[1] : STYLE.corners[3];
		}
		const decorated = chars.join("");
		if (n === 0) return decorated;

		// borderColor is an opaque closure; probe it with a sentinel to recover the ANSI
		// it applies, so the gradient starts from the app's current border color.
		const probe = this.appBorderColor("\x00");
		const cut = probe.indexOf("\x00");
		const prefix = cut > 0 ? probe.slice(0, cut) : "";
		const base = parseFgAnsi(prefix);
		if (!base) return BOLD_ON + this.appBorderColor(decorated) + BOLD_OFF;

		const theme = this.ctx.ui.theme;
		const faint = prefix.includes("\x1b[2m");
		const ansi = gradientAnsi(theme, base, theme.colors[STYLE.glow], n, prefix);
		let out = BOLD_ON + (faint ? "\x1b[2m" : "");
		for (let i = 0; i < n; i++) out += ansi[i] + chars[i];
		return out + "\x1b[22;39m";
	}
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}` || "~";
	return cwd;
}

function sanitizeStatus(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function fitLine(left: string, right: string, width: number): string {
	let l = left;
	let r = right;
	if (visibleWidth(l) + 1 + visibleWidth(r) > width) {
		r = truncateToWidth(r, Math.max(0, width - visibleWidth(l) - 1), "");
	}
	if (visibleWidth(l) + 1 + visibleWidth(r) > width) {
		l = truncateToWidth(l, Math.max(0, width - visibleWidth(r) - 1), "");
	}
	const pad = Math.max(1, width - visibleWidth(l) - visibleWidth(r));
	return truncateToWidth(l + " ".repeat(pad) + r, width);
}

function sessionStats(ctx: ExtensionContext): { input: number; output: number; cost: number } {
	const sm = ctx.sessionManager;
	// Entries are append-only and every append moves the leaf, so sessionId+leafId
	// identifies the stats without copying the entry list on cache hits.
	const key = `${sm.getSessionId()}|${sm.getLeafId()}`;
	if (statsCache && statsCache.key === key) return statsCache;
	let input = 0;
	let output = 0;
	let cost = 0;
	for (const e of sm.getEntries()) {
		let usage: Usage | undefined;
		if (e.type === "usage") usage = e.usage;
		else if (e.type === "message" && e.message.role === "assistant") usage = (e.message as AssistantMessage).usage;
		else if (e.type === "message" && e.message.role === "toolResult") usage = (e.message as { usage?: Usage }).usage;
		else if (e.type === "branch_summary" || e.type === "compaction") usage = e.usage;
		if (usage) {
			input += usage.input;
			output += usage.output;
			cost += usage.cost.total;
		}
	}
	statsCache = { key, input, output, cost };
	return statsCache;
}

function contextBar(theme: Theme, usage: ContextUsage | undefined): string {
	const cells = 10;
	const pct = usage?.percent ?? null;
	const filled = pct === null ? 0 : Math.min(cells, Math.max(0, Math.round(pct / (100 / cells))));
	const color: ThemeColor = pct !== null && pct > 90 ? "error" : pct !== null && pct > 70 ? "warning" : STYLE.glow;
	const bar = theme.fg(color, STYLE.barFill.repeat(filled)) + theme.fg("dim", STYLE.barEmpty.repeat(cells - filled));
	const label = pct === null ? "?" : `${Math.round(pct)}%`;
	const win = usage?.contextWindow ? `/${formatTokens(usage.contextWindow)}` : "";
	return `${bar} ${theme.fg(color, label)}${theme.fg("dim", win)}`;
}

function install(pi: ExtensionAPI, ctx: ExtensionContext): void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsub = footerData.onBranchChange(() => tui.requestRender());
		return {
			dispose: unsub,
			invalidate() {
				statsCache = undefined;
			},
			render(width: number): string[] {
				const stats = sessionStats(ctx);
				const sep = theme.fg("dim", ` ${STYLE.sep} `);

				const branch = footerData.getGitBranch();
				const name = ctx.sessionManager.getSessionName();
				const leftParts = [
					theme.style(STYLE.icon, { fg: STYLE.glow, bold: true }) + " " + theme.fg("muted", formatCwd(ctx.cwd)),
					...(branch ? [theme.fg("accent", branch)] : []),
					...(name ? [theme.fg("dim", name)] : []),
				];
				const model = ctx.model;
				let modelStr = model ? model.id : "no-model";
				if (model?.reasoning) modelStr += ` · ${ctx.thinkingLevel ?? pi.getThinkingLevel()}`;
				if (model && footerData.getAvailableProviderCount() > 1) modelStr = `(${model.provider}) ${modelStr}`;
				const line1 = fitLine(leftParts.join(sep), theme.fg("dim", modelStr), width);

				const usingSub = model?.provider === "kimi-coding";
				const costPart =
					stats.cost > 0 || usingSub ? ` ${theme.fg("dim", `$${stats.cost.toFixed(3)}${usingSub ? " (sub)" : ""}`)}` : "";
				const tokenStr = theme.fg("dim", `↑${formatTokens(stats.input)} ↓${formatTokens(stats.output)}`) + costPart;
				const line2 = fitLine(tokenStr, contextBar(theme, ctx.getContextUsage()), width);

				const lines = [line1, line2];
				const statuses = footerData.getExtensionStatuses();
				if (statuses.size > 0) {
					const text = [...statuses.entries()]
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, t]) => sanitizeStatus(t))
						.join(" ");
					lines.push(truncateToWidth(theme.fg("dim", text), width, theme.fg("dim", "...")));
				}
				return lines;
			},
		};
	});
	ctx.ui.setEditorComponent((tui, theme, keybindings) => new PrettyEditor(tui, theme, keybindings, ctx));
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		install(pi, ctx);
	});

	pi.on("session_shutdown", () => {
		gradientCache = undefined;
		statsCache = undefined;
	});
}
