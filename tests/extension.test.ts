// Drives the extension's event handlers with a stand-in Pi: the account store lives in a temp dir.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier !== "@earendil-works/pi-coding-agent") return next(specifier, context);
		const source = "export const getAgentDir = () => process.env.TEST_AGENT_DIR;";
		return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
	},
});
const { default: extension } = await import("../src/index.ts");

const BRIDGE_LIMIT = "Claude quota exceeded — rate limit (five_hour) — resets 9:30:00 AM: You've hit your session limit · resets 9:30am (America/Sao_Paulo)";
const PI_NON_RETRYABLE = /billing|GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|subscription_sharing_usage_limit_exceeded/i;
const PI_RETRYABLE = /overloaded|rate.?limit|too many requests|429|service.?(?:is.?)?(?:temporarily.?)?unavailable/i;
const piRetries = (m: string) => !PI_NON_RETRYABLE.test(m) && PI_RETRYABLE.test(m);

const now = () => Math.floor(Date.now() / 1000);
const RESET = now() + 3600;
type Handler = (event: any, ctx: any) => any;

let dir: string;
let handlers: Record<string, Handler>;
let command: (args: string, ctx: any) => Promise<void>;
let notices: { text: string; level: string }[];
const ctx = { model: { provider: "claude-bridge" }, ui: { notify: (text: string, level: string) => notices.push({ text, level }) } };
const storeFile = () => join(dir, "claude-accounts.json");
const readStore = () => JSON.parse(readFileSync(storeFile(), "utf-8"));
const usageOf = (name: string) => readStore().accounts.find((a: any) => a.name === name).usage;
const writeAccounts = (active: string, usage: Record<string, number>) =>
	writeFileSync(
		storeFile(),
		JSON.stringify({
			active,
			accounts: [
				{ name: "a", token: "tok-a", usage: { utilization: usage.a, resetsAt: RESET, checkedAt: now() } },
				{ name: "b", token: "tok-b", usage: { utilization: usage.b, resetsAt: RESET, checkedAt: now() } },
				{ name: "login", usage: { utilization: usage.login ?? 0.99, resetsAt: RESET, checkedAt: now() } },
			],
		}),
	);
const headers = (utilization: number) => ({
	"anthropic-ratelimit-unified-5h-utilization": String(utilization),
	"anthropic-ratelimit-unified-5h-reset": String(RESET),
});
const failure = (errorMessage: string) => ({ message: { role: "assistant", provider: "claude-bridge", stopReason: "error", errorMessage, content: [] } });

const load = () => extension({ on: (name: string, h: Handler) => (handlers[name] = h), registerCommand: (_: string, c: any) => (command = c.handler) } as any);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "claude-accounts-"));
	process.env.TEST_AGENT_DIR = dir;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	delete process.env.PI_CLAUDE_ACCOUNTS_EXTERNAL_TOKEN;
	handlers = {};
	notices = [];
	load();
});

test("switches as soon as a response crosses 95%, mid-run", () => {
	writeAccounts("a", { a: 0.9, b: 0.1 });
	handlers.session_start({}, ctx);
	handlers.after_provider_response({ headers: headers(0.96) }, ctx);
	assert.equal(readStore().active, "b");
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-b");
	assert.deepEqual(notices, [{ text: "Claude account switched: a (96%) → b (10%)", level: "warning" }]);
});

test("usage reported by the still-running process stays on its own account", () => {
	writeAccounts("a", { a: 0.9, b: 0.1 });
	handlers.session_start({}, ctx);
	handlers.after_provider_response({ headers: headers(0.96) }, ctx);
	handlers.after_provider_response({ headers: headers(0.98) }, ctx);
	assert.equal(usageOf("a").utilization, 0.98);
	assert.equal(usageOf("b").utilization, 0.1);
	assert.equal(readStore().active, "b");
	assert.equal(notices.length, 1);
});

