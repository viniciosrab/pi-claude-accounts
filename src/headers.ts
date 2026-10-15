// claude-bridge rebuilds Claude Code's rate_limit_event as these headers (see its src/rate-limit.ts).

import type { Usage } from "./policy.ts";

const PREFIX = "anthropic-ratelimit-unified-5h-";

/** Only the five-hour window matters; utilization is a 0..1 fraction, reset is Unix seconds. */
export function parseFiveHour(headers: Record<string, string> | undefined): Usage | undefined {
	if (!headers) return undefined;
	const lower: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
	const utilization = Number(lower[`${PREFIX}utilization`]);
	if (lower[`${PREFIX}utilization`] === undefined || !Number.isFinite(utilization)) return undefined;
	const reset = Number(lower[`${PREFIX}reset`]);
	return { utilization, resetsAt: lower[`${PREFIX}reset`] !== undefined && Number.isFinite(reset) ? reset : undefined };
}
