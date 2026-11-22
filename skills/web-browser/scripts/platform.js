/**
 * Platform detection helpers (WSL support).
 *
 * Under WSL there is often no Linux Chrome/Chromium installed, but the Windows
 * host has one. Windows binaries (.exe) are launched through WSL interop and
 * can reach a user-data-dir on the WSL filesystem via its `wslpath -w` UNC
 * form, but they must be stopped via CDP (SIGTERM to the interop proxy does
 * not kill the Windows process).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

let wslCached;

export function isWsl() {
	if (wslCached !== undefined) return wslCached;
	try {
		wslCached =
			readFileSync("/proc/sys/kernel/osrelease", "utf8").toLowerCase().includes("microsoft") ||
			Boolean(process.env.WSL_INTEROP) ||
			Boolean(process.env.WSL_DISTRO_NAME);
	} catch {
		wslCached = Boolean(process.env.WSL_DISTRO_NAME);
	}
	return wslCached;
}

/** True when the resolved browser binary is a Windows executable (WSL interop). */
export function isWindowsBinary(binary) {
	return binary.toLowerCase().endsWith(".exe");
}

/** Convert a WSL path to the Windows form (e.g. \\wsl.localhost\Distro\...). */
export function toWindowsPath(p) {
	return execFileSync("wslpath", ["-w", p], { encoding: "utf8" }).trim();
}

/** Both ps-visible forms of a user-data-dir: the WSL path and the Windows UNC form. */
export function userDataDirForms(dir) {
	const forms = [dir];
	if (isWsl()) {
		try {
			const win = toWindowsPath(dir);
			if (win !== dir) forms.push(win);
		} catch {
			// wslpath unavailable; WSL form only
		}
	}
	return forms;
}

/**
 * The Windows host's %LOCALAPPDATA% as a /mnt/<drive> path, for locating the
 * Windows Chrome profile when copying with --profile.
 */
export function windowsLocalAppData() {
	const raw = execFileSync("cmd.exe", ["/c", "echo %LOCALAPPDATA%"], {
		encoding: "utf8",
	}).trim();
	const match = raw.match(/^([A-Za-z]):\\(.*)$/);
	if (!match) return null;
	return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

/** Candidate Chrome/Chromium binaries for the current platform. */
export function chromeBinaryCandidates() {
	const candidates = [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/snap/bin/chromium",
	];
	if (isWsl()) {
		candidates.push(
			"/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
			"/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
			"/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
			"/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe",
		);
	}
	return candidates.filter((p) => existsSync(p));
}
