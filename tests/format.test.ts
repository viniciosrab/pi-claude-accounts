import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReset } from "../src/format.ts";

const NOW = 10_000;

test("hours and minutes until the 5h window resets", () => {
	assert.equal(formatReset(NOW + 2 * 3600 + 13 * 60, NOW), "resets in 2h 13m");
	assert.equal(formatReset(NOW + 45 * 60, NOW), "resets in 45m");
	assert.equal(formatReset(NOW + 3600, NOW), "resets in 1h 0m");
	assert.equal(formatReset(NOW + 30, NOW), "resets in <1m");
});

test("nothing when the reset is unknown or already passed", () => {
	assert.equal(formatReset(undefined, NOW), "");
	assert.equal(formatReset(NOW, NOW), "");
	assert.equal(formatReset(NOW - 60, NOW), "");
});
