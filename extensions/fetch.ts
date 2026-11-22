/**
 * Fetch Extension
 *
 * Ports agent7's `web_fetch.py` to TypeScript: download a URL and return
 * bounded Markdown (HTML pages) or plain text (JSON/source/raw text).
 * HTML extraction uses Defuddle instead of trafilatura; downloads use
 * undici with env-proxy support (HTTP(S)_PROXY / NO_PROXY), matching the
 * Python tool's retry, timeout, and truncation behaviour.
 */

import { TextDecoder } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Defuddle } from "defuddle/node";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { Type } from "typebox";

const DEFAULT_FETCH_CHARS = 12_000;
const MAX_FETCH_CHARS = 50_000;
const MAX_DOWNLOAD_BYTES = 20_000_000;
const CONNECT_TIMEOUT_MS = 8_000;
const READ_TIMEOUT_MS = 20_000;
const USER_AGENT = "Mozilla/5.0 (compatible; agent-stuff)";
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const TEXT_TYPES = new Set([
	"application/javascript",
	"application/json",
	"application/toml",
	"application/x-yaml",
	"application/xml",
	"application/yaml",
]);
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

/** Env-proxy dispatcher is process-wide; create once. */
const proxyAgent = new EnvHttpProxyAgent();

interface Downloaded {
	data: Buffer;
	mediaType: string;
	charset: string | null;
	finalUrl: string;
}

function normalizedUrl(raw: unknown): string {
	if (typeof raw !== "string" || !raw.trim()) throw new Error("url must be a non-empty string");
	let parsed: URL;
	try {
		parsed = new URL(raw.trim());
	} catch {
		throw new Error("url must start with http:// or https://");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("url must start with http:// or https://");
	}
	parsed.hash = "";
	return parsed.toString();
}

function limitChars(maxChars: number | undefined): number {
	if (maxChars === undefined) return DEFAULT_FETCH_CHARS;
	const limit = Math.trunc(maxChars);
	if (limit < 1) throw new Error("max_chars must be at least 1");
	return Math.min(limit, MAX_FETCH_CHARS);
}

function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n... [truncated ${text.length - limit} chars]`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function download(url: string): Promise<Downloaded> {
	let lastError = "could not fetch URL";
	for (let attempt = 0; attempt < 2; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS + READ_TIMEOUT_MS);
		try {
			const response = await undiciFetch(url, {
				dispatcher: proxyAgent,
				headers: { "User-Agent": USER_AGENT },
				signal: controller.signal,
				redirect: "follow", // undici follows up to 20 redirects by default
			});
			if (RETRY_STATUS.has(response.status) && attempt === 0) {
				await response.arrayBuffer().catch(() => {});
				await sleep(500);
				continue;
			}
			if (response.status < 200 || response.status >= 300) {
				throw new Error(`HTTP ${response.status}`);
			}
			const declaredLength = Number(response.headers.get("content-length") ?? 0);
			if (declaredLength > MAX_DOWNLOAD_BYTES) {
				throw new Error(`response exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
			}
			const data = Buffer.from(await response.arrayBuffer());
			if (data.length > MAX_DOWNLOAD_BYTES) {
				throw new Error(`response exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
			}
			const contentType = response.headers.get("content-type") ?? "";
			const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
			const charset = /charset=([^;\s]+)/i.exec(contentType)?.[1]?.replace(/^["']|["']$/g, "") ?? null;
			return { data, mediaType, charset, finalUrl: response.url || url };
		} catch (error) {
			if (error instanceof Error && /^HTTP \d+$/.test(error.message)) throw error;
			if (error instanceof Error && error.message.startsWith("response exceeds")) throw error;
			lastError = "could not fetch URL";
			if (attempt === 0) await sleep(500);
		} finally {
			clearTimeout(timer);
		}
	}
	throw new Error(lastError);
}

function decode(downloaded: Downloaded): string {
	const charset = downloaded.charset ?? "utf-8";
	try {
		return new TextDecoder(charset).decode(downloaded.data);
	} catch {
		return new TextDecoder("utf-8").decode(downloaded.data);
	}
}

function isHtml(downloaded: Downloaded): boolean {
	if (HTML_TYPES.has(downloaded.mediaType)) return true;
	if (downloaded.mediaType) return false;
	const beginning = downloaded.data.subarray(0, 4096).toString("utf8").trimStart().toLowerCase();
	return (
		beginning.startsWith("<!doctype html") ||
		beginning.startsWith("<html") ||
		beginning.startsWith("<head") ||
		beginning.startsWith("<body")
	);
}

function isText(downloaded: Downloaded): boolean {
	const mediaType = downloaded.mediaType;
	if (!mediaType) return downloaded.data.subarray(0, 4096).indexOf(0) === -1;
	return mediaType.startsWith("text/") || TEXT_TYPES.has(mediaType) || /\+(json|xml)$/.test(mediaType);
}

async function extractHtml(downloaded: Downloaded, url: string): Promise<string> {
	const html = decode(downloaded);
	const result = await Defuddle(html, url, { markdown: true });
	return result.contentMarkdown ?? result.content ?? "";
}

async function fetchPage(rawUrl: unknown, maxChars: number | undefined): Promise<string> {
	try {
		const url = normalizedUrl(rawUrl);
		const limit = limitChars(maxChars);
		const downloaded = await download(url);
		let text: string;
		if (isHtml(downloaded)) {
			text = await extractHtml(downloaded, downloaded.finalUrl);
		} else if (isText(downloaded)) {
			text = decode(downloaded);
		} else {
			return `error: unsupported content type: ${downloaded.mediaType || "unknown"}`;
		}
		if (!text || !text.trim()) return "error: no readable text extracted";
		return truncate(text, limit);
	} catch (error) {
		return `error: ${error instanceof Error ? error.message : String(error)}`;
	}
}

export default function fetchExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "fetch",
		label: "Fetch URL",
		description:
			"Download a URL and return bounded Markdown (HTML pages, extracted with Defuddle) or plain text (JSON/source/raw text). Supports env proxies, retries, and charset detection. Use it to read a specific page found via search.",
		parameters: Type.Object({
			url: Type.String({ description: "http(s) URL to fetch" }),
			max_chars: Type.Optional(
				Type.Number({ description: "Max output chars (default 12000, cap 50000)" }),
			),
		}),
		async execute(_toolCallId, params) {
			const text = await fetchPage(params.url, params.max_chars);
			return { content: [{ type: "text" as const, text }], details: {} };
		},
	});
}
