import { test } from "node:test";
import assert from "node:assert/strict";
import { completeArgs } from "../src/completions.ts";

const names = ["default", "work", "personal"];
const values = (prefix: string) => completeArgs(prefix, names)?.map((c) => c.value) ?? null;

test("empty prefix lists every subcommand", () => {
	assert.deepEqual(values(""), ["list", "refresh", "add", "use", "remove", "status"]);
});

test("partial subcommand is filtered", () => {
	assert.deepEqual(values("u"), ["use"]);
	assert.deepEqual(values("re"), ["refresh", "remove"]);
	assert.equal(values("zzz"), null);
});

test("use/remove complete account names; remove hides default", () => {
	assert.deepEqual(values("use "), ["use default", "use work", "use personal"]);
	assert.deepEqual(values("use w"), ["use work"]);
	assert.deepEqual(values("remove "), ["remove work", "remove personal"]);
});

test("add and list take no completions after the subcommand", () => {
	assert.equal(values("add "), null);
	assert.equal(values("list "), null);
});
