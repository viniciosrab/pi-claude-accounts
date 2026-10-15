import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProbeOutput, staleAccounts, PROBE_TTL, PREFETCH_AT } from "../src/probe.ts";

const ev = (status: string, five?: object) =>
	JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status, unifiedWindows: five ? { five_hour: five, seven_day: { utilization: 0.9 } } : {} } });

test("reads the last five_hour window from stream-json output", () => {
	const out = ["{\"type\":\"system\"}", ev("allowed", { utilization: 0.2, resetsAt: 10 }), "garbage", ev("allowed", { utilization: 0.3, resetsAt: 11 })].join("\n");
	assert.deepEqual(parseProbeOutput(out), { utilization: 0.3, resetsAt: 11 });
});

test("an exhausted account still reports its window", () => {
	assert.deepEqual(parseProbeOutput(ev("rejected", { utilization: 1, resetsAt: 50 })), { utilization: 1, resetsAt: 50 });
});

test("no five_hour data yields undefined", () => {
	assert.equal(parseProbeOutput(ev("allowed")), undefined);
	assert.equal(parseProbeOutput("Not logged in"), undefined);
});

test("stale = other accounts never checked or checked longer than the TTL ago, still inside their window", () => {
	const now = 100_000;
	const accounts = [
		{ name: "active", usage: { utilization: 0.9, checkedAt: 0 } },
		{ name: "never" },
		{ name: "fresh", usage: { utilization: 0.1, checkedAt: now - 60 } },
		{ name: "old", usage: { utilization: 0.1, checkedAt: now - PROBE_TTL - 1 } },
		{ name: "old-no-stamp", usage: { utilization: 0.1 } },
		{ name: "reset", usage: { utilization: 1, resetsAt: now - 1, checkedAt: now - PROBE_TTL - 1 } },
	];
	assert.deepEqual(staleAccounts(accounts, "active", now).map((a) => a.name), ["never", "old", "old-no-stamp"]);
});

test("prefetch starts before the switch threshold", () => {
	assert.ok(PREFETCH_AT < 0.95 && PREFETCH_AT >= 0.8);
});

import { isAuthFailure, PROBE_ARGS, probeAuthFailed } from "../src/probe.ts";

test("recognizes the auth failures claude-bridge and Claude Code report", () => {
	assert.ok(isAuthFailure("Failed to authenticate. API Error: 401 OAuth access token is invalid."));
	assert.ok(isAuthFailure("Not logged in · Please run /login"));
	assert.ok(isAuthFailure("API Error: 403 OAuth token has been revoked"));
	assert.equal(isAuthFailure("Claude quota exceeded — rate limit (five_hour): You've hit your session limit"), false);
	assert.equal(isAuthFailure(undefined), false);
});

test("a probe whose result is an auth failure is flagged", () => {
	const out = JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" });
	assert.equal(probeAuthFailed(out), true);
	assert.equal(probeAuthFailed(JSON.stringify({ type: "result", is_error: false, result: "ok" })), false);
});

test("the probe skips hooks, MCP, tools, skills and session files", () => {
	for (const flag of ["--setting-sources=", "--strict-mcp-config", "--tools=", "--no-session-persistence", "--disable-slash-commands"])
		assert.ok(PROBE_ARGS.includes(flag), flag);
});
