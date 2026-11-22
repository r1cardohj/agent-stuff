/**
 * Websearch Extension
 *
 * Ports agent0-runtime's `web_search.py`: web search through DeepSeek's
 * Search API, exposed as the `search` tool. Logic is kept consistent with the
 * Python implementation — same endpoint handling, retry policy, error
 * messages, score-based triage, and result formatting.
 *
 * Credentials come from DEEPSEEK_API_KEY, falling back to the `deepseek`
 * credential Pi itself stores in <agent-dir>/auth.json (via /login).
 * DEEPSEEK_BASE_URL overrides the endpoint.
 * See skills/websearch/SKILL.md for the query/triage runbook the model reads.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const DEFAULT_COUNT = 8;
const MIN_COUNT = 1;
const MAX_COUNT = 50;
const MAX_QUERY_CHARS = 128; // the API rejects longer queries outright
const MAX_SUMMARY_CHARS = 2_000; // the API promises 600-800, but serves whole pages sometimes
const MAX_CONTENT_CHARS = 4_000;
const MAX_RESULTS_CHARS = 12_000;
const GOOD_SCORE = 1.5; // rerank_score >= 1.5 means "relevant" per the API docs
const FALLBACK_RESULTS = 3; // never hide everything when no result clears GOOD_SCORE
const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_SLEEPS_MS = [500, 1_500];
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const SEARCH_PATH = "/v1/tools/search";
const DEFAULT_BASE_URL = "https://api.deepseek.com";

/** One failed Search request: `status` 0 means the request never landed. */
class HttpError extends Error {
	readonly status: number;
	readonly detail: string;

	constructor(status: number, detail = "") {
		super(detail || `HTTP ${status}`);
		this.status = status;
		this.detail = detail;
	}
}

type SearchResult = {
	rerank_score?: unknown;
	authority?: unknown;
	date?: unknown;
	site_name?: unknown;
	title?: unknown;
	url?: unknown;
	summary?: unknown;
	snippet?: unknown;
	content?: unknown;
};

const clean = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const normalizedQuery = (query: unknown): string => {
	const text = clean(query);
	if (!text) {
		throw new Error("query must be a non-empty string");
	}
	if (text.length > MAX_QUERY_CHARS) {
		throw new Error(
			`query is ${text.length} chars; the API accepts at most ${MAX_QUERY_CHARS} — shorten it`,
		);
	}
	return text;
};

const limitedCount = (count: unknown): number => {
	if (count === undefined || count === null) {
		return DEFAULT_COUNT;
	}
	const limit = typeof count === "number" ? Math.trunc(count) : Number.NaN;
	if (!Number.isFinite(limit)) {
		throw new Error(`count must be an integer, got ${JSON.stringify(count)}`);
	}
	if (limit < MIN_COUNT || limit > MAX_COUNT) {
		throw new Error(`count must be between ${MIN_COUNT} and ${MAX_COUNT}, got ${limit}`);
	}
	return limit;
};

/** `ori_question` sharpens intent; the API caps it at 128 chars like `query`. */
const truncatedQuestion = (question: unknown): string | null => {
	const text = clean(question);
	return text ? text.slice(0, MAX_QUERY_CHARS) : null;
};

const endpoint = (baseUrl: string): string => {
	let base = baseUrl.trim().replace(/\/+$/, "");
	if (base.endsWith("/v1")) {
		// providers may already point at the versioned root
		base = base.slice(0, -3);
	}
	return base + SEARCH_PATH;
};

