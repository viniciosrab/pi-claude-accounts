// Keeps a run going when its account hits the limit. claude-bridge words that failure as
// "Claude quota exceeded — rate limit ...", which Pi never retries ("quota exceeded" is on its
// non-retryable list), so the run, or a subagent, simply stops. After switching accounts the
// failure is reworded as a plain rate limit: Pi retries it, and the bridge opens a fresh Claude
// Code process, which reads the new account's token.

import type { Usage } from "./policy.ts";

const LIMIT_FAILURE = /claude (quota exceeded — )?rate limit|you['’]ve hit your .*limit|you['’]re out of extra usage/i;

/** True for the messages claude-bridge gives when Claude Code refuses a request over a usage limit. */
export function isLimitFailure(message: string | undefined): boolean {
	return message !== undefined && LIMIT_FAILURE.test(message);
}

/** Replacement error text that Pi's auto-retry accepts ("service temporarily unavailable"). The
 *  original text is left out: words like "quota exceeded" or "billing" would make Pi give up. */
export function retryNotice(from: string, to: string, reason: string): string {
	return `Claude service temporarily unavailable on account "${from}" (${reason}); switched to "${to}" and retrying.`;
}

/** The refused account's window is full until its reset; a reset already past is unknown again. */
export function exhaustedUsage(previous: Usage | undefined, now: number): Usage {
	const resetsAt = previous?.resetsAt !== undefined && previous.resetsAt > now ? previous.resetsAt : undefined;
	return resetsAt === undefined ? { utilization: 1, checkedAt: now } : { utilization: 1, resetsAt, checkedAt: now };
}
