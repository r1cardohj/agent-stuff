#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync, realpathSync } from "fs";
import { spawnSync, execSync } from "child_process";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

function parseArgs(argv) {
	const out = {
		provider: undefined,
		model: undefined,
		purpose: "general research support",
		timeoutMs: 120000,
		json: false,
		help: false,
		query: "",
	};

	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			out.help = true;
			continue;
		}
		if (arg === "--json") {
			out.json = true;
			continue;
		}
		if (arg === "--provider") {
			out.provider = argv[++i];
			continue;
		}
		if (arg.startsWith("--provider=")) {
			out.provider = arg.slice("--provider=".length);
			continue;
		}
		if (arg === "--model") {
			out.model = argv[++i];
			continue;
		}
		if (arg.startsWith("--model=")) {
			out.model = arg.slice("--model=".length);
			continue;
		}
		if (arg === "--purpose") {
			out.purpose = argv[++i] || out.purpose;
			continue;
		}
		if (arg.startsWith("--purpose=")) {
			out.purpose = arg.slice("--purpose=".length) || out.purpose;
			continue;
		}
		if (arg === "--timeout") {
			out.timeoutMs = Math.max(1000, Number(argv[++i] || out.timeoutMs));
			continue;
		}
		if (arg.startsWith("--timeout=")) {
			out.timeoutMs = Math.max(1000, Number(arg.slice("--timeout=".length) || out.timeoutMs));
			continue;
		}
		positional.push(arg);
	}

	out.query = positional.join(" ").trim();
	return out;
}

function usage() {
	return `Usage:
  node search.mjs "<query>" [--purpose "<why>"] [--provider kimi-coding|deepseek] [--model <id>] [--json]

Examples:
  node search.mjs "latest python release" --purpose "update dependency notes"
  node search.mjs "HTTP/3 browser support 2026" --provider deepseek
  node search.mjs "vite 7 breaking changes" --json`;
}

