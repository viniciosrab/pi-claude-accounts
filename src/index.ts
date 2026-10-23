// Multiple Claude Code accounts for claude-bridge. The bridge spawns a Claude Code CLI per run (kept for
// its tool calls) and passes it process.env, so CLAUDE_CODE_OAUTH_TOKEN selects the account of each new CLI.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { completeArgs } from "./completions.ts";
import { formatReset } from "./format.ts";
import { parseFiveHour } from "./headers.ts";
import { exhaustedUsage, isLimitFailure, retryNotice } from "./limit.ts";
import { effectiveUtilization, pickAccount, pickSessionAccount, THRESHOLD, type Usage } from "./policy.ts";
import { isAuthFailure, PREFETCH_AT, probeAccount, staleAccounts } from "./probe.ts";
import { addAccount, isLoginAccount, loadStore, removeAccount, renameAccount, updateStore, type Store } from "./store.ts";

const ENV = "CLAUDE_CODE_OAUTH_TOKEN";
// What the user exported before any Pi set ENV. Subagent processes inherit the parent's ENV, which is
// then an account's token, so the first Pi records the original here for the processes it starts.
const EXTERNAL = "PI_CLAUDE_ACCOUNTS_EXTERNAL_TOKEN";
const PROVIDER = "claude-bridge";
const USAGE = "Usage: /claude-accounts add <name> [token] | list | refresh | use <name> | rename <name> <new-name> | remove <name> | status";

const storePath = () => join(getAgentDir(), "claude-accounts.json");
const pct = (n: number) => `${Math.round(n * 100)}%`;
const now = () => Math.floor(Date.now() / 1000);
/** Pi's auto-retry settings (global settings.json; defaults: on, 3 attempts). */
const retrySettings = () => {
	let retry: { enabled?: boolean; maxRetries?: number } | undefined;
	try {
		retry = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf-8")).retry;
	} catch {}
	return { enabled: retry?.enabled ?? true, maxRetries: retry?.maxRetries ?? 3 };
};

