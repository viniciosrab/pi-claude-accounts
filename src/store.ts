// Account persistence. Tokens live in a 0600 file; a corrupt file is never overwritten.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Usage } from "./policy.ts";

/** The login already stored by Claude Code in ~/.claude/.credentials.json; it carries no token here. */
export const DEFAULT_ACCOUNT = "default";

export type StoredAccount = { name: string; token?: string; usage?: Usage };
export type Store = { active: string; accounts: StoredAccount[] };

/** Terminals wrap the long `claude setup-token` output, so a paste can carry spaces or newlines. */
const cleanToken = (token: string) => token.replace(/\s+/g, "");

const fresh = (): Store => ({ active: DEFAULT_ACCOUNT, accounts: [{ name: DEFAULT_ACCOUNT }] });

export function loadStore(path: string): Store {
	if (!existsSync(path)) return fresh();
	let parsed: Partial<Store>;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		throw new Error(`claude-accounts: ${path} does not parse (${e}); fix or delete it`);
	}
	const accounts = (Array.isArray(parsed.accounts) ? parsed.accounts : []).map((a) =>
		a.token === undefined ? a : { ...a, token: cleanToken(a.token) },
	);
	if (!accounts.some((a) => a.name === DEFAULT_ACCOUNT)) accounts.unshift({ name: DEFAULT_ACCOUNT });
	const active = accounts.some((a) => a.name === parsed.active) ? parsed.active! : DEFAULT_ACCOUNT;
	return { active, accounts };
}

export function saveStore(path: string, store: Store): void {
	mkdirSync(dirname(path), { recursive: true });
	// Write-then-rename so a concurrent reader (another Pi instance) never sees a half-written file.
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
	chmodSync(tmp, 0o600); // writeFileSync's mode is ignored when the file already exists
	renameSync(tmp, path);
}

/** Read-modify-write against the file, never an in-memory copy: several Pi instances share it. */
export function updateStore(path: string, change: (store: Store) => Store): Store {
	const next = change(loadStore(path));
	saveStore(path, next);
	return next;
}

export function addAccount(store: Store, name: string, token: string): Store {
	if (store.accounts.some((a) => a.name === name)) throw new Error(`account "${name}" already exists`);
	return { ...store, accounts: [...store.accounts, { name, token: cleanToken(token) }] };
}

export function removeAccount(store: Store, name: string): Store {
	if (name === DEFAULT_ACCOUNT) throw new Error("the default account cannot be removed");
	if (!store.accounts.some((a) => a.name === name)) throw new Error(`account "${name}" not found`);
	const accounts = store.accounts.filter((a) => a.name !== name);
	return { accounts, active: store.active === name ? DEFAULT_ACCOUNT : store.active };
}
