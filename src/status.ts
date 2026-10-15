// Footer text for the active account. Pure so it can be tested without Pi.

import { effectiveUtilization } from "./policy.ts";
import type { Store } from "./store.ts";

export function formatStatus(store: Store, now: number): string {
	const active = store.accounts.find((a) => a.name === store.active);
	const usage = active?.usage ? `${Math.round(effectiveUtilization(active, now) * 100)}%` : "n/a";
	return `Claude: ${store.active} · 5h ${usage}`;
}
