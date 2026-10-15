// Pure account-selection policy. No I/O so it can be tested without Pi.

export const THRESHOLD = 0.95;

/** `checkedAt` (Unix seconds) is when the numbers were observed; absent on data saved by older versions. */
export type Usage = { utilization: number; resetsAt?: number; checkedAt?: number };
export type Account = { name: string; usage?: Usage };
export type Pick = { name: string; switched: boolean };

/** Utilization of the 5h window; a window that already reset counts as empty. */
export function effectiveUtilization(account: Account, now: number): number {
	const u = account.usage;
	if (!u) return 0;
	if (u.resetsAt !== undefined && u.resetsAt <= now) return 0;
	return u.utilization;
}

/** `now` and `resetsAt` are Unix seconds. Switches only when the active account is at/over the threshold. */
export function pickAccount(accounts: Account[], activeName: string, now: number, threshold = THRESHOLD): Pick {
	const active = accounts.find((a) => a.name === activeName) ?? accounts[0];
	if (!active) return { name: activeName, switched: false };
	if (effectiveUtilization(active, now) < threshold) return { name: active.name, switched: active.name !== activeName };

	const next = accounts.find((a) => a.name !== active.name && effectiveUtilization(a, now) < threshold);
	if (next) return { name: next.name, switched: true };

	// Everyone is exhausted: wait on whichever resets first.
	const resetOf = (a: Account) => a.usage?.resetsAt ?? Number.POSITIVE_INFINITY;
	const soonest = accounts.reduce((best, a) => (resetOf(a) < resetOf(best) ? a : best), active);
	return { name: soonest.name, switched: soonest.name !== activeName };
}
