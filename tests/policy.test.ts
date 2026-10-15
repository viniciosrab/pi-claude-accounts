import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveUtilization, pickAccount, type Account } from "../src/policy.ts";

const NOW = 1_000_000;
const acc = (name: string, utilization?: number, resetsAt?: number): Account => ({
	name,
	usage: utilization === undefined ? undefined : { utilization, resetsAt },
});

test("stays on the active account below the threshold", () => {
	const r = pickAccount([acc("a", 0.94), acc("b", 0.1)], "a", NOW);
	assert.deepEqual(r, { name: "a", switched: false });
});

test("switches at exactly 95% to the first account below the threshold", () => {
	const r = pickAccount([acc("a", 0.95), acc("b", 0.96), acc("c", 0.2)], "a", NOW);
	assert.deepEqual(r, { name: "c", switched: true });
});

test("account with unknown usage counts as available", () => {
	assert.equal(pickAccount([acc("a", 0.99), acc("b")], "a", NOW).name, "b");
});

test("expired window counts as zero utilization", () => {
	assert.equal(effectiveUtilization(acc("a", 0.99, NOW - 1), NOW), 0);
	assert.equal(pickAccount([acc("a", 0.99, NOW - 1)], "a", NOW).switched, false);
});

test("all exhausted: moves to the soonest reset, else stays", () => {
	const r = pickAccount([acc("a", 0.97, NOW + 500), acc("b", 0.99, NOW + 100)], "a", NOW);
	assert.deepEqual(r, { name: "b", switched: true });
	const stay = pickAccount([acc("a", 0.97, NOW + 100), acc("b", 0.99, NOW + 500)], "a", NOW);
	assert.deepEqual(stay, { name: "a", switched: false });
});

test("unknown active name falls back to the first account", () => {
	assert.equal(pickAccount([acc("a", 0.1)], "ghost", NOW).name, "a");
});

const rejected = (name: string, utilization = 0): Account => ({ name, usage: { utilization }, authFailed: true });

test("an account whose token was rejected is never a switch target", () => {
	assert.deepEqual(pickAccount([acc("a", 0.97), rejected("b"), acc("c", 0.5)], "a", NOW), { name: "c", switched: true });
});

test("a rejected active account is left at once, even below the threshold", () => {
	assert.deepEqual(pickAccount([rejected("a", 0.1), acc("b", 0.5)], "a", NOW), { name: "b", switched: true });
});

test("a rejected active account with nowhere to go stays", () => {
	assert.deepEqual(pickAccount([rejected("a"), rejected("b")], "a", NOW), { name: "a", switched: false });
});
