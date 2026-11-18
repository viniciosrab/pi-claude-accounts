import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFiveHour } from "../src/headers.ts";

test("reads 5h utilization and reset from the unified headers", () => {
	const h = {
		"anthropic-ratelimit-unified-5h-utilization": "0.51",
		"anthropic-ratelimit-unified-5h-reset": "1792031400",
		"anthropic-ratelimit-unified-7d-utilization": "0.99",
	};
	assert.deepEqual(parseFiveHour(h), { utilization: 0.51, resetsAt: 1792031400, week: { utilization: 0.99, resetsAt: undefined } });
});

test("reads the 7d window as the weekly usage, shown but never used for switching", () => {
	const h = {
		"anthropic-ratelimit-unified-5h-utilization": "0.51",
		"anthropic-ratelimit-unified-7d-utilization": "0.3",
		"anthropic-ratelimit-unified-7d-reset": "1792500000",
	};
	assert.deepEqual(parseFiveHour(h), { utilization: 0.51, resetsAt: undefined, week: { utilization: 0.3, resetsAt: 1792500000 } });
	assert.deepEqual(parseFiveHour({ ...h, "anthropic-ratelimit-unified-7d-utilization": "abc" }), { utilization: 0.51, resetsAt: undefined });
});

test("responses without 5h data yield nothing, even with a 7d window (S1)", () => {
	assert.equal(parseFiveHour({ "anthropic-ratelimit-unified-7d-utilization": "0.99" }), undefined);
	assert.equal(parseFiveHour({}), undefined);
	assert.equal(parseFiveHour({ "anthropic-ratelimit-unified-5h-utilization": "abc" }), undefined);
});

test("header names are matched case-insensitively; reset is optional", () => {
	assert.deepEqual(parseFiveHour({ "Anthropic-RateLimit-Unified-5h-Utilization": "0.2" }), { utilization: 0.2, resetsAt: undefined });
});
