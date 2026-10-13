#!/usr/bin/env node
// The sandbox: the whole lifecycle against the LOCAL database, using a disposable .test
// domain. No Cloudflare credentials, nothing real is touched.
//
//   npm run state:check      # types + lint + unit tests + this
//   npm run state:sandbox    # just this
//
// It owns the dev server, because the reset wipes the local database and the server holds the
// same SQLite file - running both at once half-fails the wipe and makes everything after it
// meaningless. So: no server on the port, reset, start one, run the lifecycle, stop it.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DOC = "scripts/state/specs/_local.json";
const URL = process.env.MAILFLARE_URL ?? "http://localhost:3000";
const cli = (doc, verb) => spawnSync("npx", ["tsx", "scripts/state/apply.ts", doc, verb, "--local", "--url", URL], { encoding: "utf8" });
const output = (r) => `${r.stdout ?? ""}${r.stderr ?? ""}`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const up = () => spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "2", URL], { encoding: "utf8" }).stdout?.trim();

let failed = 0;
const check = (ok, name, detail = "") => {
	if (!ok) failed += 1;
	console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
};

// A reset-only document: the wipe must happen BEFORE the server exists, and the rest of the
// lifecycle needs the server. Applying the full document here would reach for the API.
const dir = mkdtempSync(join(tmpdir(), "state-sandbox-"));
const RESET_DOC = join(dir, "reset.json");
writeFileSync(RESET_DOC, `${JSON.stringify({ fresh: { admin: { email: "root@sandbox.test", password: "sandbox-admin-pass-123" } } }, null, 2)}\n`);

console.log("state sandbox — local, disposable\n");

if (["401", "200"].includes(up())) {
	console.error(`A dev server is already on ${URL}. Stop it first - the reset needs the local database to itself:\n\n  lsof -ti:3000 | xargs kill\n`);
	process.exit(1);
}

// 1. From nothing, with the database to ourselves.
const reset = cli(RESET_DOC, "reset");
check(reset.status === 0, "reset      wipe the local database, make an admin", `(exit ${reset.status})`);
if (reset.status !== 0) {
	console.log(output(reset).split("\n").slice(-10).map((l) => `      ${l}`).join("\n"));
	process.exit(1);
}

// 2. Start the server the rest of the run needs, and take it down again at the end.
const server = spawn("npm", ["run", "dev"], { detached: true, stdio: "ignore" });
process.on("exit", () => {
	try { process.kill(-server.pid, "SIGTERM"); } catch {}
});
for (let attempt = 0; attempt < 40 && !["401", "200"].includes(up()); attempt += 1) await sleep(1000);
check(["401", "200"].includes(up()), "dev        server up on " + URL);
if (!["401", "200"].includes(up())) process.exit(1);

// 3. What it must DO.
const steps = [
	{ name: "apply      licence, mailboxes, account, routing, MCP key", verb: "apply", expect: 0 },
	{ name: "plan       everything reconciled, nothing to do", verb: "plan", expect: 0 },
	{ name: "apply      idempotent: a second apply changes nothing", verb: "apply", expect: 0 },
	{ name: "destroy    tenants, then the server's own records", verb: "destroy", expect: 0 },
	{ name: "plan       work to do again, so the teardown was real", verb: "plan", expect: 1 },
];
for (const step of steps) {
	const result = cli(DOC, step.verb);
	check(result.status === step.expect, step.name, `(expected exit ${step.expect}, got ${result.status})`);
	if (result.status !== step.expect) console.log(output(result).split("\n").slice(-12).map((l) => `      ${l}`).join("\n"));
}

// 4. What it must REFUSE.
console.log("\n  refusals:");
const refusals = [
	{ name: "a grant to an address with no local account is a PROBLEM",
	  doc: { domain: "sandbox.test", onboard: { receivingProvider: "none" }, mailboxes: [{ role: "support", shared: true, access: [{ email: "outside@elsewhere.test", permission: "full_access" }] }] },
	  contains: "no local user with that address" },
	{ name: "a bad permission is rejected at load, with the field path",
	  doc: { domain: "sandbox.test", mailboxes: [{ role: "office", access: [{ email: "a@sandbox.test", permission: "fullaccess" }] }] },
	  contains: "is not one of" },
	{ name: "an unknown section is rejected at load",
	  doc: { domain: "sandbox.test", mailboxs: [] },
	  contains: "unknown section" },
	{ name: "a mailbox with no role is rejected at load",
	  doc: { domain: "sandbox.test", mailboxes: [{ displayName: "Oops" }] },
	  contains: "needs a role" },
	{ name: "a domain that is not onboarded is reported, not thrown",
	  doc: { domain: "never-onboarded.test", mailboxes: [{ role: "office" }] },
	  contains: "not onboarded" },
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
