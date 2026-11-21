// Runs `claude setup-token` (the official login for a long-lived token) and reads the token from its
// output, so adding an account needs only a sign-in in the browser. Claude Code draws a terminal UI, so
// it runs under `script`, which gives it a terminal; a wide one keeps the token on one line.

import { spawn } from "node:child_process";

export type SetupTokenResult = { token: string } | { error: string };
export type SetupTokenRun = {
	/** Settles once: with the token, or with why none came (the process ended, failed or timed out). */
	done: Promise<SetupTokenResult>;
	/** Types a code the browser page shows, for when its redirect cannot reach this machine. */
	sendCode(code: string): void;
	cancel(): void;
};

const LOGIN = "stty cols 1000 2>/dev/null; exec claude setup-token";
/** `script` takes its arguments differently on Linux (util-linux) and macOS (BSD). */
export const setupTokenCommand = (platform: NodeJS.Platform = process.platform): [string, string[]] | undefined => {
	if (platform === "linux") return ["script", ["-qfec", LOGIN, "/dev/null"]];
	if (platform === "darwin") return ["script", ["-q", "/dev/null", "sh", "-c", LOGIN]];
	return undefined;
};

// Terminal escapes: OSC (links, titles) up to BEL or ST, then CSI and the other short ones.
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]/g;
const plain = (output: string) => output.replace(ESCAPES, "");
export const extractToken = (output: string) => plain(output).match(/sk-ant-oat01-[A-Za-z0-9_-]+/)?.[0];
export const extractAuthUrl = (output: string) => plain(output).match(/https:\/\/claude\.ai\/oauth\/authorize\?[^\s\x07]+/)?.[0];
/** The last lines the process printed, to say why no token came. */
const tail = (output: string) =>
	plain(output)
		.split(/\r?\n|\r/)
		.map((l) => l.trim())
		.filter(Boolean)
		.slice(-3)
		.join(" / ")
		.slice(0, 300);

export function runSetupToken(opts: {
	onUrl?: (url: string) => void;
	command?: [string, string[]];
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}): SetupTokenRun {
	const command = opts.command ?? setupTokenCommand();
	if (!command) return { done: Promise.resolve({ error: `not supported on ${process.platform}` }), sendCode() {}, cancel() {} };
	const child = spawn(command[0], command[1], { env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
	let output = "";
	let url: string | undefined;
	let settle!: (r: SetupTokenResult) => void;
	const done = new Promise<SetupTokenResult>((resolve) => (settle = resolve));
	let settled = false;
	const finish = (r: SetupTokenResult) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		if (child.exitCode === null) child.kill();
		settle(r);
	};
	const timer = setTimeout(() => finish({ error: "timed out waiting for the browser sign-in" }), opts.timeoutMs ?? 10 * 60_000);
	const read = (chunk: Buffer) => {
		output += chunk.toString("utf-8");
		if (!url && (url = extractAuthUrl(output))) opts.onUrl?.(url);
		// The token is complete once a character that cannot be part of it follows it.
		const token = extractToken(output);
		if (token && plain(output).length > plain(output).indexOf(token) + token.length) finish({ token });
	};
	child.stdout.on("data", read);
	child.stderr.on("data", read);
	child.stdin.on("error", () => {}); // the process may end before a code is typed
	child.on("error", (e) => finish({ error: e.message }));
	child.on("close", (code) => {
		const token = extractToken(output);
		finish(token ? { token } : { error: `claude setup-token ended (exit ${code})${tail(output) ? `: ${tail(output)}` : ""}` });
	});
	return {
		done,
		sendCode: (code) => {
			if (!settled) child.stdin.write(`${code.trim()}\r`);
		},
		cancel: () => finish({ error: "cancelled" }),
	};
}
