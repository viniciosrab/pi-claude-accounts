import { test } from "node:test";
import assert from "node:assert/strict";
import { formatStatus } from "../src/status.ts";

const NOW = 1000;

test("shows the active account and its 5h usage", () => {
	const s = { active: "work", accounts: [{ name: "default" }, { name: "work", usage: { utilization: 0.423, resetsAt: NOW + 60 } }] };
	assert.equal(formatStatus(s, NOW), "Claude: work · 5h 42%");
});

test("unknown usage and an expired window", () => {
	assert.equal(formatStatus({ active: "default", accounts: [{ name: "default" }] }, NOW), "Claude: default · 5h n/a");
	const reset = { active: "a", accounts: [{ name: "a", usage: { utilization: 0.99, resetsAt: NOW - 1 } }] };
	assert.equal(formatStatus(reset, NOW), "Claude: a · 5h 0%");
});
