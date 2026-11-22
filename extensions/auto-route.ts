/**
 * Auto Route Extension
 *
 * Ports agent0-runtime's intent routing (routing.py) as a pi virtual model:
 * `/model router/auto` scores the configured candidates once per user task,
 * sticks to the winner through tool rounds, and fails over down the scored
 * order on retries. Scoring runs on deepseek-flash (env PI_AUTO_SCORER to
 * override) via DeepSeek's chat completions API, mirroring the Python
 * scorer's prompt, 5s timeout, and 3-point switch hysteresis.
 *
 * Candidate pool: PI_AUTO_ROUTE_MODELS (comma-separated provider/model refs),
 * defaulting to deepseek-flash + kimi-for-coding (scoring/coding) and
 * k3.1-pro (hard problems).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

const SCORE_TIMEOUT_MS = 5_000;
const SCORE_MAX_TOKENS = 500;
const SWITCH_SCORE_MARGIN = 3.0;
const TASK_MAX_CHARS = 6_000;
const RECENT_MESSAGES = 2;
const RECENT_ENTRY_MAX_CHARS = 2_000;
const RECENT_TOTAL_MAX_CHARS = 4_000;

const ENV_PROXY_AGENT = new EnvHttpProxyAgent();

interface Candidate {
	ref: string;
	hint: string;
}

/** Role hints mirror the reviewed capability notes in agent0-runtime. */
const DEFAULT_CANDIDATES: Candidate[] = [
	{ ref: "deepseek/deepseek-flash", hint: "fast and cheap; quick answers, simple edits, scoring" },
	{ ref: "kimi-coding/kimi-for-coding", hint: "strong everyday coding; implementation, tests, tool use" },
	{ ref: "kimi-coding/k3.1-pro", hint: "most capable; difficult debugging, architecture, reasoning" },
];

const DEFAULT_SCORER = "deepseek/deepseek-flash";
const INTENTS = new Set(["quick", "coding", "debugging", "reasoning"]);

interface RouterState {
	order: string[];
	index: number;
	intent?: string;
}

const clean = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function configuredCandidates(): Candidate[] {
	const env = clean(process.env.PI_AUTO_ROUTE_MODELS);
	if (!env) return DEFAULT_CANDIDATES;
	const listed = env
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	const known = new Map(DEFAULT_CANDIDATES.map((candidate) => [candidate.ref, candidate.hint]));
	return listed.map((ref) => ({ ref, hint: known.get(ref) ?? "" }));
}

/** The deepseek API key pi stored via /login, honoring `!command` keys like pi does. */
function storedDeepSeekKey(): string | null {
	try {
		const agentDir = clean(process.env.PI_CODING_AGENT_DIR) || path.join(os.homedir(), ".pi", "agent");
		const parsed = JSON.parse(readFileSync(path.join(agentDir, "auth.json"), "utf8")) as Record<
			string,
			{ type?: string; key?: unknown }
		>;
		const key = clean(parsed?.deepseek?.key);
		if (!key) return null;
		if (key.startsWith("!")) {
			const output = execFileSync("/bin/sh", ["-c", key.slice(1)], {
				encoding: "utf8",
				timeout: 10_000,
				stdio: ["ignore", "pipe", "ignore"],
			});
			return output.trim() || null;
		}
		return key;
	} catch {
		return null;
	}
}

function scorerApiKey(): string {
	return clean(process.env.DEEPSEEK_API_KEY) ?? storedDeepSeekKey() ?? "";
}

function scorerBaseUrl(): string {
	const base = (clean(process.env.DEEPSEEK_BASE_URL) || "https://api.deepseek.com").replace(/\/+$/, "");
	return base.endsWith("/v1") ? base : `${base}/v1`;
}

type RouteMessage = { role?: string; content?: unknown };

function latestUserTask(messages: readonly RouteMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		const text = messageText(message.content);
		if (text) return text.slice(0, TASK_MAX_CHARS);
	}
	return "";
}

