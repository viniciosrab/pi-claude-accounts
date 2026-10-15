// Footer text for the active account. Pure so it can be tested without Pi.

import type { Store } from "./store.ts";

export function formatStatus(store: Store): string {
	return store.active;
}