/** The deepseek API key Pi stored via /login, honoring `!command` keys like Pi does. */
const storedDeepSeekKey = (): string | null => {
	try {
		const agentDir = clean(process.env.PI_CODING_AGENT_DIR) || path.join(os.homedir(), ".pi", "agent");
		const parsed = JSON.parse(readFileSync(path.join(agentDir, "auth.json"), "utf8")) as Record<
			string,
			{ type?: string; key?: unknown }
		>;
		const key = clean(parsed?.deepseek?.key);
		if (!key) {
			return null;
		}
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
};

const credentials = (): { apiKey: string; baseUrl: string } => {
	const apiKey = clean(process.env.DEEPSEEK_API_KEY) || storedDeepSeekKey();
	if (!apiKey) {
		throw new Error(
			"no DeepSeek API key for web search — export DEEPSEEK_API_KEY or run /login with the deepseek provider",
		);
	}
	return { apiKey, baseUrl: clean(process.env.DEEPSEEK_BASE_URL) || DEFAULT_BASE_URL };
};

const post = async (
	url: string,
	payload: Record<string, unknown>,
	apiKey: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
	/** One JSON POST. Throws HttpError for anything that is not a 200 with JSON. */
	const timeout = AbortSignal.timeout(timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
			signal: combined,
		});
	} catch (e) {
		if (signal?.aborted) {
			throw e; // user cancellation is not a search failure
		}
		throw new HttpError(0, e instanceof Error ? e.message : String(e));
	}

	const body = await response.text();
	if (!response.ok) {
		let detail = "";
		try {
			const parsed = JSON.parse(body) as { error?: { message?: unknown } };
			detail = clean(parsed?.error?.message);
		} catch {
			// keep the empty detail
		}
		throw new HttpError(response.status, detail);
	}

	try {
		return (body ? JSON.parse(body) : {}) as Record<string, unknown>;
	} catch {
		throw new HttpError(0, `unreadable response: ${body.slice(0, 200)}`);
	}
};

// A dead connection is worth one more try; 402 and other 4xx are not.
const retryable = (error: HttpError): boolean => error.status === 0 || RETRY_STATUS.has(error.status);

const failed = (error: HttpError): string => {
	const detail = error.detail ? `: ${error.detail}` : "";
	if (error.status === 0) {
		return `error: search request failed${detail}`;
	}
	if (error.status === 401) {
		return "error: DeepSeek API key rejected for web search (401); check the configured key";
	}
	if (error.status === 402) {
		return "error: DeepSeek balance is empty (402); top up before searching again";
	}
	if (error.status === 429) {
		return "error: search rate limited (429); wait a moment before searching again";
	}
	if (error.status >= 500) {
		return `error: search service unavailable (${error.status})${detail} — try again later`;
	}
	return `error: search rejected (${error.status})${detail}`;
};

