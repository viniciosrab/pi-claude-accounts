// Argument completions for /claude-accounts. Pure so it can be tested without Pi.

import { DEFAULT_ACCOUNT } from "./store.ts";

export type Completion = { value: string; label: string; description?: string };

export const SUBCOMMANDS: ReadonlyArray<{ name: string; description: string }> = [
	{ name: "list", description: "Show accounts and 5h usage" },
	{ name: "refresh", description: "Check the 5h usage of every account now" },
	{ name: "add", description: "Register a new account" },
	{ name: "use", description: "Switch to an account now" },
	{ name: "rename", description: "Rename an account" },
	{ name: "remove", description: "Delete an account" },
	{ name: "status", description: "Same as list" },
];

/** `removable` defaults to every name except the initial login name. */
export function completeArgs(prefix: string, accountNames: string[], removable?: string[]): Completion[] | null {
	const space = prefix.indexOf(" ");
	if (space === -1) {
		const hits = SUBCOMMANDS.filter((s) => s.name.startsWith(prefix));
		return hits.length ? hits.map((s) => ({ value: s.name, label: s.name, description: s.description })) : null;
	}
	const cmd = prefix.slice(0, space);
	const partial = prefix.slice(space + 1).trimStart();
	if (cmd !== "use" && cmd !== "remove" && cmd !== "rename") return null;
	if (cmd === "rename" && partial.includes(" ")) return null; // the new name is free text
	const pool = cmd === "remove" ? (removable ?? accountNames.filter((n) => n !== DEFAULT_ACCOUNT)) : accountNames;
	const hits = pool.filter((n) => n.startsWith(partial));
	return hits.length ? hits.map((n) => ({ value: `${cmd} ${n}`, label: n })) : null;
}
