#!/usr/bin/env node
// The sandbox: the whole lifecycle against the LOCAL database and a dev server on this Mac,
// using a disposable .test domain. No Cloudflare credentials, nothing real is touched.
//
//   npm run state:check      # types + lint + unit tests + this
//   npm run state:sandbox    # just this
//
// Requires `npm run dev` in another terminal. Every step asserts an exit code AND, for the
// refusals, the message - because "it did nothing" and "it said why" are different results.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DOC = "scripts/state/specs/_local.json";
const URL = process.env.MAILFLARE_URL ?? "http://localhost:3000";
const cli = (doc, verb) => spawnSync("npx", ["tsx", "scripts/state/apply.ts", doc, verb, "--local", "--url", URL], { encoding: "utf8" });
const output = (r) => `${r.stdout ?? ""}${r.stderr ?? ""}`;

const up = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "3", URL], { encoding: "utf8" });
if (!["401", "200"].includes(up.stdout?.trim())) {
	console.error(`\nNo dev server at ${URL}. Start one first:\n\n  npm run dev\n`);
	process.exit(1);
}

console.log(`state sandbox — local, disposable\n`);

// --- what it must DO ---------------------------------------------------------------------
const steps = [
	{ name: "reset      wipe the local database, make an admin", verb: "reset", expect: 0 },
	{ name: "apply      licence, mailboxes, account, routing, MCP key", verb: "apply", expect: 0 },
	{ name: "plan       everything reconciled, nothing to do", verb: "plan", expect: 0 },
	{ name: "apply      idempotent: a second apply changes nothing", verb: "apply", expect: 0 },
	{ name: "destroy    tenants, then the server's own records", verb: "destroy", expect: 0 },
	{ name: "plan       work to do again, so the teardown was real", verb: "plan", expect: 1 },
];

let failed = 0;
const check = (ok, name, detail = "") => {
	if (!ok) failed += 1;
	console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
};

for (const step of steps) {
	const result = cli(DOC, step.verb);
	const ok = result.status === step.expect;
	check(ok, step.name, `(expected exit ${step.expect}, got ${result.status})`);
	if (!ok) console.log(output(result).split("\n").slice(-12).map((line) => `      ${line}`).join("\n"));
}

// --- what it must REFUSE -----------------------------------------------------------------
console.log("\n  refusals:");
const dir = mkdtempSync(join(tmpdir(), "state-sandbox-"));
const refusals = [
	{
		name: "a grant to an address with no local account is a PROBLEM",
		doc: { domain: "sandbox.test", onboard: { receivingProvider: "none" }, mailboxes: [{ role: "support", shared: true, access: [{ email: "outside@elsewhere.test", permission: "full_access" }] }] },
		contains: "no local user with that address",
	},
	{
		name: "a bad permission is rejected at load, with the field path",
		doc: { domain: "sandbox.test", mailboxes: [{ role: "office", access: [{ email: "a@sandbox.test", permission: "fullaccess" }] }] },
		contains: "is not one of",
	},
	{
		name: "an unknown section is rejected at load",
		doc: { domain: "sandbox.test", mailboxs: [] },
		contains: "unknown section",
	},
	{
		name: "a mailbox with no role is rejected at load",
		doc: { domain: "sandbox.test", mailboxes: [{ displayName: "Oops" }] },
		contains: "needs a role",
	},
];

for (const [index, refusal] of refusals.entries()) {
	const path = join(dir, `refusal-${index}.json`);
	writeFileSync(path, `${JSON.stringify(refusal.doc, null, 2)}\n`);
	const result = cli(path, "plan");
	const text = output(result);
	check(result.status === 1 && text.includes(refusal.contains), refusal.name,
		result.status !== 1 ? `(expected exit 1, got ${result.status})` : `(missing "${refusal.contains}")`);
}

console.log(failed === 0 ? "\nsandbox OK — it does what it should, and refuses what it should." : `\n${failed} step(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