const score = (result: SearchResult): number => {
	const value = result.rerank_score;
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

const indent = (text: string): string =>
	text
		.split("\n")
		.map((line) => `   ${line}`)
		.join("\n");

const formatResult = (index: number, result: SearchResult, withContent: boolean): string => {
	const meta = [`score ${score(result).toFixed(1)}`];
	if (typeof result.authority === "number" && result.authority >= 0) {
		meta.push(`authority ${result.authority}`);
	}
	const date = clean(result.date).slice(0, 10);
	if (date) {
		meta.push(date);
	}
	const site = clean(result.site_name);
	if (site) {
		meta.push(site);
	}
	const title = clean(result.title) || "(untitled)";
	const lines = [`${index}. ${title}  ·  ${meta.join("  ·  ")}`, `   ${clean(result.url)}`];

	let body = clean(result.summary) || clean(result.snippet);
	if (body) {
		if (body.length > MAX_SUMMARY_CHARS) {
			const cut = body.length - MAX_SUMMARY_CHARS;
			body = `${body.slice(0, MAX_SUMMARY_CHARS)}\n...[summary truncated ${cut} chars; fetch the URL for the rest]`;
		}
		lines.push(indent(body));
	}

	if (withContent) {
		let content = clean(result.content);
		if (content) {
			if (content.length > MAX_CONTENT_CHARS) {
				const cut = content.length - MAX_CONTENT_CHARS;
				content = `${content.slice(0, MAX_CONTENT_CHARS)}\n...[content truncated ${cut} chars]`;
			}
			lines.push("   ---", indent(content));
		}
	}

	return lines.join("\n");
};

const format = (query: string, results: unknown[], withContent: boolean): string => {
	const usable = results.filter(
		(r): r is SearchResult => typeof r === "object" && r !== null && !Array.isArray(r),
	);
	if (usable.length === 0) {
		return `no results for ${JSON.stringify(query)}`;
	}

	let kept = usable.filter((r) => score(r) >= GOOD_SCORE);
	const notes: string[] = [];
	if (kept.length === 0) {
		kept = usable.slice(0, FALLBACK_RESULTS);
		notes.push(`(no result scored >= ${GOOD_SCORE}; showing the top ${kept.length})`);
	} else if (kept.length < usable.length) {
		notes.push(`(${usable.length - kept.length} lower-scoring results hidden)`);
	}

	let text = kept.map((r, i) => formatResult(i + 1, r, withContent)).join("\n\n");
	if (text.length > MAX_RESULTS_CHARS) {
		text = `${text.slice(0, MAX_RESULTS_CHARS)}\n...[truncated ${text.length - MAX_RESULTS_CHARS} chars]`;
	}
	return notes.length > 0 ? `${text}\n${notes.join("\n")}` : text;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const search = async (
	query: string,
	count?: number | null,
	options: { userQuestion?: string; signal?: AbortSignal } = {},
): Promise<string> => {
	/** Search the web and return ranked, model-readable results as text. */
	let text: string;
	let limit: number;
	let apiKey: string;
	let baseUrl: string;
	try {
		text = normalizedQuery(query);
		limit = limitedCount(count);
		({ apiKey, baseUrl } = credentials());
	} catch (e) {
		return `error: ${e instanceof Error ? e.message : String(e)}`;
	}

	const payload: Record<string, unknown> = { query: text, count: limit };
	const question = truncatedQuestion(options.userQuestion);
	if (question) {
		payload.ori_question = question;
	}

	const url = endpoint(baseUrl);
	let body: Record<string, unknown> | null = null;
	for (let attempt = 0; attempt <= RETRY_SLEEPS_MS.length; attempt += 1) {
		try {
			body = await post(url, payload, apiKey, DEFAULT_TIMEOUT_MS, options.signal);
			break;
		} catch (e) {
			if (options.signal?.aborted) {
				throw e;
			}
			const error = e instanceof HttpError ? e : new HttpError(0, String(e));
			if (attempt < RETRY_SLEEPS_MS.length && retryable(error)) {
				await sleep(RETRY_SLEEPS_MS[attempt]);
				continue;
			}
			return failed(error);
		}
	}

	const results = body?.results;
	if (!Array.isArray(results) || results.length === 0) {
		return (
			`no results for ${JSON.stringify(text)} — the search found nothing; ` +
			"broaden the query or drop restrictive operators"
		);
	}
	return format(text, results, false);
};

const searchSchema = Type.Object({
	query: Type.String({
		description: "Search query, 1-128 chars; operators like site:, -, \"...\", lang:, after:/before: pass through",
	}),
	count: Type.Optional(
		Type.Number({ description: `Number of results, ${MIN_COUNT}-${MAX_COUNT}; defaults to ${DEFAULT_COUNT}` }),
	),
	user_question: Type.Optional(
		Type.String({ description: "The user's original wording; sharpens search intent" }),
	),
});

type SearchInput = Static<typeof searchSchema>;

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "search",
		label: "Web Search",
		description:
			"Search the web through DeepSeek's Search API and return ranked results with summaries. " +
			"Answers \"which pages say anything about this\"; open a specific page with fetch instead. " +
			"Read the websearch skill once per task before the first search for query syntax and result triage.",
		promptSnippet: "Search the web for current facts, releases, and error messages",
		promptGuidelines: [
			"Use the search tool for facts that can change since training (versions, prices, CVEs, error messages); never for things the repo already answers.",
			"Read the websearch skill before the first search of a task and follow its query and triage rules.",
		],
		parameters: searchSchema,
		async execute(_toolCallId, params: SearchInput, signal) {
			const text = await search(params.query, params.count ?? null, {
				userQuestion: params.user_question,
				signal: signal ?? undefined,
			});
			return {
				content: [{ type: "text", text }],
				details: {},
			};
		},
	});
}