function readJson(path, fallback = {}) {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return fallback;
	}
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolveConfigValue(config) {
	if (typeof config !== "string" || !config) return undefined;
	if (config.startsWith("!")) {
		try {
			const out = execSync(config.slice(1), {
				encoding: "utf8",
				timeout: 10000,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			return out || undefined;
		} catch {
			return undefined;
		}
	}
	return process.env[config] || config;
}

function getAgentDir() {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (!configured) return join(homedir(), ".pi", "agent");
	if (configured === "~") return homedir();
	if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
	return configured;
}

function normalizeProvider(provider) {
	if (!provider) return undefined;
	const p = String(provider).toLowerCase().trim();
	if (p.includes("deepseek") || p === "ds") return "deepseek";
	if (p.includes("kimi")) return "kimi-coding";
	return undefined;
}

function pickProvider(argProvider, settings, auth) {
	const forced = normalizeProvider(argProvider);
	if (forced) return forced;

	// kimi-coding is the only provider here with native web_search support
	// (server-side search execution). DeepSeek's API only accepts `function`
	// tools, so prefer kimi whenever its credential exists.
	if (auth?.["kimi-coding"]) return "kimi-coding";
	if (process.env.DEEPSEEK_API_KEY) return "deepseek";

	throw new Error("Could not determine provider. Pass --provider kimi-coding|deepseek");
}

function findPiExecutable() {
	const cmd = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(cmd, ["pi"], { encoding: "utf8" });
	if (result.status !== 0) return undefined;
	const first = result.stdout
		.split(/\r?\n/)
		.map((x) => x.trim())
		.find(Boolean);
	return first || undefined;
}

function collectModuleCandidates(fileName = "index.js", envVarName = "PI_AI_MODULE_PATH") {
	const candidates = new Set();

	const add = (p) => {
		if (!p) return;
		const abs = isAbsolute(p) ? p : resolve(p);
		candidates.add(abs);
	};

	if (envVarName && process.env[envVarName]) add(process.env[envVarName]);

	const cwd = process.cwd();
	const scriptDir = dirname(fileURLToPath(import.meta.url));
	for (const start of [cwd, scriptDir]) {
		let dir = start;
		for (let i = 0; i < 8; i++) {
			add(join(dir, "node_modules", "@earendil-works", "pi-ai", "dist", fileName));
			add(join(dir, "packages", "ai", "dist", fileName));
			add(join(dir, "ai", "dist", fileName));
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}

	const piExec = findPiExecutable();
	if (piExec) {
		try {
			const piReal = realpathSync(piExec);
			const piDir = dirname(piReal);
			add(join(piDir, "..", "..", "ai", "dist", fileName));
			add(join(piDir, "..", "..", "pi-ai", "dist", fileName));
			add(join(piDir, "..", "node_modules", "@earendil-works", "pi-ai", "dist", fileName));
			add(join(piDir, "..", "..", "node_modules", "@earendil-works", "pi-ai", "dist", fileName));
		} catch {
			// ignore
		}
	}

	add(join(homedir(), "Development", "pi-mono", "packages", "ai", "dist", fileName));

	return Array.from(candidates);
}

async function loadPiAi() {
	const tried = [];

	try {
		return await import("@earendil-works/pi-ai");
	} catch (err) {
		tried.push(`@earendil-works/pi-ai (${err?.code || err?.message || "not found"})`);
	}

	for (const candidate of collectModuleCandidates("index.js", "PI_AI_MODULE_PATH")) {
		if (!existsSync(candidate)) continue;
		try {
			return await import(pathToFileURL(candidate).href);
		} catch (err) {
			tried.push(`${candidate} (${err?.code || err?.message || "failed"})`);
		}
	}

	throw new Error(
		`Could not load @earendil-works/pi-ai. Set PI_AI_MODULE_PATH to its dist/index.js.\nTried:\n- ${tried.join("\n- ")}`,
	);
}

async function loadPiAiOAuth(piAi) {
	if (typeof piAi?.getOAuthApiKey === "function") {
		return { getOAuthApiKey: piAi.getOAuthApiKey.bind(piAi) };
	}

	const tried = [];

	try {
		const oauth = await import("@earendil-works/pi-ai/oauth");
		if (typeof oauth.getOAuthApiKey === "function") {
			return { getOAuthApiKey: oauth.getOAuthApiKey.bind(oauth) };
		}
		tried.push("@earendil-works/pi-ai/oauth (missing getOAuthApiKey export)");
	} catch (err) {
		tried.push(`@earendil-works/pi-ai/oauth (${err?.code || err?.message || "not found"})`);
	}

	for (const candidate of collectModuleCandidates("oauth.js", "PI_AI_OAUTH_MODULE_PATH")) {
		if (!existsSync(candidate)) continue;
		try {
			const oauth = await import(pathToFileURL(candidate).href);
			if (typeof oauth.getOAuthApiKey === "function") {
				return { getOAuthApiKey: oauth.getOAuthApiKey.bind(oauth) };
			}
			tried.push(`${candidate} (missing getOAuthApiKey export)`);
		} catch (err) {
			tried.push(`${candidate} (${err?.code || err?.message || "failed"})`);
		}
	}

	return {
		getOAuthApiKey: undefined,
		error: `Could not load getOAuthApiKey. Set PI_AI_OAUTH_MODULE_PATH to pi-ai dist/oauth.js.\nTried:\n- ${tried.join("\n- ")}`,
	};
}

function parseExpiryTimestamp(expires) {
	if (typeof expires === "number" && Number.isFinite(expires)) {
		if (expires <= 0) return undefined;
		return expires < 1_000_000_000_000 ? expires * 1000 : expires;
	}

	if (typeof expires === "string") {
		const trimmed = expires.trim();
		if (!trimmed) return undefined;

		const numeric = Number(trimmed);
		if (Number.isFinite(numeric)) {
			return parseExpiryTimestamp(numeric);
		}

		const parsed = Date.parse(trimmed);
		if (Number.isFinite(parsed)) return parsed;
	}

	return undefined;
}

function getCachedOAuthAccess(entry, now = Date.now()) {
	if (!entry || typeof entry !== "object") return undefined;

	const apiKey = resolveConfigValue(entry.access);
	if (!apiKey) return undefined;

	const expiresAt = parseExpiryTimestamp(entry.expires);
	if (!expiresAt) return undefined;

	if (now + 30_000 >= expiresAt) return undefined;

	return {
		apiKey,
		accountId: entry.accountId,
	};
}

function pickFastModel(provider, requestedModel, piAi) {
	const models = typeof piAi.getModels === "function" ? piAi.getModels(provider) : [];
	if (!Array.isArray(models) || models.length === 0) {
		if (requestedModel) return { id: requestedModel, baseUrl: undefined };
		if (provider === "deepseek") return { id: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com" };
		return { id: "k3", baseUrl: "https://api.kimi.com/coding" };
	}

	if (requestedModel) {
		const exact = models.find((m) => m.id === requestedModel);
		if (exact) return exact;
		return { ...models[0], id: requestedModel };
	}

	const preferredIds =
		provider === "deepseek"
			? ["deepseek-v4-flash", "deepseek-v4-pro"]
			: ["k3", "kimi-for-coding", "k3-256k"];

	for (const id of preferredIds) {
		const found = models.find((m) => m.id === id);
		if (found) return found;
	}

	const heuristic = models.find((m) => /mini|haiku|spark|flash|fast/i.test(m.id));
	return heuristic || models[0];
}

async function resolveApiKey(provider, auth, authPath, piAi) {
	// deepseek authenticates via env var (pi config: DEEPSEEK_API_KEY).
	if (provider === "deepseek") {
		const key = process.env.DEEPSEEK_API_KEY;
		if (!key) {
			throw new Error("DEEPSEEK_API_KEY is not set. Add it to your environment (pi uses this for the deepseek provider).");
		}
		return { apiKey: key, accountId: undefined };
	}

	const entry = auth?.[provider];
	if (!entry) {
		throw new Error(`No credentials for provider '${provider}' in ${authPath}`);
	}

	const inferredType = entry.type || (entry.access && entry.refresh ? "oauth" : entry.key ? "api_key" : undefined);

	if (inferredType === "api_key") {
		const key = resolveConfigValue(entry.key);
		if (!key) throw new Error(`API key for ${provider} is empty or unresolved.`);
		return { apiKey: key, accountId: entry.accountId };
	}

	if (inferredType !== "oauth") {
		throw new Error(`Unsupported credential type for ${provider}: ${String(entry.type || "unknown")}`);
	}

	const fallbackToken = getCachedOAuthAccess(entry);
	const oauth = await loadPiAiOAuth(piAi);

	if (typeof oauth.getOAuthApiKey !== "function") {
		if (fallbackToken) return fallbackToken;
		throw new Error(oauth.error || "Loaded pi-ai module does not export getOAuthApiKey");
	}

	const oauthCreds = {};
	for (const [k, v] of Object.entries(auth || {})) {
		if (v && (v.type === "oauth" || (v.access && v.refresh && v.expires))) {
			oauthCreds[k] = v;
		}
	}

	let refreshed;
	try {
		refreshed = await oauth.getOAuthApiKey(provider, oauthCreds);
	} catch (err) {
		if (fallbackToken) return fallbackToken;
		throw err;
	}

	if (!refreshed?.apiKey) {
		if (fallbackToken) return fallbackToken;
		throw new Error(`No OAuth credentials available for provider '${provider}'`);
	}

	const mergedCred = { type: "oauth", ...(entry || {}), ...(refreshed.newCredentials || {}) };
	auth[provider] = mergedCred;
	writeJson(authPath, auth);

	return {
		apiKey: refreshed.apiKey,
		accountId: mergedCred.accountId,
	};
}

function buildUserPrompt(query, purpose) {
	return `Search the internet for: ${query}\n\nPurpose: ${purpose}\n\nReturn a concise research summary with:\n- 3 to 7 key findings\n- for every finding: title, why it matters for this purpose, and a full canonical URL (https://...)\n- if multiple sources disagree, call that out\n- finish with a short recommendation on which source(s) to trust first.`;
}

function buildSystemPrompt() {
	return "You are a fast web research assistant. Always produce practical summaries and include full source URLs (no shortened links).";
}

function buildDeepseekUrl(baseUrl = "https://api.deepseek.com") {
	const normalized = String(baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
	if (normalized.endsWith("/chat/completions")) return normalized;
	return `${normalized}/chat/completions`;
}

async function runDeepseekSearch({ model, apiKey, query, purpose, timeoutMs, baseUrl }) {
	const endpoint = buildDeepseekUrl(baseUrl);
	const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;

	const attempt = async (withWebSearch) => {
		const body = {
			model,
			stream: false,
			temperature: 0.2,
			messages: [{ role: "user", content: buildUserPrompt(query, purpose) }],
		};
		if (withWebSearch) {
			body.tools = [{ type: "web_search" }];
		}

		const res = await fetch(endpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
				accept: "application/json",
			},
			body: JSON.stringify(body),
			signal,
		});

		const payload = await res.text();
		if (!res.ok) {
			const err = new Error(`DeepSeek request failed (${res.status}): ${payload.slice(0, 500)}`);
			err.status = res.status;
			throw err;
		}

		let parsed;
		try {
			parsed = JSON.parse(payload);
		} catch {
			throw new Error("DeepSeek returned non-JSON response");
		}

		return (parsed.choices?.[0]?.message?.content || "").trim();
	};

	// DeepSeek's public API only supports `function` tools, no native web_search.
	// Try anyway (newer endpoints may accept it); on 4xx fall back to plain chat.
	try {
		const text = await attempt(true);
		if (text) return { text, usedWebSearch: true };
	} catch (err) {
		if (err.status < 400 || err.status >= 500) throw err;
	}

	const plain = await attempt(false);
	if (!plain) throw new Error("DeepSeek returned an empty response");
	return { text: plain, usedWebSearch: false };
}

// Kimi Code OAuth access token authenticates as `Authorization: Bearer`
// (see pi-ai's kimi-coding provider).
function buildKimiHeaders(apiKey) {
	return {
		authorization: `Bearer ${apiKey}`,
		"anthropic-version": "2023-06-01",
		"anthropic-beta": "web-search-2025-03-05",
		"content-type": "application/json",
		accept: "application/json",
		"User-Agent": "KimiCLI/1.5",
	};
}

async function runKimiSearch({ model, apiKey, query, purpose, timeoutMs, baseUrl = "https://api.kimi.com/coding" }) {
	const endpoint = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
	const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;

	const attempt = async (withWebSearch) => {
		const body = {
			model,
			max_tokens: 1800,
			temperature: 0,
			system: buildSystemPrompt(),
			messages: [{ role: "user", content: buildUserPrompt(query, purpose) }],
		};
		if (withWebSearch) {
			body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }];
		}

		const res = await fetch(endpoint, {
			method: "POST",
			headers: buildKimiHeaders(apiKey),
			body: JSON.stringify(body),
			signal,
		});

		const payload = await res.text();
		if (!res.ok) {
			const err = new Error(`Kimi request failed (${res.status}): ${payload.slice(0, 500)}`);
			err.status = res.status;
			throw err;
		}

		let parsed;
		try {
			parsed = JSON.parse(payload);
		} catch {
			throw new Error("Kimi returned non-JSON response");
		}

		const texts = (parsed.content || [])
			.filter((item) => item.type === "text" && typeof item.text === "string")
			.map((item) => item.text);
		// Kimi returns an intermediate "Search results for query: ..." text block
		// before the final answer; use the last text block.
		const text = texts[texts.length - 1] || "".trim();

		return text;
	};

	// If the endpoint ever rejects the web_search tool, fall back to plain chat.
	try {
		const text = await attempt(true);
		if (text) return text;
	} catch (err) {
		if (err.status < 400 || err.status >= 500) throw err;
	}

	const plain = await attempt(false);
	if (!plain) throw new Error("Kimi returned no text content");
	return plain + "\n\n[note] Kimi endpoint did not accept the web_search tool; result is model knowledge only.";
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.query) {
		console.error(usage());
		process.exit(args.help ? 0 : 1);
	}

	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const settingsPath = join(agentDir, "settings.json");
	const auth = readJson(authPath, {});
	const settings = readJson(settingsPath, {});

	const provider = pickProvider(args.provider, settings, auth);
	const piAi = await loadPiAi();
	const model = pickFastModel(provider, args.model, piAi);
	const { apiKey } = await resolveApiKey(provider, auth, authPath, piAi);

	let text;
	let usedProvider = provider;
	if (provider === "deepseek") {
		const result = await runDeepseekSearch({
			model: model.id,
			apiKey,
			query: args.query,
			purpose: args.purpose,
			timeoutMs: args.timeoutMs,
			baseUrl: model.baseUrl,
		});
		text = result.text;
		if (!result.usedWebSearch && auth?.["kimi-coding"]) {
			// DeepSeek has no native web_search; fall back to kimi-coding for a
			// real search, unless the kimi credential is unusable.
			try {
				const kimiModel = pickFastModel("kimi-coding", undefined, piAi);
				const kimiCred = await resolveApiKey("kimi-coding", auth, authPath, piAi);
				text = await runKimiSearch({
					model: kimiModel.id,
					apiKey: kimiCred.apiKey,
					query: args.query,
					purpose: args.purpose,
					timeoutMs: args.timeoutMs,
				});
				usedProvider = "kimi-coding";
			} catch (err) {
				text += `\n\n[note] DeepSeek API does not support web_search and the kimi-coding fallback failed (${err?.message || err}); result is model knowledge only.`;
			}
		} else if (!result.usedWebSearch) {
			text += "\n\n[note] DeepSeek API does not support the web_search tool; result is model knowledge only.";
		}
	} else {
		text = await runKimiSearch({
			model: model.id,
			apiKey,
			query: args.query,
			purpose: args.purpose,
			timeoutMs: args.timeoutMs,
		});
	}

	const usedModel = usedProvider === provider ? model.id : "k3";

	if (args.json) {
		console.log(
			JSON.stringify(
				{
					provider: usedProvider,
					model: usedModel,
					query: args.query,
					purpose: args.purpose,
					result: text,
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(`Provider: ${usedProvider}`);
	console.log(`Model: ${usedModel}`);
	console.log("");
	console.log(text);
}

main().catch((err) => {
	console.error(`Error: ${err?.message || err}`);
	process.exit(1);
});
