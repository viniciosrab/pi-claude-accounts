import assert from "node:assert/strict";
import { test } from "node:test";
import { extractAuthUrl, extractToken, runSetupToken, setupTokenCommand } from "../src/setup-token.ts";

const TOKEN = "sk-ant-oat01-Ab_9-xYz0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-0123456789abcdefghijklmnAA";
const URL = "https://claude.ai/oauth/authorize?I0QeRNedXvseC-hFfXOsTxOZm7EXyjumeG494pIKtAos";
// What Claude Code 2.1.330 prints: a colored link (OSC 8), then the token in color among dim lines.
const LINK = `\x1b]8;id=1pa;${URL}\x07\x1b[38;2;153;153;153m${URL}\x1b[39m\x1b]8;;\x07\r\r\n`;
const SUCCESS = `\x1b[32m✓\x1b[39m Long-lived authentication token created\r\n\r\nYour OAuth token (valid for 1 year):\r\n\r\n\x1b[33m${TOKEN}\x1b[39m\r\n\r\n\x1b[2mStore this token securely.\x1b[22m\r\n`;
const node = (script: string): [string, string[]] => [process.execPath, ["-e", script]];

test("reads the token and the sign-in link through terminal escapes", () => {
	assert.equal(extractToken(LINK + SUCCESS), TOKEN);
	assert.equal(extractAuthUrl(LINK + SUCCESS), URL);
	assert.equal(extractToken(LINK), undefined);
});

test("runs script with a terminal on Linux and macOS, nothing elsewhere", () => {
	assert.deepEqual(setupTokenCommand("linux"), ["script", ["-qfec", "stty cols 1000 2>/dev/null; exec claude setup-token", "/dev/null"]]);
	assert.deepEqual(setupTokenCommand("darwin"), ["script", ["-q", "/dev/null", "sh", "-c", "stty cols 1000 2>/dev/null; exec claude setup-token"]]);
	assert.equal(setupTokenCommand("win32"), undefined);
});

test("settles with the token as soon as it is printed, and reports the link once", async () => {
	const urls: string[] = [];
	// Stays alive after printing, like Claude Code waiting before it exits: the token must not wait for that.
	const script = `process.stdout.write(${JSON.stringify(LINK)}); setTimeout(() => process.stdout.write(${JSON.stringify(LINK + SUCCESS)}), 50); setTimeout(() => {}, 60000);`;
	const run = runSetupToken({ command: node(script), onUrl: (u) => urls.push(u) });
	assert.deepEqual(await run.done, { token: TOKEN });
	assert.deepEqual(urls, [URL]);
});

test("a token split across two writes is read whole", async () => {
	const half = Math.floor(SUCCESS.length / 2) + 40;
	const script = `process.stdout.write(${JSON.stringify(SUCCESS.slice(0, half))}); setTimeout(() => process.stdout.write(${JSON.stringify(SUCCESS.slice(half))}), 50); setTimeout(() => {}, 60000);`;
	assert.deepEqual(await runSetupToken({ command: node(script) }).done, { token: TOKEN });
});

test("a typed code reaches the process", async () => {
	const script = `process.stdin.once("data", (d) => { if (d.toString() === "the-code\\r") process.stdout.write(${JSON.stringify(SUCCESS)}); });`;
	const run = runSetupToken({ command: node(script) });
	run.sendCode("  the-code \n");
	assert.deepEqual(await run.done, { token: TOKEN });
});

test("ending without a token says why, with its last lines", async () => {
	const run = runSetupToken({ command: node(`console.log("\\x1b[31mOAuth error: denied\\x1b[39m"); process.exit(1);`) });
	assert.deepEqual(await run.done, { error: "claude setup-token ended (exit 1): OAuth error: denied" });
});

test("a missing program, a timeout and a cancel each settle with an error", async () => {
	assert.match(((await runSetupToken({ command: ["/nonexistent/claude-login", []] }).done) as { error: string }).error, /ENOENT/);
	const slow = node("setTimeout(() => {}, 60000);");
	assert.deepEqual(await runSetupToken({ command: slow, timeoutMs: 50 }).done, { error: "timed out waiting for the browser sign-in" });
	const run = runSetupToken({ command: slow });
	run.cancel();
	assert.deepEqual(await run.done, { error: "cancelled" });
});
