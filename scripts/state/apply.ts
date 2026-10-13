#!/usr/bin/env node
// The one entry point. Everything this system does - onboarding, mailboxes, accounts,
// routing rules, MCP keys, the license, web push - is a Resource (see
// ./resources/registry.ts) applied by one loop, and every capability can be declared
// in JSON. There is no per-capability command.
//
//   npm run state -- --spec scripts/state/specs/example.json
//   npm run state -- --domain example.com --roles office,admin
//   npm run state -- --all --dry-run
//   npm run state -- --plan team        # global capabilities need no domain
//   npm run state -- --push
//
// ⚠ MX WARNING — `--onboard` publishes Mailflare's Email Routing MX for the domain.
//   On a domain that already receives mail (a live company domain) that redirects its
//   real mail, so the script refuses unless you pass --confirm-mx.
import { parseCli, usage } from "./args";
import { loadFleet, loadSpec, resolveInstance, rolesFor } from "./document";
import { subjectLines, subjectTotal, subjectUnknown } from "./subject-scope";
import { SOURCE_CHANGES, printSourceChanges, sourceChangeNeeded } from "./src-changes";
import { loadSpecs, runSpecs, type SpecEntry } from "./runner";
import { makeContext } from "./context";
import { run } from "./driver";
import { pushRunbook } from "./resources/push";
import { withStore } from "./app";
import type { Role, Spec } from "./spec";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const { values, flags } = parseCli();

if (values.help) {
	usage();
	process.exit(0);
}
if (values["source-changes"]) {
	printSourceChanges();
	process.exit(0);
}
if (flags.steps) {
	pushRunbook(flags.db, flags.local);
	process.exit(0);
}

// --all/--spec load many documents; the global convenience flags run a single target.
const specMode = Boolean(values.all) || Boolean(values.spec);
const useSpecs = specMode && !flags.licenseStatus;
// The instance layer. `--instance` is a NAME from the fleet - which also supplies the
// server's origin and database, so no --url/--db is needed - or a path for a one-off.
// Loaded up front so a run consisting only of it (a reset, a licence change) is still
// work to do.
const instanceRef = values.instance ? resolveInstance(String(values.instance), loadFleet()) : null;
if (instanceRef?.url) flags.url = instanceRef.url;
if (instanceRef?.db) flags.db = instanceRef.db;
const instanceSpec = instanceRef ? loadSpec(instanceRef.docPath) : null;
const hasInstanceWork = Boolean(instanceSpec?.fresh || instanceSpec?.license || instanceSpec?.push);

// A subject query: where one person's data lives, and - with --erase - the destruction of
// it. Read-only unless asked otherwise: it needs no domain and no document.
if (values["data-subject"]) {
	const code = await withStore({ db: flags.db, local: flags.local, url: flags.url }, async (store) => {
		const email = String(values["data-subject"]);

		if (flags.erase) {
			const before = await store.subjectReport(email);
			const total = subjectTotal(before);
			if (flags.dryRun) {
				console.log(`Subject ${email}: ${total} row(s) and its R2 objects would be DESTROYED\n`);
				for (const line of subjectLines(before)) console.log(line);
				return total === 0 ? 0 : 1;
			}
			if (!before.userId) {
				console.log(`Subject ${email}: no account for that address — nothing to erase.`);
				return 0;
			}
			const result = await store.eraseSubject(email);
			console.log(`Erased ${result.email}\n`);
			for (const line of subjectLines({ ...before, counts: result.deleted })) console.log(line);
			console.log(`\n  ${result.objectsDeleted}/${result.objectKeys.length} R2 object(s) deleted`);
			for (const skip of result.skipped) console.log(`  not removed: ${skip.table} (${skip.reason})`);
sourceChangeNeeded(SOURCE_CHANGES[0]);
			// A fresh report is the only honest confirmation that it worked.
			const after = await store.subjectReport(email);
			const left = subjectTotal(after);
			console.log(`  after: ${left} row(s) remain`);
			return left === 0 ? 0 : 1;
		}

		const report = await store.subjectReport(email);
		if (!report.userId) {
			console.log(`Subject ${report.email}: no account for that address.`);
			return 0;
		}
		console.log(`Subject ${report.email} — ${report.mailboxIds.length} mailbox(es)\n`);
		for (const line of subjectLines(report)) console.log(line);
		const total = subjectTotal(report);
		console.log(`\n  ${total} row(s) in ${report.counts.filter((count) => count.rows > 0).length} table(s)`);
		const unknown = subjectUnknown(report);
		if (unknown.length > 0) console.log(`  cannot be attributed to anyone (no user/owner column): ${unknown.join(", ")}`);
		if (unknown.length > 0) sourceChangeNeeded(SOURCE_CHANGES[1]);
		return total === 0 ? 0 : 1;
	}).catch((error) => {
		console.error(message(error));
		return 1;
	});
	process.exit(code);
}

let entries: SpecEntry[];
let singleRoles: Role[] = [];

try {
	if (flags.licenseStatus) {
		flags.status = true;
		entries = [{ name: "", spec: { license: {} } }];
	} else if (useSpecs) {
		entries = loadSpecs({ spec: values.spec ? String(values.spec) : undefined, dir: String(values.dir) });
	} else {
		const project: Spec | null = values.spec ? loadSpec(String(values.spec)) : null;
		const domainValue = String(values.domain ?? project?.domain ?? "").trim();
		const target: Spec = project ?? { domain: domainValue };
		// The convenience flags are just shorthand for document sections.
		if (flags.plan !== undefined && !target.license) target.license = { plan: flags.plan };
		if (flags.push && !target.push) target.push = {};
		const global = Boolean(target.fresh) || Boolean(target.license) || Boolean(target.push) || hasInstanceWork;
		singleRoles = rolesFor(values, target, flags);
		if (!domainValue && !global) {
			console.error("Nothing to do. Pass a document (--spec <path>), --all, --domain <hostname>, --plan <team|pro|community>, or --push.\n");
			usage();
			process.exit(1);
		}
		if (domainValue && singleRoles.length === 0 && !global) {
			console.error("Nothing to do for this domain. Use a document (--spec <path>), --roles a,b,c, or --roles-file <path>.\n");
			usage();
			process.exit(1);
		}
		entries = [{ name: domainValue, spec: target }];
	}
	// The instance layer: an instance document carries what belongs to the server rather
	// than a tenant (the licence, web push). It runs FIRST, in the same process and under
	// the same admin key, which is what stops every tenant document having to declare a
	// licence the server already has - and stops a tenant silently depending on one it
	// never declared.
	if (instanceSpec) {
		entries.unshift({ name: `instance:${instanceRef?.name}`, spec: instanceSpec });
	}
} catch (error) {
	console.error(message(error));
	process.exit(1);
}

let exitCode = 1;
try {
	exitCode = await withStore({ db: flags.db, local: flags.local, url: flags.url }, async (store) => {
		if (useSpecs) return await runSpecs(store, flags, values, entries);
		const [entry] = entries;
		return await run(makeContext(store, flags, entry.spec, entry.name.toLowerCase()), singleRoles);
	});
} catch (error) {
	console.error(message(error));
}
process.exit(exitCode);
