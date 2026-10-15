// Multiple Claude Code accounts for claude-bridge. The bridge spawns a fresh Claude Code CLI per
// prompt and passes it process.env, so setting CLAUDE_CODE_OAUTH_TOKEN before a prompt selects the account.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
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

	pi.registerCommand("claude-accounts", {
		description: "Manage Claude Code accounts (auto-switch at 95% of the 5h limit)",
		handler: async (args: string, ctx: ExtensionContext) => {
			const [cmd, name, token] = args.trim().split(/\s+/);
			try {
				const s = load();
				switch (cmd) {
					case "add": {
						if (!name) return ctx.ui.notify(USAGE, "info");
						const t = token ?? (await ctx.ui.input("Token from `claude setup-token`", "sk-ant-oat01-..."));
						if (!t?.trim()) return ctx.ui.notify("No token given; nothing added.", "info");
						persist(addAccount(s, name, t.trim()));
						return ctx.ui.notify(`Account "${name}" added.`, "info");
					}
					case "remove":
						if (!name) return ctx.ui.notify(USAGE, "info");
						persist(removeAccount(s, name));
						applyActive();
						return ctx.ui.notify(`Account "${name}" removed.`, "info");
					case "use":
						if (!name || !s.accounts.some((a) => a.name === name)) return ctx.ui.notify(`Unknown account. ${USAGE}`, "error");
						persist({ ...s, active: name });
						applyActive();
						return ctx.ui.notify(`Active account: ${name}`, "info");
					case "list":
					case "status":
						return ctx.ui.notify(describe(s), "info");
					default:
						return ctx.ui.notify(USAGE, "info");
				}
			} catch (e) {
				ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
			}
		},
	});
}
