// Multiple Claude Code accounts for claude-bridge. The bridge spawns a fresh Claude Code CLI per
// prompt and passes it process.env, so setting CLAUDE_CODE_OAUTH_TOKEN before a prompt selects the account.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { completeArgs } from "./completions.ts";
import { parseFiveHour } from "./headers.ts";
import { effectiveUtilization, pickAccount } from "./policy.ts";
import { addAccount, DEFAULT_ACCOUNT, loadStore, removeAccount, saveStore, type Store } from "./store.ts";

const ENV = "CLAUDE_CODE_OAUTH_TOKEN";
const PROVIDER = "claude-bridge";
const USAGE = "Usage: /claude-accounts add <name> [token] | list | use <name> | remove <name> | status";

const storePath = () => join(getAgentDir(), "claude-accounts.json");
const pct = (n: number) => `${Math.round(n * 100)}%`;
const now = () => Math.floor(Date.now() / 1000);

export default function (pi: ExtensionAPI) {
	const externalToken = process.env[ENV]; // what "default" means when the user exported one themselves
	let store: Store | undefined;

	const load = (): Store => (store ??= loadStore(storePath()));
	const persist = (next: Store) => {
		store = next;
		saveStore(storePath(), next);
	};
	const applyActive = () => {
		const s = load();
		const token = s.accounts.find((a) => a.name === s.active)?.token ?? externalToken;
		if (token) process.env[ENV] = token;
		else delete process.env[ENV];
	};
	const describe = (s: Store) =>
		s.accounts
			.map((a) => `${a.name === s.active ? "*" : " "} ${a.name}  5h: ${a.usage ? pct(effectiveUtilization(a, now())) : "n/a"}`)
			.join("\n");

	const safe = (ctx: ExtensionContext, fn: () => void) => {
		try {
			fn();
		} catch (e) {
			ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
		}
	};

	pi.on("session_start", (_event, ctx) => safe(ctx, applyActive));

	pi.on("after_provider_response", (event, ctx) => {
		if (ctx?.model && ctx.model.provider !== PROVIDER) return;
		const usage = parseFiveHour(event.headers);
		if (!usage) return;
		safe(ctx, () => {
			const s = load();
			persist({ ...s, accounts: s.accounts.map((a) => (a.name === s.active ? { ...a, usage } : a)) });
		});
	});

	// Switch only between prompts, never mid-response: the CLI of a running prompt keeps its account.
	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx.model && ctx.model.provider !== PROVIDER) return;
		safe(ctx, () => {
			const s = load();
			const pick = pickAccount(s.accounts, s.active, now());
			if (!pick.switched) return applyActive();
			const from = s.accounts.find((a) => a.name === s.active)!;
			const to = s.accounts.find((a) => a.name === pick.name)!;
			persist({ ...s, active: pick.name });
			applyActive();
			ctx.ui.notify(
				`Claude account switched: ${from.name} (${pct(effectiveUtilization(from, now()))}) → ${to.name} (${pct(effectiveUtilization(to, now()))})`,
				"warning",
			);
		});
	});

	const addFlow = async (ctx: ExtensionContext, name?: string, token?: string) => {
		const n = (name ?? (await ctx.ui.input("Account name", "e.g. work")))?.trim();
		if (!n) return ctx.ui.notify("No name given; nothing added.", "info");
		const t = (token ?? (await ctx.ui.input(`Token for "${n}" (run \`claude setup-token\` logged in to that account)`, "sk-ant-oat01-...")))?.trim();
		if (!t) return ctx.ui.notify("No token given; nothing added.", "info");
		persist(addAccount(load(), n, t));
		ctx.ui.notify(`Account "${n}" added.`, "info");
	};
	const useFlow = async (ctx: ExtensionContext, name?: string) => {
		const s = load();
		const n = name ?? (await pickName(ctx, "Switch to account", s.accounts.map((a) => a.name)));
		if (!n) return;
		if (!s.accounts.some((a) => a.name === n)) return ctx.ui.notify(`Unknown account "${n}".`, "error");
		persist({ ...s, active: n });
		applyActive();
		ctx.ui.notify(`Active account: ${n}`, "info");
	};
	const removeFlow = async (ctx: ExtensionContext, name?: string) => {
		const s = load();
		const removable = s.accounts.map((a) => a.name).filter((n) => n !== DEFAULT_ACCOUNT);
		if (!name && removable.length === 0) return ctx.ui.notify("No accounts to remove besides default.", "info");
		const n = name ?? (await pickName(ctx, "Remove account", removable));
		if (!n) return;
		if (!name && !(await ctx.ui.confirm("Remove account?", `"${n}" and its token will be deleted.`))) return;
		persist(removeAccount(s, n));
		applyActive();
		ctx.ui.notify(`Account "${n}" removed.`, "info");
	};
	// Menu labels carry the usage so the choice is informed; map back to the bare name.
	const pickName = async (ctx: ExtensionContext, title: string, names: string[]) => {
		const s = load();
		const label = (n: string) => {
			const a = s.accounts.find((x) => x.name === n)!;
			return `${n === s.active ? "* " : "  "}${n}  (5h: ${a.usage ? pct(effectiveUtilization(a, now())) : "n/a"})`;
		};
		const choice = await ctx.ui.select(title, names.map(label));
		return choice === undefined ? undefined : names[names.map(label).indexOf(choice)];
	};

	const MENU = ["List accounts", "Add account", "Switch account", "Remove account"] as const;

	pi.registerCommand("claude-accounts", {
		description: "Manage Claude Code accounts (auto-switch at 95% of the 5h limit)",
		getArgumentCompletions: (prefix: string) => completeArgs(prefix, load().accounts.map((a) => a.name)),
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
					case "remove":
					case "Remove account":
						return await removeFlow(ctx, name);
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
