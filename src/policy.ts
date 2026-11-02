// Pure account-selection policy. No I/O so it can be tested without Pi.

export const THRESHOLD = 0.95;

/** `checkedAt` (Unix seconds) is when the numbers were observed; absent on data saved by older versions. */
export type Usage = { utilization: number; resetsAt?: number; checkedAt?: number };
/** `authFailed`: Claude Code rejected the token; cleared by the next successful response or check. */
export type Account = { name: string; usage?: Usage; authFailed?: boolean };
export type Pick = { name: string; switched: boolean };

/** Utilization of the 5h window; a window that already reset counts as empty. */
export function effectiveUtilization(account: Account, now: number): number {
	const u = account.usage;
	if (!u) return 0;
	if (u.resetsAt !== undefined && u.resetsAt <= now) return 0;
	return u.utilization;
}

const usable = (a: Account) => !a.authFailed;

/** A random account with room, favoring the emptier ones. Sessions that move at the same moment scatter
 *  instead of queuing on one account, so fewer of them have to move again when it fills up. */
function spreadAccount(accounts: Account[], skip: string | undefined, now: number, threshold: number, random: () => number): Account | undefined {
	const room = (a: Account) => threshold - effectiveUtilization(a, now);
	const open = accounts.filter((a) => a.name !== skip && usable(a) && room(a) > 0);
	let left = random() * open.reduce((total, a) => total + room(a), 0);
	return open.find((a) => (left -= room(a)) < 0) ?? open.at(-1);
}

/** `now` and `resetsAt` are Unix seconds. Switches only when the active account is at/over the threshold. */
export function pickAccount(accounts: Account[], activeName: string, now: number, threshold = THRESHOLD, random = Math.random): Pick {
	const active = accounts.find((a) => a.name === activeName) ?? accounts[0];
	if (!active) return { name: activeName, switched: false };
	if (usable(active) && effectiveUtilization(active, now) < threshold) return { name: active.name, switched: active.name !== activeName };

	const next = spreadAccount(accounts, active.name, now, threshold, random);
	if (next) return { name: next.name, switched: true };

	// Everyone usable is exhausted: wait on whichever resets first.
	const resetOf = (a: Account) => a.usage?.resetsAt ?? Number.POSITIVE_INFINITY;
	const soonest = accounts.filter(usable).reduce((best, a) => (resetOf(a) < resetOf(best) ? a : best), active);
	return { name: soonest.name, switched: soonest.name !== activeName };
}

/** One Pi session's account: it stays on `own` while that is usable and under the threshold, since the
 *  prompt cache is per account and every move re-caches the whole conversation. Once `own` is used up it
 *  moves to another account with room, not to the shared default (`active`), which would send every
 *  session on `own` to the same place. An `own` that no longer exists falls back to `active`. */
export function pickSessionAccount(accounts: Account[], own: string, active: string, now: number, threshold = THRESHOLD, random = Math.random): Pick {
	const from = accounts.some((a) => a.name === own) ? own : active;
	const { name } = pickAccount(accounts, from, now, threshold, random);
	return { name, switched: name !== own };
}

/** Where a conversation with nothing cached yet starts: any account with room, so sessions do not pile up
 *  on the active one. With no room left it behaves like a switch from `active`. */
export function pickNewSessionAccount(accounts: Account[], active: string, now: number, threshold = THRESHOLD, random = Math.random): string {
	return spreadAccount(accounts, undefined, now, threshold, random)?.name ?? pickAccount(accounts, active, now, threshold, random).name;
}
