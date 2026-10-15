// Display helpers. Pure so they can be tested without Pi.

/** Time left until the 5h window resets (Unix seconds); empty when unknown or already reset. */
export function formatReset(resetsAt: number | undefined, now: number): string {
	if (resetsAt === undefined || resetsAt <= now) return "";
	const minutes = Math.floor((resetsAt - now) / 60);
	if (minutes < 1) return "resets in <1m";
	const h = Math.floor(minutes / 60);
	return h > 0 ? `resets in ${h}h ${minutes % 60}m` : `resets in ${minutes}m`;
}