export default function (pi: ExtensionAPI) {
	if (process.env[EXTERNAL] === undefined) process.env[EXTERNAL] = process.env[ENV] ?? "";
	const externalToken = process.env[EXTERNAL] || undefined; // what the login account means when the user exported a token
	// No in-memory copy: other Pi instances write the same file, so every read and write goes to disk.
	const load = (): Store => loadStore(storePath());
	const update = (change: (s: Store) => Store): Store => updateStore(storePath(), change);
	// The account this process exports, so every Claude Code CLI it starts from here on (the next run, a
	// retry) runs on it. A subagent Pi starts on the shared active account instead: a new conversation has
	// no cache to keep. Each Pi session keeps its own: the prompt cache is per account, so
	// following another instance's switch would re-cache this session's whole conversation.
	let envAccount: string | undefined;
	const apply = (name: string) => {
		const token = load().accounts.find((a) => a.name === name)?.token ?? externalToken;
		if (token) process.env[ENV] = token;
		else delete process.env[ENV];
		envAccount = name;
	};
	const applyActive = () => apply(load().active);
	const age = (u: Usage) => (u.checkedAt === undefined ? "" : ` (checked ${Math.max(0, Math.round((now() - u.checkedAt) / 60))}m ago)`);
	const REJECTED = "token rejected, re-add it";
	const describe = (s: Store) =>
		s.accounts
			.map((a) => {
				const reset = a.usage ? formatReset(a.usage.resetsAt, now()) : "";
				const usage = a.usage ? pct(effectiveUtilization(a, now())) + (reset ? `, ${reset}` : "") + age(a.usage) : "n/a";
				return `${a.name === s.active ? "*" : " "} ${a.name}  5h: ${usage}${a.authFailed ? `  [${REJECTED}]` : ""}`;
			})
			.join("\n");

	// Always merges into the latest store: probes finish in the background, after other writes.
	const patchAccount = (name: string, patch: { usage?: Usage; authFailed?: boolean }) => {
		update((s) => ({
			...s,
			accounts: s.accounts.map((a) => {
				if (a.name !== name) return a;
				const { authFailed: _, ...rest } = { ...a, ...patch };
				return (patch.authFailed ?? a.authFailed) ? { ...rest, authFailed: true } : rest;
			}),
		}));
	};
	// Fresh usage proves the token works.
	const setUsage = (name: string, usage: Usage) => patchAccount(name, { usage, authFailed: false });

	let probing: Promise<number> | undefined;
	/** Probes the given accounts concurrently and records what they report; returns how many answered. */
	const refreshUsage = (names: string[]): Promise<number> =>
		(probing ??= Promise.all(
			names.map(async (name) => {
				const account = load().accounts.find((a) => a.name === name);
				if (!account) return 0;
				const result = await probeAccount(account.token ?? externalToken);
				if (result.authFailed) patchAccount(name, { authFailed: true });
				if (!result.usage) return 0;
				setUsage(name, { ...result.usage, checkedAt: now() });
				return 1;
			}),
		)
			.then((r) => r.reduce<number>((n, x) => n + x, 0))
			.finally(() => (probing = undefined)));

	const safe = (ctx: ExtensionContext, fn: () => void) => {
		try {
			fn();
		} catch (e) {
			ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
		}
	};

	// The account the running Claude Code process was started with. The bridge keeps one process for a
	// whole run (tool calls included), so after a switch its usage still belongs to the old account.
	let runAccount: string | undefined;
	// Failed responses since the last good one; Pi's retry budget counts the same way.
	let failedResponses = 0;
	const switchNotice = (s: Store, from: string, to: string) => {
		const usage = (n: string) => {
			const a = s.accounts.find((x) => x.name === n);
			return a ? ` (${pct(effectiveUtilization(a, now()))})` : "";
		};
		return `Claude account switched: ${from}${usage(from)} → ${to}${usage(to)}`;
	};

	pi.on("session_start", (_event, ctx) =>
		safe(ctx, () => {
			applyActive();
			runAccount = load().active;
		}),
	);

	pi.on("after_provider_response", (event, ctx) => {
		if (ctx?.model && ctx.model.provider !== PROVIDER) return;
		const usage = parseFiveHour(event.headers);
		if (!usage) return;
		safe(ctx, () => {
			const account = runAccount ?? load().active;
			setUsage(account, { ...usage, checkedAt: now() });
			const s = load();
			// Switch now rather than at the next prompt: subagents and any process started from here on
			// get the new account. This run's process keeps its token; at the limit message_end moves it.
			if (account === (envAccount ?? s.active)) {
				const pick = pickSessionAccount(s.accounts, account, s.active, now());
				if (pick.switched) {
					if (pick.name !== s.active) update((latest) => ({ ...latest, active: pick.name }));
					apply(pick.name);
					ctx.ui.notify(switchNotice(s, account, pick.name), "warning");
				}
			}
			// Learn where to go before the switch is due, so it never lands on an exhausted account.
			if (usage.utilization < PREFETCH_AT || probing) return;
			const stale = staleAccounts(load().accounts, load().active, now()).map((a) => a.name);
			if (stale.length) void refreshUsage(stale).catch(() => {});
		});
	});

	// A limit or a refused token fails the run, a subagent's included. Switch accounts and reword the
	// failure so Pi's auto-retry continues the work on the new account instead of stopping.
	pi.on("message_end", (event, ctx) => {
		const msg = event.message as { role?: string; provider?: string; stopReason?: string; errorMessage?: string };
		if (msg.role !== "assistant" || msg.provider !== PROVIDER) return;
		if (msg.stopReason !== "error") {
			failedResponses = 0;
			return;
		}
		failedResponses++;
		const authFailed = isAuthFailure(msg.errorMessage);
		if (!authFailed && !isLimitFailure(msg.errorMessage)) {
			// A retry of any other error starts a new CLI, which takes this process's account.
			try {
				runAccount = envAccount ?? load().active;
			} catch {}
			return;
		}
		try {
			const failed = runAccount ?? load().active;
			if (authFailed) patchAccount(failed, { authFailed: true });
			else patchAccount(failed, { usage: exhaustedUsage(load().accounts.find((a) => a.name === failed)?.usage, now()) });
			const s = load();
			// Another process may already have moved on; then the active account is the way out.
			const to = pickAccount(s.accounts, s.active, now()).name;
			const target = s.accounts.find((a) => a.name === to);
			const usable = target && to !== failed && !target.authFailed && effectiveUtilization(target, now()) < THRESHOLD;
			const why = authFailed ? REJECTED : "limit reached";
			if (!usable) {
				ctx.ui.notify(`Claude account "${failed}": ${why}. No other account is available.`, "error");
				return;
			}
			// Already switched at 95% (this process or another): only this run still had to move.
			const alreadyActive = to === s.active && s.active !== failed;
			if (!alreadyActive) update((latest) => ({ ...latest, active: to }));
			apply(to);
			runAccount = to;
			const retry = retrySettings();
			const retries = retry.enabled && failedResponses <= retry.maxRetries;
			const head = alreadyActive ? `Claude account "${failed}": ${why}` : `${switchNotice(s, failed, to)} — "${failed}": ${why}`;
			ctx.ui.notify(retries ? `${head}; continuing on "${to}".` : `${head}. Pi will not retry; send your message again.`, "warning");
			if (!retries) return;
			return { message: { ...event.message, errorMessage: retryNotice(failed, to, why) } as typeof event.message };
		} catch (e) {
			ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
		}
	});

	// Each run starts its Claude Code process with the account chosen here: this session's own, unless
	// it is used up. Another instance moving the shared default does not move this session.
	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx.model && ctx.model.provider !== PROVIDER) return;
		safe(ctx, () => {
			const s = load();
			const own = envAccount ?? s.active;
			const pick = pickSessionAccount(s.accounts, own, s.active, now());
			runAccount = pick.name;
			failedResponses = 0;
			if (!pick.switched) return apply(pick.name);
			if (pick.name !== s.active) update((latest) => ({ ...latest, active: pick.name }));
			apply(pick.name);
			ctx.ui.notify(switchNotice(s, own, pick.name), "warning");
		});
	});

	const addFlow = async (ctx: ExtensionContext, name?: string, token?: string) => {
		const n = (name ?? (await ctx.ui.input("Account name", "e.g. work")))?.trim();
		if (!n) return ctx.ui.notify("No name given; nothing added.", "info");
		const t = (token ?? (await ctx.ui.input(`Token for "${n}" (run \`claude setup-token\` logged in to that account)`, "sk-ant-oat01-...")))?.trim();
		if (!t) return ctx.ui.notify("No token given; nothing added.", "info");
		update((s) => addAccount(s, n, t));
		ctx.ui.notify(`Account "${n}" added.`, "info");
	};
	const useFlow = async (ctx: ExtensionContext, name?: string) => {
		const s = load();
		const n = name ?? (await pickName(ctx, "Switch to account", s.accounts.map((a) => a.name)));
		if (!n) return;
		if (!s.accounts.some((a) => a.name === n)) return ctx.ui.notify(`Unknown account "${n}".`, "error");
		// Choosing an account by hand is a request to retry it, so forget an earlier rejection.
		patchAccount(n, { authFailed: false });
		update((latest) => ({ ...latest, active: n }));
		applyActive();
		ctx.ui.notify(`Active account: ${n}`, "info");
	};
	const removeFlow = async (ctx: ExtensionContext, name?: string) => {
		const s = load();
		const removable = s.accounts.filter((a) => !isLoginAccount(a)).map((a) => a.name);
		if (!name && removable.length === 0) return ctx.ui.notify("No accounts to remove besides the Claude Code login.", "info");
		const n = name ?? (await pickName(ctx, "Remove account", removable));
		if (!n) return;
		if (!name && !(await ctx.ui.confirm("Remove account?", `"${n}" and its token will be deleted.`))) return;
		update((latest) => removeAccount(latest, n));
		// Only a session running on the removed account moves; the others keep theirs.
		if (envAccount === undefined || !load().accounts.some((a) => a.name === envAccount)) applyActive();
		else apply(envAccount);
		ctx.ui.notify(`Account "${n}" removed.`, "info");
	};
	// Menu labels carry the usage so the choice is informed; map back to the bare name.
	const pickName = async (ctx: ExtensionContext, title: string, names: string[]) => {
		const s = load();
		const label = (n: string) => {
			const a = s.accounts.find((x) => x.name === n)!;
			return `${n === s.active ? "* " : "  "}${n}  (5h: ${a.usage ? pct(effectiveUtilization(a, now())) : "n/a"})${a.authFailed ? `  [${REJECTED}]` : ""}`;
		};
		const choice = await ctx.ui.select(title, names.map(label));
		return choice === undefined ? undefined : names[names.map(label).indexOf(choice)];
	};

	const refreshFlow = async (ctx: ExtensionContext) => {
		const names = load().accounts.map((a) => a.name);
		ctx.ui.notify(`Checking 5h usage of ${names.length} accounts (about 10s; uses a tiny bit of each limit)...`, "info");
		const answered = await refreshUsage(names);
		const failed = answered < names.length ? `\n${names.length - answered} account(s) did not answer; check their tokens.` : "";
		ctx.ui.notify(describe(load()) + failed, failed ? "warning" : "info");
	};

	const renameFlow = async (ctx: ExtensionContext, name?: string, newName?: string) => {
		const n = name ?? (await pickName(ctx, "Rename account", load().accounts.map((a) => a.name)));
		if (!n) return;
		const to = (newName ?? (await ctx.ui.input(`New name for "${n}"`, n)))?.trim();
		if (!to) return ctx.ui.notify("No name given; nothing renamed.", "info");
		update((latest) => renameAccount(latest, n, to));
		if (runAccount === n) runAccount = to;
		if (envAccount === n) envAccount = to;
		ctx.ui.notify(`Account "${n}" renamed to "${to}".`, "info");
	};

	const MENU = ["List accounts", "Refresh usage", "Add account", "Switch account", "Rename account", "Remove account"] as const;

	pi.registerCommand("claude-accounts", {
		description: "Manage Claude Code accounts (auto-switch at 95% of the 5h limit)",
		getArgumentCompletions: (prefix: string) => {
			const accounts = load().accounts;
			return completeArgs(prefix, accounts.map((a) => a.name), accounts.filter((a) => !isLoginAccount(a)).map((a) => a.name));
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			const [cmd, name, token] = args.trim().split(/\s+/).filter(Boolean);
			try {
				const action = cmd ?? (await ctx.ui.select("Claude accounts", [...MENU]));
				switch (action) {
					case "add":
					case "Add account":
						return await addFlow(ctx, name, token);
					case "use":
					case "Switch account":
						return await useFlow(ctx, name);
					case "rename":
					case "Rename account":
						return await renameFlow(ctx, name, token);
					case "remove":
					case "Remove account":
						return await removeFlow(ctx, name);
					case "refresh":
					case "Refresh usage":
						return await refreshFlow(ctx);
					case "list":
					case "status":
					case "List accounts":
						return ctx.ui.notify(describe(load()), "info");
					case undefined:
						return;
					default:
						return ctx.ui.notify(USAGE, "info");
				}
			} catch (e) {
				ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
			}
		},
	});
}
