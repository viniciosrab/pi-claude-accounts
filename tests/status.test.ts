import { test } from "node:test";
import assert from "node:assert/strict";
import { formatStatus } from "../src/status.ts";

test("shows only the active account name", () => {
	const s = { active: "work", accounts: [{ name: "default" }, { name: "work", usage: { utilization: 0.423 } }] };
	assert.equal(formatStatus(s), "work");
});