test("a limit failure switches and is reworded so Pi retries the run on the new account", () => {
	writeAccounts("a", { a: 0.9, b: 0.1 });
	handlers.session_start({}, ctx);
	const result = handlers.message_end(failure(BRIDGE_LIMIT), ctx);
	assert.equal(piRetries(BRIDGE_LIMIT), false);
	assert.equal(result.message.role, "assistant");
	assert.equal(result.message.stopReason, "error");
	assert.equal(piRetries(result.message.errorMessage), true);
	assert.equal(readStore().active, "b");
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-b");
	assert.deepEqual(usageOf("a"), { utilization: 1, resetsAt: RESET, checkedAt: usageOf("a").checkedAt });
	assert.deepEqual(notices, [{ text: 'Claude account switched: a (100%) → b (10%) — "a": limit reached; continuing on "b".', level: "warning" }]);
	// The retried run reports for the new account.
	handlers.after_provider_response({ headers: headers(0.2) }, ctx);
	assert.equal(usageOf("b").utilization, 0.2);
	assert.equal(usageOf("a").utilization, 1);
});

test("after a switch at 95%, the old run's limit failure moves that run without a second switch", () => {
	writeAccounts("a", { a: 0.9, b: 0.1 });
	handlers.session_start({}, ctx);
	handlers.after_provider_response({ headers: headers(0.96) }, ctx);
	const result = handlers.message_end(failure(BRIDGE_LIMIT), ctx);
	assert.equal(piRetries(result.message.errorMessage), true);
	assert.equal(readStore().active, "b");
	assert.deepEqual(notices.map((n) => n.text), ["Claude account switched: a (96%) → b (10%)", 'Claude account "a": limit reached; continuing on "b".']);
});

test("with no account left the failure is kept as is and the store is unchanged", () => {
	writeAccounts("a", { a: 0.9, b: 0.97 });
	handlers.session_start({}, ctx);
	const before = readStore();
	const result = handlers.message_end(failure(BRIDGE_LIMIT), ctx);
	assert.equal(result, undefined);
	assert.equal(readStore().active, "a");
	assert.deepEqual(readStore().accounts.slice(1), before.accounts.slice(1));
	assert.deepEqual(notices, [{ text: 'Claude account "a": limit reached. No other account is available.', level: "error" }]);
});

test("a rejected token switches and the run continues instead of asking to resend", () => {
	writeAccounts("a", { a: 0.1, b: 0.1 });
	handlers.session_start({}, ctx);
	const result = handlers.message_end(failure("Failed to authenticate. API Error: 401 OAuth access token is invalid."), ctx);
	assert.equal(piRetries(result.message.errorMessage), true);
	assert.equal(readStore().active, "b");
	assert.equal(readStore().accounts[0].authFailed, true);
	assert.deepEqual(notices, [{ text: 'Claude account switched: a (10%) → b (10%) — "a": token rejected, re-add it; continuing on "b".', level: "warning" }]);
});

test("other errors and other providers are left alone", () => {
	writeAccounts("a", { a: 0.9, b: 0.1 });
	handlers.session_start({}, ctx);
	assert.equal(handlers.message_end(failure("Operation aborted"), ctx), undefined);
	const other = failure(BRIDGE_LIMIT);
	other.message.provider = "anthropic";
	assert.equal(handlers.message_end(other, ctx), undefined);
	assert.equal(readStore().active, "a");
	assert.deepEqual(notices, []);
});

test("a new prompt still switches at 95% (unchanged)", () => {
	writeAccounts("a", { a: 0.96, b: 0.1 });
	handlers.session_start({}, ctx);
	handlers.before_agent_start({}, ctx);
	assert.equal(readStore().active, "b");
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-b");
	assert.deepEqual(notices, [{ text: "Claude account switched: a (96%) → b (10%)", level: "warning" }]);
});

test("another Pi switching the active account leaves this session on its own account", () => {
	writeAccounts("a", { a: 0.5, b: 0.1 });
	handlers.session_start({}, ctx);
	writeAccounts("b", { a: 0.5, b: 0.1 }); // another Pi instance switched to "b"
	handlers.before_agent_start({}, ctx);
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-a", "the next run keeps this session's cache on its account");
	assert.equal(readStore().active, "b", "the other instance's choice stays the default for new sessions");
	handlers.after_provider_response({ headers: headers(0.6) }, ctx);
	assert.equal(usageOf("a").utilization, 0.6);
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-a");
	assert.deepEqual(notices, []);
});

test("a session left on its own account switches when that account crosses 95%", () => {
	writeAccounts("a", { a: 0.5, b: 0.1 });
	handlers.session_start({}, ctx);
	writeAccounts("login", { a: 0.5, b: 0.1 }); // another Pi instance moved to "login", now at 99%
	handlers.before_agent_start({}, ctx);
	handlers.after_provider_response({ headers: headers(0.96) }, ctx);
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-b", "an exhausted default is skipped too");
	assert.equal(readStore().active, "b");
	assert.deepEqual(notices, [{ text: "Claude account switched: a (96%) → b (10%)", level: "warning" }]);
});

