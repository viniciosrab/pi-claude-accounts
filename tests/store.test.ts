import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAccount, loadStore, removeAccount, saveStore, DEFAULT_ACCOUNT } from "../src/store.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "cacc-")), "claude-accounts.json");

test("missing file yields the default account only, active", () => {
	const s = loadStore(tmp());
	assert.deepEqual(s.accounts.map((a) => a.name), [DEFAULT_ACCOUNT]);
	assert.equal(s.active, DEFAULT_ACCOUNT);
});

test("save writes mode 0600 and round-trips tokens and usage", () => {
	const p = tmp();
	const s = addAccount(loadStore(p), "work", "sk-ant-oat01-x");
	s.accounts[1].usage = { utilization: 0.4, resetsAt: 123 };
	saveStore(p, s);
	assert.equal(statSync(p).mode & 0o777, 0o600);
	const back = loadStore(p);
	assert.equal(back.accounts[1].token, "sk-ant-oat01-x");
	assert.deepEqual(back.accounts[1].usage, { utilization: 0.4, resetsAt: 123 });
});

test("duplicate names and the reserved default name are rejected", () => {
	const s = addAccount(loadStore(tmp()), "work", "t");
	assert.throws(() => addAccount(s, "work", "t2"), /already exists/);
	assert.throws(() => addAccount(s, DEFAULT_ACCOUNT, "t"), /already exists/);
});

test("removing the active account falls back to default; default cannot be removed", () => {
	let s = addAccount(loadStore(tmp()), "work", "t");
	s.active = "work";
	s = removeAccount(s, "work");
	assert.equal(s.active, DEFAULT_ACCOUNT);
	assert.throws(() => removeAccount(s, DEFAULT_ACCOUNT), /default/);
	assert.throws(() => removeAccount(s, "nope"), /not found/);
});

test("corrupt file is left untouched and reported, not overwritten", () => {
	const p = tmp();
	writeFileSync(p, "{ nope");
	assert.throws(() => loadStore(p), /does not parse/);
	assert.equal(readFileSync(p, "utf-8"), "{ nope");
});

test("pasted tokens lose every whitespace, including a wrapped line break", () => {
	const s = addAccount(loadStore(tmp()), "work", "  sk-ant-oat01-ab cd\nef  ");
	assert.equal(s.accounts[1].token, "sk-ant-oat01-abcdef");
});

test("tokens already stored with whitespace are repaired on load", () => {
	const p = tmp();
	writeFileSync(p, JSON.stringify({ active: "work", accounts: [{ name: "default" }, { name: "work", token: "sk-ant-oat01-ab cd" }] }));
	assert.equal(loadStore(p).accounts[1].token, "sk-ant-oat01-abcd");
});

test("updateStore re-reads the file, so two Pi instances do not overwrite each other", async () => {
	const { updateStore } = await import("../src/store.ts");
	const p = tmp();
	saveStore(p, addAccount(loadStore(p), "work", "t"));
	const staleCopyOfA = loadStore(p); // instance A loaded earlier
	updateStore(p, (s) => ({ ...s, accounts: s.accounts.map((a) => (a.name === "work" ? { ...a, usage: { utilization: 0.5 } } : a)) })); // instance B
	updateStore(p, (s) => ({ ...s, active: "work" })); // instance A, never touching its stale copy
	const back = loadStore(p);
	assert.equal(back.active, "work");
	assert.deepEqual(back.accounts[1].usage, { utilization: 0.5 });
	assert.equal(staleCopyOfA.active, "default");
});

test("updateStore writes atomically with mode 0600 and leaves no temp file", async () => {
	const { updateStore } = await import("../src/store.ts");
	const { readdirSync } = await import("node:fs");
	const { dirname } = await import("node:path");
	const p = tmp();
	updateStore(p, (s) => addAccount(s, "work", "t"));
	assert.equal(statSync(p).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(dirname(p)), ["claude-accounts.json"]);
});