function recentContext(messages: readonly RouteMessage[]): string {
	const entries: string[] = [];
	for (let index = messages.length - 2; index >= 0 && entries.length < RECENT_MESSAGES; index--) {
		const message = messages[index];
		if (message?.role !== "user" && message?.role !== "assistant") continue;
		const text = messageText(message.content);
		if (text) entries.unshift(`${message.role}: ${text.slice(0, RECENT_ENTRY_MAX_CHARS)}`);
	}
	return entries.join("\n").slice(0, RECENT_TOTAL_MAX_CHARS);
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			Boolean(part && typeof part === "object" && part.type === "text" && typeof part.text === "string"),
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function hasImages(messages: readonly RouteMessage[]): boolean {
	return messages.some((message) =>
		Array.isArray(message?.content)
			? message.content.some((part) => Boolean(part && typeof part === "object" && part.type === "image"))
			: false,
	);
}

interface ScoreResult {
	intent: string;
	scores: Record<string, number>;
}

async function scoreCandidates(
	scorerModel: string,
	candidates: Candidate[],
	task: string,
	recent: string,
	images: boolean,
): Promise<ScoreResult> {
	const payload = {
		task,
		recent_context: recent,
		candidates: candidates.map((candidate) => ({ ref: candidate.ref, routing_hint: candidate.hint })),
		...(images ? { has_images: true } : {}),
	};
	const instructions =
		"You are a model router, not the task solver. Score every supplied candidate from 0 to 100 for this task. " +
		"Use fast/coding models for simple or quick coding tasks and strong models for difficult debugging, architecture, " +
		"and reasoning. Classify quick as explanations or trivial edits, coding as implementation or tests, debugging as " +
		"failures or root causes, and reasoning as design, architecture, tradeoffs, or proofs. Candidate order is not a " +
		"ranking; use routing_hint to differentiate models within a tier. Consider tool use and context needs. When " +
		"has_images is true the task includes image attachments you cannot see; prefer candidates whose routing_hint " +
		"suggests vision capability. Return only one JSON object with this shape: " +
		'{"intent":"quick|coding|debugging|reasoning","scores":{"provider/model":0}}. ' +
		"Use only the exact candidate refs; do not answer the task.";

	const apiKey = scorerApiKey();
	if (!apiKey) throw new Error("no deepseek API key for auto-route scoring");

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SCORE_TIMEOUT_MS);
	let parsed: ScoreResult;
	try {
		const response = await undiciFetch(`${scorerBaseUrl()}/chat/completions`, {
			dispatcher: ENV_PROXY_AGENT,
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({
				model: scorerModel,
				temperature: 0,
				max_tokens: SCORE_MAX_TOKENS,
				response_format: { type: "json_object" },
				messages: [
					{ role: "system", content: instructions },
					{ role: "user", content: JSON.stringify(payload) },
				],
			}),
			signal: controller.signal,
		});
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`scorer HTTP ${response.status}`);
		}
		const body = (await response.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
		};
		const raw = clean(body.choices?.[0]?.message?.content);
		if (!raw) throw new Error("scorer returned empty content");
		const data = JSON.parse(raw) as { intent?: unknown; scores?: unknown };
		if (!data || typeof data !== "object" || typeof data.scores !== "object" || !data.scores) {
			throw new Error("scorer returned no scores");
		}
		const refs = new Map(candidates.map((candidate) => [candidate.ref.toLowerCase(), candidate.ref]));
		const scores: Record<string, number> = {};
		for (const [ref, value] of Object.entries(data.scores as Record<string, unknown>)) {
			const canonical = refs.get(ref.toLowerCase());
			if (canonical === undefined || typeof value !== "number" || !Number.isFinite(value)) continue;
			if (value < 0 || value > 100) continue;
			scores[canonical] = value;
		}
		const intent = typeof data.intent === "string" && INTENTS.has(data.intent) ? data.intent : "coding";
		if (Object.keys(scores).length === 0) throw new Error("scorer returned no usable scores");
		parsed = { intent, scores };
	} finally {
		clearTimeout(timer);
	}
	return parsed;
}