test("a window keeps its account and usage when another window renames it", () => {
	writeAccounts("a", { a: 0.5, b: 0.1 });
	handlers.session_start({}, ctx);
	handlers.before_agent_start({}, ctx);
	// Another Pi instance renames "a" to "c": same token, new name.
	const renamed = readStore();
	renamed.accounts[0].name = "c";
	renamed.active = "c";
	writeFileSync(storeFile(), JSON.stringify(renamed));
	handlers.after_provider_response({ headers: headers(0.6) }, ctx);
	assert.equal(usageOf("c").utilization, 0.6, "the running process reports for its account under the new name");
	handlers.before_agent_start({}, ctx);
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-a", "the next run stays on the same account");
	assert.deepEqual(notices, [], "a rename is not a switch");
});

test("below 95% nothing switches (unchanged)", () => {
	writeAccounts("a", { a: 0.5, b: 0.1 });
	handlers.session_start({}, ctx);
	handlers.before_agent_start({}, ctx);
	handlers.after_provider_response({ headers: headers(0.6) }, ctx);
	assert.equal(readStore().active, "a");
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-a");
	assert.deepEqual(notices, []);
});

test("after another retried error the new process reports for the new account", () => {
	writeAccounts("a", { a: 0.9, b: 0.1 });
	handlers.session_start({}, ctx);
	handlers.after_provider_response({ headers: headers(0.96) }, ctx);
	assert.equal(handlers.message_end(failure("Our servers are currently overloaded. Please try again later."), ctx), undefined);
	handlers.after_provider_response({ headers: headers(0.3) }, ctx);
	assert.equal(usageOf("b").utilization, 0.3);
	assert.equal(usageOf("a").utilization, 0.96);
});

test("when Pi has no retries left the account still switches but no retry is promised", () => {
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ retry: { maxRetries: 1 } }));
	writeAccounts("a", { a: 0.9, b: 0.1 });
	handlers.session_start({}, ctx);
	handlers.message_end(failure("Our servers are currently overloaded. Please try again later."), ctx);
	assert.equal(handlers.message_end(failure(BRIDGE_LIMIT), ctx), undefined);
	assert.equal(readStore().active, "b");
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-b");
	assert.deepEqual(notices, [{ text: 'Claude account switched: a (100%) → b (10%) — "a": limit reached. Pi will not retry; send your message again.', level: "warning" }]);
});

test("a successful response gives the run its retries back", () => {
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ retry: { maxRetries: 1 } }));
	writeAccounts("a", { a: 0.9, b: 0.1 });
	handlers.session_start({}, ctx);
	handlers.message_end(failure("Our servers are currently overloaded. Please try again later."), ctx);
	handlers.message_end({ message: { role: "assistant", provider: "claude-bridge", stopReason: "stop", content: [] } }, ctx);
	assert.equal(piRetries(handlers.message_end(failure(BRIDGE_LIMIT), ctx).message.errorMessage), true);
});

test("with auto-retry disabled no retry is promised", () => {
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	writeAccounts("a", { a: 0.9, b: 0.1 });
	handlers.session_start({}, ctx);
	assert.equal(handlers.message_end(failure(BRIDGE_LIMIT), ctx), undefined);
	assert.equal(readStore().active, "b");
});

test("renaming the running account keeps its usage on it", async () => {
	writeAccounts("a", { a: 0.5, b: 0.1 });
	handlers.session_start({}, ctx);
	await command("rename a c", ctx);
	handlers.after_provider_response({ headers: headers(0.6) }, ctx);
	assert.equal(usageOf("c").utilization, 0.6);
});

test("a subagent inheriting the parent's account token does not take it for the login account", async () => {
	writeAccounts("login", { a: 0.1, b: 0.1, login: 0.1 });
	handlers.session_start({}, ctx); // parent: login account, nothing exported
	await command("use a", ctx); // parent now runs on "a"
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-a");
	load(); // a subagent process starts with the parent's environment
	writeAccounts("login", { a: 0.1, b: 0.1, login: 0.1 });
	handlers.session_start({}, ctx);
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});
