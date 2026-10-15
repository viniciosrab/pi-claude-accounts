import assert from "node:assert/strict";
import { test } from "node:test";
import { exhaustedUsage, isLimitFailure, retryNotice } from "../src/limit.ts";

// Pi 1.3.0 retry classification (pi-ai retry.ts): non-retryable wins over retryable.
const PI_NON_RETRYABLE = /billing|GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|subscription_sharing_usage_limit_exceeded/i;
const PI_RETRYABLE = /overloaded|rate.?limit|too many requests|429|service.?(?:is.?)?(?:temporarily.?)?unavailable/i;
const piRetries = (m: string) => !PI_NON_RETRYABLE.test(m) && PI_RETRYABLE.test(m);

test("recognises the limit failures claude-bridge reports", () => {
	assert.equal(isLimitFailure("Claude quota exceeded — rate limit (five_hour) — resets 9:30:00 AM: You've hit your session limit · resets 9:30am (America/Sao_Paulo)"), true);
	assert.equal(isLimitFailure("Claude rate limit (five_hour) — resets 11:00:00 PM: You've hit your session limit · resets 11pm (America/Sao_Paulo)"), true);
	assert.equal(isLimitFailure("You've hit your session limit · resets 2am"), true);
	assert.equal(isLimitFailure("You’ve hit your session limit · resets 2am"), true);
	assert.equal(isLimitFailure("You're out of extra usage · resets 6:30pm"), true);
	assert.equal(isLimitFailure("You’re out of extra usage · resets 6:30pm"), true);
});

test("ignores other failures", () => {
	assert.equal(isLimitFailure(undefined), false);
	assert.equal(isLimitFailure("Operation aborted"), false);
	assert.equal(isLimitFailure("Our servers are currently overloaded. Please try again later."), false);
	assert.equal(isLimitFailure("Failed to authenticate. API Error: 401 OAuth access token is invalid."), false);
});

test("the bridge's limit failure is not retried by Pi as is", () => {
	assert.equal(piRetries("Claude quota exceeded — rate limit (five_hour) — resets 9:30:00 AM: You've hit your session limit"), false);
});

test("the notice that replaces it is retried by Pi and names both accounts", () => {
	const notice = retryNotice("a", "b", "limit reached");
	assert.equal(piRetries(notice), true);
	assert.match(notice, /"a"/);
	assert.match(notice, /"b"/);
	assert.doesNotMatch(notice, /quota exceeded/i);
	// An auth failure reworded the same way is retried too.
	assert.equal(piRetries(retryNotice("a", "b", "token rejected, re-add it")), true);
});

test("exhausted usage keeps a future reset and counts as full", () => {
	assert.deepEqual(exhaustedUsage({ utilization: 0.97, resetsAt: 2_000, checkedAt: 1 }, 1_000), { utilization: 1, resetsAt: 2_000, checkedAt: 1_000 });
	assert.deepEqual(exhaustedUsage({ utilization: 0.2, resetsAt: 500 }, 1_000), { utilization: 1, checkedAt: 1_000 });
	assert.deepEqual(exhaustedUsage(undefined, 1_000), { utilization: 1, checkedAt: 1_000 });
});
