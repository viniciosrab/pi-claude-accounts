// Reads an inactive account's 5h usage. setup-token tokens are refused by the usage endpoint and
// by direct API calls, so the probe runs Claude Code itself with a minimal Haiku prompt; its
// rate_limit_event reports the window even when the account is exhausted.

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { effectiveUtilization, type Account, type Usage } from "./policy.ts";

/** Seconds a probed value stays trusted. */
export const PROBE_TTL = 600;
/** Active-account utilization at which the others are probed, ahead of the 95% switch. */
export const PREFETCH_AT = 0.85;
const TIMEOUT_MS = 90_000;

/** One-character Haiku prompt with everything optional switched off (hooks, MCP, tools, skills,
 *  session files): ~1.8s instead of ~9s. `--bare` would be lighter but never reads OAuth tokens. */
export const PROBE_ARGS: readonly string[] = [
	"-p", ".", "--model", "haiku", "--output-format", "stream-json", "--verbose",
	"--setting-sources=", "--strict-mcp-config", "--tools=", "--no-session-persistence", "--disable-slash-commands",
];

const AUTH_FAILURE = /failed to authenticate|not logged in|oauth (access )?token (is invalid|has been revoked|has expired)|\b401\b/i;

/** True for the messages Claude Code gives when it refuses a token (as relayed by claude-bridge). */
export function isAuthFailure(message: string | undefined): boolean {
	return message !== undefined && AUTH_FAILURE.test(message);
}

/** Whether a probe ended because the token was refused. */
export function probeAuthFailed(stdout: string): boolean {
	for (const line of stdout.split("\n")) {
		try {
			const msg = JSON.parse(line);
			if (msg?.type === "result" && msg.is_error && isAuthFailure(String(msg.result ?? ""))) return true;
		} catch {}
	}
	return false;
}

export type ProbeResult = { usage?: Usage; authFailed: boolean };

export function parseProbeOutput(stdout: string): Usage | undefined {
	let found: Usage | undefined;
	for (const line of stdout.split("\n")) {
		let msg: any;
		try {
			msg = JSON.parse(line);
		} catch {
			continue;
		}
		const w = msg?.type === "rate_limit_event" ? msg.rate_limit_info?.unifiedWindows?.five_hour : undefined;
		if (w && typeof w.utilization === "number") found = { utilization: w.utilization, resetsAt: w.resetsAt };
	}
	return found;
}

/** Accounts other than the active one whose data is missing or older than the TTL. A window
 *  that already reset is known to be empty and needs no probe. */
export function staleAccounts<A extends Account>(accounts: A[], activeName: string, now: number): A[] {
	return accounts.filter((a) => {
		if (a.name === activeName) return false;
		if (!a.usage) return true;
		if (effectiveUtilization(a, now) === 0 && a.usage.resetsAt !== undefined && a.usage.resetsAt <= now) return false;
		return a.usage.checkedAt === undefined || now - a.usage.checkedAt > PROBE_TTL;
	});
}

/** `token` undefined means the login in ~/.claude/.credentials.json. */
export function probeAccount(token: string | undefined, executable = "claude"): Promise<ProbeResult> {
	const env = { ...process.env };
	if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
	else delete env.CLAUDE_CODE_OAUTH_TOKEN;
	return new Promise((resolve) => {
		let out = "";
		const child = spawn(executable, [...PROBE_ARGS], {
			cwd: tmpdir(),
			env,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
		child.stdout.on("data", (chunk) => (out += chunk));
		child.on("error", () => {
			clearTimeout(timer);
			resolve({ authFailed: false });
		});
		child.on("close", () => {
			clearTimeout(timer);
			resolve({ usage: parseProbeOutput(out), authFailed: probeAuthFailed(out) });
		});
	});
}
