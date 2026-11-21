import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// Writes the given pieces 30ms apart, then stays alive like Claude Code does after printing.
const pieces = (parts: string[]) =>
	node(`const p = ${JSON.stringify(parts)}; p.forEach((x, i) => setTimeout(() => process.stdout.write(x), i * 30)); setTimeout(() => {}, 60000);`);

test("a piece ending inside an escape after the token never glues its parameters to the token", async () => {
	for (const [a, b] of [["\x1b[1;", "2m\r\n"], ["\x1b[38;2;", "1;2;3m\r\n"], ["\x1b]8;;http", "s://x\x07\r\n"], ["\x1b", "[39m\r\n"]]) {
		assert.deepEqual(await runSetupToken({ command: pieces([`token:\r\n${TOKEN}${a}`, b]) }).done, { token: TOKEN }, JSON.stringify(a));
	}
});

test("a sign-in link split across pieces is reported whole", async () => {
	const urls: string[] = [];
	const cut = LINK.indexOf(URL) + 20; // inside the link escape
	const run = runSetupToken({ command: pieces([LINK.slice(0, cut), LINK.slice(cut), SUCCESS]), onUrl: (u) => urls.push(u) });
	await run.done;
	assert.deepEqual(urls, [URL]);
});

test("an error never shows something token-shaped from the output", async () => {
	const run = runSetupToken({ command: node(`console.log("Your token: sk-ant-oat02-SECRET"); process.exit(2);`) });
	assert.deepEqual(await run.done, { error: "claude setup-token ended (exit 2): Your token: [token]" });
});

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const waitFor = async (check: () => boolean) => {
	for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
	return check();
};
// Like `script` running `claude`: the process started gets a child of its own, which must stop too.
const withGrandchild = (pidFile: string): [string, string[]] => ["sh", ["-c", `sleep 300 & echo $! > ${pidFile}; wait`]];
const pidIn = async (file: string) => (await waitFor(() => { try { return readFileSync(file, "utf-8").trim() !== ""; } catch { return false; } }), Number(readFileSync(file, "utf-8")));

test("cancel stops the whole process group, the grandchild included", async () => {
	const file = join(mkdtempSync(join(tmpdir(), "setup-token-")), "pid");
	const run = runSetupToken({ command: withGrandchild(file) });
	const pid = await pidIn(file);
	assert.ok(alive(pid));
	run.cancel();
	await run.done;
	assert.ok(await waitFor(() => !alive(pid)), "grandchild still running");
});

test("Pi exiting mid sign-in stops it too", async () => {
	const file = join(mkdtempSync(join(tmpdir(), "setup-token-")), "pid");
	const src = join(import.meta.dirname, "../src/setup-token.ts");
	const script = `const { runSetupToken } = await import(${JSON.stringify(src)}); runSetupToken({ command: ${JSON.stringify(withGrandchild(file))} }); setTimeout(() => process.exit(0), 300);`;
	execFileSync(process.execPath, ["--input-type=module", "-e", script]);
	const pid = await pidIn(file);
	assert.ok(await waitFor(() => !alive(pid)), "grandchild still running after exit");
});
