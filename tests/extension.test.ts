// Drives the extension's event handlers with a stand-in Pi: the account store lives in a temp dir.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

registerHooks({
	resolve(specifier, context, next) {
		// The browser sign-in is a stand-in each test sets in globalThis.setupToken.
		if (specifier === "./setup-token.ts") {
			const stub = "export const runSetupToken = (opts) => globalThis.setupToken(opts);";
			return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
		}
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
// What the extension appended to the session file with pi.appendEntry.
let recorded: { type: string; customType: string; data: any }[];
const ctx = { model: { provider: "claude-bridge" }, ui: { notify: (text: string, level: string) => notices.push({ text, level }) } };
const storeFile = () => join(dir, "claude-accounts", "accounts.json");
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

const load = () =>
	extension({
		on: (name: string, h: Handler) => (handlers[name] = h),
		registerCommand: (_: string, c: any) => (command = c.handler),
		appendEntry: (customType: string, data: any) => recorded.push({ type: "custom", customType, data }),
	} as any);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "claude-accounts-"));
	process.env.TEST_AGENT_DIR = dir;
	delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	delete process.env.PI_CLAUDE_ACCOUNTS_EXTERNAL_TOKEN;
	handlers = {};
	recorded = [];
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

test("removing the login account moves the session running on it to the active account", async () => {
	writeAccounts("login", { a: 0.1, b: 0.1, login: 0.1 });
	handlers.session_start({}, ctx);
	await command("remove login", ctx);
	assert.deepEqual(readStore().accounts.map((a: any) => a.name), ["a", "b"]);
	assert.equal(readStore().active, "a");
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-a");
	assert.equal(notices.at(-1)?.text, 'Account "login" removed.');
	load(); // a new Pi instance reads the store again
	assert.deepEqual(readStore().accounts.map((a: any) => a.name), ["a", "b"]);
});

test("the remove menu offers the login account and says Claude Code stays logged in", async () => {
	writeAccounts("a", { a: 0.1, b: 0.1, login: 0.1 });
	let offered: string[] = [];
	let confirmText = "";
	const menu = { ...ctx, ui: { ...ctx.ui, select: async (_: string, items: string[]) => ((offered = items), items[2]), confirm: async (_: string, text: string) => ((confirmText = text), true) } };
	await command("remove", menu);
	assert.equal(offered.length, 3);
	assert.equal(confirmText, '"login" is the Claude Code login; it will no longer be listed or used here (Claude Code stays logged in).');
	assert.deepEqual(readStore().accounts.map((a: any) => a.name), ["a", "b"]);
});

const logFile = () => join(dir, "claude-accounts", "switches.jsonl");
const readLog = () => (existsSync(logFile()) ? readFileSync(logFile(), "utf-8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const reply = (cacheRead: number, cacheWrite: number) => ({
	message: { role: "assistant", provider: "claude-bridge", stopReason: "stop", content: [], usage: { input: 2, output: 10, cacheRead, cacheWrite } },
});
const sessionCtx = { ...ctx, cwd: "/work/p", sessionManager: { getSessionId: () => "s1" }, getContextUsage: () => ({ tokens: 240000, contextWindow: 1000000 }) };

test("a switch is logged with both accounts' usage, the context size and the first replies on the new account", () => {
	writeAccounts("a", { a: 0.96, b: 0.1 });
	handlers.session_start({}, sessionCtx);
	handlers.before_agent_start({}, sessionCtx);
	handlers.after_provider_response({ headers: headers(0.12) }, sessionCtx);
	handlers.message_end(reply(25000, 215000), sessionCtx);
	handlers.after_provider_response({ headers: headers(0.18) }, sessionCtx);
	handlers.message_end(reply(240000, 500), sessionCtx);
	const [sw, first, second] = readLog();
	assert.equal(typeof sw.at, "string");
	assert.deepEqual(
		{ ...sw, at: undefined },
		{ at: undefined, event: "switch", reason: "threshold", session: "s1", cwd: "/work/p", contextTokens: 240000, from: "a", fromUsage: 0.96, to: "b", toUsage: 0.1 },
	);
	assert.deepEqual({ ...first, at: undefined }, { at: undefined, event: "after-switch", session: "s1", account: "b", usage: 0.12, cacheRead: 25000, cacheWrite: 215000 });
	assert.deepEqual({ ...second, at: undefined }, { at: undefined, event: "after-switch", session: "s1", account: "b", usage: 0.18, cacheRead: 240000, cacheWrite: 500 });
});

test("only the first three replies after a switch are logged", () => {
	writeAccounts("a", { a: 0.96, b: 0.1 });
	handlers.session_start({}, sessionCtx);
	handlers.before_agent_start({}, sessionCtx);
	for (let i = 0; i < 5; i++) handlers.message_end(reply(1000, 10), sessionCtx);
	assert.equal(readLog().length, 4);
});

test("a limit failure logs its switch with the reason", () => {
	writeAccounts("a", { a: 0.9, b: 0.1 });
	handlers.session_start({}, ctx);
	handlers.message_end(failure(BRIDGE_LIMIT), ctx);
	const [sw] = readLog();
	assert.equal(sw.reason, "limit reached");
	assert.equal(sw.from, "a");
	assert.equal(sw.to, "b");
	assert.equal(sw.fromUsage, 1);
	assert.equal(sw.contextTokens, null, "unknown without a context to ask");
});

test("nothing is logged without a switch", () => {
	writeAccounts("a", { a: 0.5, b: 0.1 });
	handlers.session_start({}, sessionCtx);
	handlers.before_agent_start({}, sessionCtx);
	handlers.after_provider_response({ headers: headers(0.6) }, sessionCtx);
	handlers.message_end(reply(1000, 10), sessionCtx);
	assert.deepEqual(readLog(), []);
});

const withHistory = (entries: { type: string }[]) => ({ ...ctx, sessionManager: { getSessionId: () => "s1", getEntries: () => entries, getBranch: () => entries } });
// A conversation with messages plus the account entries this extension recorded in it.
const reopened = () => withHistory([{ type: "message" }, ...recorded]);

test("a new conversation starts on any account with room and leaves the active one alone", (t) => {
	t.mock.method(Math, "random", () => 0.99);
	writeAccounts("a", { a: 0.1, b: 0.1 });
	handlers.session_start({}, withHistory([{ type: "model_change" }]));
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-b");
	assert.equal(readStore().active, "a");
});

test("a reopened conversation still starts on the active account", (t) => {
	t.mock.method(Math, "random", () => 0.99);
	writeAccounts("a", { a: 0.1, b: 0.1 });
	handlers.session_start({}, withHistory([{ type: "message" }]));
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-a");
});

test("sessions leaving a full account do not all land on the same one", (t) => {
	const random = t.mock.method(Math, "random", () => 0);
	const moveFrom = (value: number) => {
		random.mock.mockImplementation(() => value);
		writeAccounts("a", { a: 0.9, b: 0.1, login: 0.1 });
		handlers.session_start({}, ctx);
		return handlers.message_end(failure(BRIDGE_LIMIT), ctx).message.errorMessage;
	};
	assert.match(moveFrom(0), /"b"/);
	assert.match(moveFrom(0.99), /"login"/);
});

// /reload re-imports the extension in the same process: the environment still carries the account
// this session ran on, while the shared default may have moved with another window.
test("a reload keeps a reopened conversation on the account it was running on", (t) => {
	t.mock.method(Math, "random", () => 0.99);
	writeAccounts("a", { a: 0.1, b: 0.1 });
	handlers.session_start({}, withHistory([{ type: "model_change" }])); // new conversation lands on "b"
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-b");
	load(); // /reload
	handlers.session_start({ reason: "reload" }, reopened());
	handlers.before_agent_start({}, ctx);
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-b", "the conversation's cache lives on its own account");
	assert.equal(readStore().active, "a", "the shared default is left alone");
	assert.deepEqual(readLog(), [], "nothing switched");
});

test("a reload keeps a conversation on the login account there", (t) => {
	t.mock.method(Math, "random", () => 0.99);
	writeAccounts("a", { a: 0.1, b: 0.1, login: 0.1 });
	handlers.session_start({}, withHistory([{ type: "model_change" }])); // new conversation lands on "login"
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
	load();
	handlers.session_start({ reason: "reload" }, reopened());
	handlers.before_agent_start({}, ctx);
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test("after a reload a used-up account still moves at the next prompt", (t) => {
	t.mock.method(Math, "random", () => 0.99);
	writeAccounts("a", { a: 0.1, b: 0.1 });
	handlers.session_start({}, withHistory([{ type: "model_change" }]));
	load();
	writeAccounts("a", { a: 0.1, b: 0.97 });
	handlers.session_start({ reason: "reload" }, reopened());
	handlers.before_agent_start({}, ctx);
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-a");
});

test("/resume brings a conversation back to the account it last ran on", (t) => {
	t.mock.method(Math, "random", () => 0.99);
	writeAccounts("a", { a: 0.1, b: 0.1 });
	handlers.session_start({ reason: "new" }, withHistory([{ type: "model_change" }])); // conversation X lands on "b"
	const x = [{ type: "message" }, ...recorded];
	handlers.session_start({ reason: "resume" }, withHistory([{ type: "message" }, { type: "custom", customType: "claude-accounts", data: { account: "a" } }])); // Y ran on "a"
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-a");
	handlers.session_start({ reason: "resume" }, withHistory(x)); // back to X
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-b");
	assert.equal(readStore().active, "a", "the shared default is left alone");
});

test("/resume of a conversation with no recorded account starts on the active account", () => {
	writeAccounts("a", { a: 0.1, b: 0.1 });
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok-b"; // the conversation open before
	handlers.session_start({ reason: "resume" }, withHistory([{ type: "message" }]));
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-a");
});

test("pi --continue and a fork reopen on the recorded account", () => {
	writeAccounts("a", { a: 0.1, b: 0.1 });
	const history = withHistory([{ type: "message" }, { type: "custom", customType: "claude-accounts", data: { account: "b" } }]);
	handlers.session_start({ reason: "startup" }, history);
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-b");
	load();
	handlers.session_start({ reason: "fork" }, history);
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-b");
});

test("a resumed conversation on a used-up account still moves at the next prompt", () => {
	writeAccounts("a", { a: 0.1, b: 0.97 });
	handlers.session_start({ reason: "resume" }, withHistory([{ type: "message" }, { type: "custom", customType: "claude-accounts", data: { account: "b" } }]));
	handlers.before_agent_start({}, ctx);
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-a");
});

test("the account is recorded once per change, never the token", (t) => {
	t.mock.method(Math, "random", () => 0.99);
	writeAccounts("a", { a: 0.96, b: 0.1 });
	handlers.session_start({ reason: "startup" }, withHistory([{ type: "message" }])); // active "a"
	handlers.before_agent_start({}, ctx); // "a" is used up: moves to "b"
	handlers.before_agent_start({}, ctx);
	assert.deepEqual(recorded.map((e) => e.data), [{ account: "a" }, { account: "b" }]);
	assert.ok(!JSON.stringify(recorded).includes("tok-"));
	load(); // a reload finds "b" already recorded and appends nothing
	handlers.session_start({ reason: "reload" }, reopened());
	assert.equal(recorded.length, 2);
});

test("a reload of a conversation recorded before this version keeps the exported token's account", () => {
	// No login account, and the token exported in the shell is also account "a"'s.
	writeFileSync(storeFile(), JSON.stringify({ active: "b", loginRemoved: true, accounts: [{ name: "a", token: "tok-a" }, { name: "b", token: "tok-b" }] }));
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok-a";
	delete process.env.PI_CLAUDE_ACCOUNTS_EXTERNAL_TOKEN; // a fresh Pi records it as the external token
	load();
	handlers.session_start({ reason: "reload" }, withHistory([{ type: "message" }]));
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-a");
});

// A notify line is overwritten by the next status message (e.g. another extension's), so the list would vanish.
test("the account list opens in a panel that stays until closed, from the menu and the list subcommand", async () => {
	writeAccounts("a", { a: 0.4, b: 0.1, login: 0.2 });
	const shown: { title: string; items: string[] }[] = [];
	const ui = { ...ctx.ui, select: async (title: string, items: string[]) => (shown.push({ title, items }), title === "Claude accounts" ? "List accounts" : undefined) };
	await command("", { ...ctx, hasUI: true, ui });
	await command("list", { ...ctx, hasUI: true, ui });
	const list = shown.filter((s) => s.title !== "Claude accounts");
	assert.equal(list.length, 2);
	for (const s of list) {
		assert.equal(s.title, "Claude accounts (5h and weekly usage) · Esc to close");
		assert.equal(s.items.length, 3);
		assert.match(s.items[0], /^\* a {2}5h: 40%/);
		assert.match(s.items[1], /^ {2}b {2}5h: 10%/);
	}
	assert.deepEqual(notices, []);
});

test("the account list shows the weekly usage next to the 5h usage", async () => {
	writeAccounts("a", { a: 0.4, b: 0.1, login: 0.2 });
	const s = readStore();
	s.accounts[0].usage.week = { utilization: 0.25, resetsAt: now() + 2 * 86400 + 600 };
	s.accounts[1].usage.week = { utilization: 0.8, resetsAt: now() - 60 };
	writeFileSync(storeFile(), JSON.stringify(s));
	await command("list", ctx);
	const [a, b, login] = notices[0].text.split("\n");
	assert.match(a, /^\* a {2}5h: 40%, resets in (59m|1h 0m) · week: 25%, resets in 2d 0h \(checked 0m ago\)$/);
	assert.match(b, /^ {2}b {2}5h: 10%, resets in (59m|1h 0m) · week: 0% \(checked 0m ago\)$/);
	assert.doesNotMatch(login, /week/);
});

test("the account list is sorted by the weekly reset, soonest first; accounts without one go last", async () => {
	writeAccounts("a", { a: 0.4, b: 0.1, login: 0.2 });
	const s = readStore();
	s.accounts[0].usage.week = { utilization: 0.25, resetsAt: now() + 4 * 86400 };
	s.accounts[1].usage.week = { utilization: 0.8, resetsAt: now() - 60 };
	s.accounts[2].usage.week = { utilization: 0.5, resetsAt: now() + 86400 };
	s.accounts.push({ name: "c", token: "tok-c" });
	writeFileSync(storeFile(), JSON.stringify(s));
	await command("list", ctx);
	assert.deepEqual(notices[0].text.split("\n").map((l) => l.slice(2).split(" ")[0]), ["login", "a", "b", "c"]);
});

test("the weekly usage reported by the bridge is stored with the 5h usage", () => {
	writeAccounts("a", { a: 0.4, b: 0.1 });
	handlers.after_provider_response({ headers: { ...headers(0.5), "anthropic-ratelimit-unified-7d-utilization": "0.3", "anthropic-ratelimit-unified-7d-reset": String(RESET + 86400) } }, ctx);
	assert.deepEqual(usageOf("a").week, { utilization: 0.3, resetsAt: RESET + 86400 });
	assert.equal(usageOf("a").utilization, 0.5);
});

test("without a UI the account list is still printed as a notice", async () => {
	writeAccounts("a", { a: 0.4, b: 0.1, login: 0.2 });
	await command("list", ctx);
	assert.equal(notices.length, 1);
	assert.equal(notices[0].level, "info");
	assert.match(notices[0].text, /^\* a {2}5h: 40%/);
});

test("files left in the agent dir root by older versions move into claude-accounts/ on load", () => {
	const legacyStore = join(dir, "claude-accounts.json");
	const legacyLog = join(dir, "claude-accounts-switches.jsonl");
	const accounts = JSON.stringify({ active: "a", accounts: [{ name: "a", token: "tok-a" }] });
	writeFileSync(legacyStore, accounts, { mode: 0o600 });
	writeFileSync(legacyLog, '{"event":"switch"}\n');
	load();
	assert.equal(existsSync(legacyStore), false);
	assert.equal(existsSync(legacyLog), false);
	assert.equal(readFileSync(storeFile(), "utf-8"), accounts);
	assert.equal(statSync(storeFile()).mode & 0o777, 0o600);
	assert.equal(statSync(join(dir, "claude-accounts")).mode & 0o777, 0o700);
	assert.equal(readFileSync(logFile(), "utf-8"), '{"event":"switch"}\n');
});

test("a legacy file never overwrites one already in claude-accounts/", () => {
	const legacyStore = join(dir, "claude-accounts.json");
	mkdirSync(join(dir, "claude-accounts"), { recursive: true });
	writeFileSync(storeFile(), '{"active":"new","accounts":[{"name":"new","token":"t"}]}');
	writeFileSync(legacyStore, '{"active":"old","accounts":[{"name":"old","token":"t"}]}');
	load();
	assert.equal(readFileSync(storeFile(), "utf-8"), '{"active":"new","accounts":[{"name":"new","token":"t"}]}');
	assert.equal(existsSync(legacyStore), true);
});

// A stand-in `claude setup-token`: settles when the test says, records what the extension did with it.
const fakeLogin = () => {
	const login = { started: 0, env: undefined as any, codes: [] as string[], cancelled: false, settle: (_: any) => {}, opts: undefined as any };
	(globalThis as any).setupToken = (opts: any) => {
		login.started++;
		login.env = opts.env;
		login.opts = opts;
		const done = new Promise((resolve) => (login.settle = resolve));
		return { done, sendCode: (c: string) => login.codes.push(c), cancel: () => ((login.cancelled = true), login.settle({ error: "cancelled" })) };
	};
	return login;
};
const prompts: { title: string; signal?: AbortSignal }[] = [];
/** A UI whose dialog answers `answer(title)`; the sign-in dialog waits until aborted or answered. */
const withUI = (answer: (title: string, signal?: AbortSignal) => Promise<string | undefined>) => ({
	...ctx,
	hasUI: true,
	ui: { ...ctx.ui, input: (title: string, _p: string, o?: { signal?: AbortSignal }) => (prompts.push({ title, signal: o?.signal }), answer(title, o?.signal)) },
});
const untilAborted = (signal?: AbortSignal) => new Promise<undefined>((r) => signal!.addEventListener("abort", () => r(undefined)));
const SIGN_IN = /^Authorize "w" in the browser that opened/;

test("add signs in through the browser and stores the token it gives, with no paste", async () => {
	prompts.length = 0;
	writeAccounts("a", { a: 0.1, b: 0.1 });
	process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok-a";
	const login = fakeLogin();
	const done = command("add w", withUI((title, signal) => (SIGN_IN.test(title) ? untilAborted(signal) : Promise.resolve("pasted"))));
	await new Promise((r) => setImmediate(r));
	login.opts.onUrl("https://claude.ai/oauth/authorize?x");
	login.settle({ token: "sk-ant-oat01-new" });
	await done;
	assert.equal(login.started, 1);
	assert.equal(login.env.CLAUDE_CODE_OAUTH_TOKEN, undefined); // the login does not reuse the exported token
	assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, "tok-a");
	assert.deepEqual(readStore().accounts.at(-1), { name: "w", token: "sk-ant-oat01-new" });
	assert.equal(prompts.length, 1);
	assert.ok(prompts[0].signal!.aborted); // the dialog closes by itself once the token came
	assert.deepEqual(notices, [
		{ text: "Browser did not open? Sign in at https://claude.ai/oauth/authorize?x", level: "info" },
		{ text: 'Account "w" added.', level: "info" },
	]);
});

test("a code typed in the sign-in dialog goes to claude setup-token", async () => {
	prompts.length = 0;
	const login = fakeLogin();
	const answers = ["abc#123"];
	const done = command("add w", withUI((_t, signal) => (answers.length ? Promise.resolve(answers.shift()) : untilAborted(signal))));
	await new Promise((r) => setImmediate(r));
	login.settle({ token: "sk-ant-oat01-new" });
	await done;
	assert.deepEqual(login.codes, ["abc#123"]);
	assert.equal(readStore().accounts.at(-1).token, "sk-ant-oat01-new");
	// The dialog stays open after the code, saying it was sent.
	assert.match(prompts[1].title, /^Code sent; waiting for "w" to be authorized/);
});

test("an empty Enter in the sign-in dialog keeps waiting, and Esc after a code still cancels", async () => {
	prompts.length = 0;
	const login = fakeLogin();
	const answers: (string | undefined)[] = ["", "  ", "abc", undefined];
	await command("add w", withUI(async () => answers.shift()));
	assert.equal(prompts.length, 4);
	assert.deepEqual(login.codes, ["abc"]);
	assert.ok(login.cancelled);
	assert.deepEqual(notices, [{ text: "Cancelled; nothing added.", level: "info" }]);
});

test("Esc in the sign-in dialog stops the sign-in and adds nothing", async () => {
	const login = fakeLogin();
	await command("add w", withUI(async () => undefined));
	assert.ok(login.cancelled);
	assert.ok(!existsSync(storeFile()) || !readStore().accounts.some((a: any) => a.name === "w"));
	assert.deepEqual(notices, [{ text: "Cancelled; nothing added.", level: "info" }]);
});

test("when the sign-in gives no token, the token can still be pasted", async () => {
	prompts.length = 0;
	const login = fakeLogin();
	const done = command("add w", withUI((title, signal) => (SIGN_IN.test(title) ? untilAborted(signal) : Promise.resolve(" sk-ant-oat01-pasted "))));
	await new Promise((r) => setImmediate(r));
	login.settle({ error: "claude setup-token ended (exit 127): claude: not found" });
	await done;
	assert.equal(readStore().accounts.at(-1).token, "sk-ant-oat01-pasted");
	assert.match(prompts[1].title, /^Token for "w"/);
	assert.deepEqual(notices, [
		{ text: "No token from `claude setup-token` (claude setup-token ended (exit 127): claude: not found); paste one instead.", level: "warning" },
		{ text: 'Account "w" added.', level: "info" },
	]);
});

test("add with a token, without a UI or with a taken name never opens the browser", async () => {
	const login = fakeLogin();
	writeAccounts("a", { a: 0.1, b: 0.1 });
	await command("add w sk-ant-oat01-given", withUI(async () => "x"));
	assert.equal(readStore().accounts.at(-1).token, "sk-ant-oat01-given");
	await command("add v", { ...ctx, ui: { ...ctx.ui, input: async () => undefined } });
	assert.ok(!readStore().accounts.some((a: any) => a.name === "v"));
	await command("add b", withUI(async () => "x"));
	assert.equal(login.started, 0);
	assert.deepEqual(notices, [
		{ text: 'Account "w" added.', level: "info" },
		{ text: "No token given; nothing added.", level: "info" },
		{ text: 'account "b" already exists', level: "error" },
	]);
});

test("a token pasted into the sign-in dialog is stored as is, and the sign-in stops", async () => {
	const login = fakeLogin();
	await command("add w", withUI(async () => " sk-ant-oat01-had-it "));
	assert.ok(login.cancelled);
	assert.deepEqual(login.codes, []);
	assert.equal(readStore().accounts.at(-1).token, "sk-ant-oat01-had-it");
});

test("a sign-in dialog that rejects when the token comes still stores the token", async () => {
	const login = fakeLogin();
	const rejecting = (_t: string, signal?: AbortSignal) => new Promise<undefined>((_, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted"))));
	const done = command("add w", withUI(rejecting));
	await new Promise((r) => setImmediate(r));
	login.settle({ token: "sk-ant-oat01-new" });
	await done;
	assert.equal(readStore().accounts.at(-1).token, "sk-ant-oat01-new");
});