/** Prefer the incumbent unless a challenger beats it by the hysteresis margin. */
function scoredOrder(candidates: Candidate[], previousRef: string | null, scores: Record<string, number>): string[] {
	const ordered = [...candidates].sort((left, right) => (scores[right.ref] ?? -1) - (scores[left.ref] ?? -1));
	if (previousRef && ordered.some((candidate) => candidate.ref === previousRef) && previousRef in scores) {
		const best = scores[ordered[0].ref] ?? -1;
		if (best - scores[previousRef] < SWITCH_SCORE_MARGIN) {
			ordered.sort((left, right) => (left.ref === previousRef ? -1 : right.ref === previousRef ? 1 : 0));
		}
	}
	return ordered.map((candidate) => candidate.ref);
}

function fallbackOrder(candidates: Candidate[], previousRef: string | null): string[] {
	if (previousRef && candidates.some((candidate) => candidate.ref === previousRef)) {
		return [previousRef, ...candidates.filter((candidate) => candidate.ref !== previousRef).map((c) => c.ref)];
	}
	return candidates.map((candidate) => candidate.ref);
}

export default function autoRouteExtension(pi: ExtensionAPI): void {
	pi.registerVirtualModel<RouterState>({
		provider: "router",
		id: "auto",
		name: "Auto",
		contextWindow: 1_048_576,
		thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		async route(request, ctx) {
			const registry = ctx.modelRegistry;
			const resolve = (ref: string): Model<any> | undefined => {
				const slash = ref.indexOf("/");
				return slash > 0 ? registry.find(ref.slice(0, slash), ref.slice(slash + 1)) : undefined;
			};

			let candidates = configuredCandidates().filter((candidate) => resolve(candidate.ref));
			if (candidates.length === 0) {
				throw new Error("auto: no configured route models are available in the catalog");
			}
			const images = hasImages(request.messages);
			if (images) {
				const seeing = candidates.filter((candidate) => {
					const model = resolve(candidate.ref);
					return model?.input?.includes("image");
				});
				if (seeing.length > 0) candidates = seeing;
			}

			const previousRef = request.previous ? `${request.previous.model.provider}/${request.previous.model.id}` : null;
			const passLevel = request.thinkingLevel ?? "medium";

			if (request.reason === "direct") {
				const model = resolve(candidates[0].ref);
				if (!model) throw new Error(`auto: candidate unavailable: ${candidates[0].ref}`);
				return { model, thinkingLevel: passLevel };
			}

			if (request.reason === "retry") {
				const state = request.state;
				if (state) {
					const nextIndex = state.index + 1;
					if (nextIndex < state.order.length) {
						const model = resolve(state.order[nextIndex]);
						if (model) {
							return { model, thinkingLevel: passLevel, state: { ...state, index: nextIndex } };
						}
					}
				}
			} else if (request.reason === "continuation") {
				// Tool follow-ups stay on the model that handled the turn: switching
				// mid-task would invalidate its prompt cache and thinking signature.
				const sticky = request.failed ?? request.previous;
				if (sticky) {
					return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? passLevel, state: request.state };
				}
			}

			let order: string[];
			let intent: string | undefined;
			if (candidates.length === 1) {
				order = [candidates[0].ref];
			} else {
				const scorerRef = clean(process.env.PI_AUTO_SCORER) || DEFAULT_SCORER;
				const scorerModel = resolve(scorerRef)?.id ?? scorerRef.split("/")[1] ?? scorerRef;
				try {
					const scored = await scoreCandidates(
						scorerModel,
						candidates,
						latestUserTask(request.messages),
						recentContext(request.messages),
						images,
					);
					order = scoredOrder(candidates, previousRef, scored.scores);
					intent = scored.intent;
				} catch {
					order = fallbackOrder(candidates, previousRef);
				}
			}
			const model = resolve(order[0]);
			if (!model) throw new Error(`auto: candidate unavailable: ${order[0]}`);
			return { model, thinkingLevel: passLevel, state: { order, index: 0, intent } };
		},
	});
}
