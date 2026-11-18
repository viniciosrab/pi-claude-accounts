// claude-bridge rebuilds Claude Code's rate_limit_event as these headers (see its src/rate-limit.ts).

import type { Usage, Window } from "./policy.ts";

const PREFIX = "anthropic-ratelimit-unified-";

function parseWindow(lower: Record<string, string>, window: string): Window | undefined {
	const utilization = Number(lower[`${PREFIX}${window}-utilization`]);
	if (lower[`${PREFIX}${window}-utilization`] === undefined || !Number.isFinite(utilization)) return undefined;
	const reset = Number(lower[`${PREFIX}${window}-reset`]);
	return { utilization, resetsAt: lower[`${PREFIX}${window}-reset`] !== undefined && Number.isFinite(reset) ? reset : undefined };
}

/** The five-hour window, which drives switching, plus the 7d one as `week` for display; nothing without
 *  five-hour data. Utilization is a 0..1 fraction, reset is Unix seconds. */
export function parseFiveHour(headers: Record<string, string> | undefined): Usage | undefined {
	if (!headers) return undefined;
	const lower: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
	const five = parseWindow(lower, "5h");
	if (!five) return undefined;
	const week = parseWindow(lower, "7d");
	return week ? { ...five, week } : five;
}
