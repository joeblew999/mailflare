#!/usr/bin/env node
// The entry point: a TARGET and a VERB, as terraform has.
//
//   npm run state -- plan                     every project
//   npm run state -- mailflare apply          a project (server, instance, tenants)
//   npm run state -- mailflare destroy
//   npm run state -- mailflare reset          wipe it and make a primary admin
//   npm run state -- subject <email> plan     an operation on a person
//
// Everything that describes WHAT to build lives in the documents. The flags only say HOW to
// run it, and the globals are derived from the instance document below so the resources keep
// reading one source of truth.
import { parseCli, usage } from "./args";
import { loadProject, loadServer } from "./document";
import { loadSpecs, runSpecs, type SpecEntry } from "./runner";
import { deployServer, destroyServer } from "./deploy";
import { pushRunbook } from "./resources/push";
import { SOURCE_CHANGES, printSourceChanges, sourceChangeNeeded } from "./src-changes";
import { subjectLines, subjectTotal, subjectUnknown } from "./subject-scope";
import { withStore } from "./app";

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
if (values.steps) {
	pushRunbook(flags.db, flags.local);
	process.exit(0);
}

// A subject is an OPERATION, not desired state, so it is a verb rather than a document.
if (values["data-subject"]) {
	const code = await withStore({ db: flags.db, local: flags.local, url: flags.url }, async (store) => {
		const email = String(values["data-subject"]);

		if (flags.cleanup) {
			const before = await store.subjectReport(email);
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
		if (unknown.length > 0) {
			console.log(`  cannot be attributed to anyone (no user/owner column): ${unknown.join(", ")}`);
			sourceChangeNeeded(SOURCE_CHANGES[1]);
		}
		return total === 0 ? 0 : 1;
	}).catch((error) => {
		console.error(message(error));
		return 1;
	});
	process.exit(code);
}

// A positional TARGET becomes whichever of project / folder / document it looks like.
if (values.target) {
	const target = String(values.target);
	if (target.endsWith(".json")) values.spec = target;
	else if (target.includes("/")) {
		values.dir = target;
		values.all = true;
	} else values.project = target;
} else if (["plan", "apply", "destroy"].includes(String(values.verb))) {
	// A verb with no target means the whole config root, like terraform with no -chdir.
	// Not for reset: wiping every project because a target was forgotten is a bad default.
	values.all = true;
}

let entries: SpecEntry[];
try {
	if (values.project) entries = loadProject(String(values.project));
	else if (values.all) entries = loadSpecs({ dir: String(values.dir) });
	else if (values.spec) entries = loadSpecs({ spec: String(values.spec), dir: String(values.dir) });
	else {
		console.error("Nothing to do. Pass a target: a project name, a folder, or a document.\n");
		usage();
		process.exit(1);
	}

	// The instance document holds the globals. Deriving them here is what lets the CLI be
	// three verbs and a target without the resources losing their single source of truth.
	const instance = entries.find((entry) => entry.name.startsWith("instance:"))?.spec;
	if (instance) {
		const plan = typeof instance.license === "string" ? instance.license : instance.license?.plan;
		if (plan) flags.plan = plan;
		if (instance.push) {
			flags.push = true;
			flags.to = instance.push.to;
			flags.from = instance.push.from;
			flags.subject = instance.push.subject;
			if (instance.push.timeout) flags.timeout = String(instance.push.timeout);
		}
		if (instance.fresh?.admin) {
			flags.adminEmail = instance.fresh.admin.email;
			flags.adminPassword = instance.fresh.admin.password;
		}
	}
} catch (error) {
	console.error(message(error));
	process.exit(1);
}

// Pointing at a folder reconciles the SERVER too: deploy it when it is not registered, and on
// destroy remove it. A registered server is left alone, so this is idempotent.
if (values.project) {
	const server = loadServer(String(values.project));
	if (server.url) flags.url = server.url;
	if (server.db) flags.db = server.db;
	if (!flags.cleanup && !server.url) {
		const code = await deployServer({ name: server.name, dryRun: flags.status, url: flags.url }).catch((error) => {
			console.error(message(error));
			return 1;
		});
		if (code > 0) process.exit(code);
	}
}

let exitCode = 1;
try {
	exitCode = await withStore({ db: flags.db, local: flags.local, url: flags.url }, async (store) => runSpecs(store, flags, values, entries));
} catch (error) {
	console.error(message(error));
}

// The teardown finishes with the server, so the tenants are gone before the Worker is.
if (values.project && flags.cleanup) {
	const server = loadServer(String(values.project));
	const code = await destroyServer({ name: server.name, dryRun: flags.status, confirmed: flags.confirmDestroy }).catch((error) => {
		console.error(message(error));
		return 1;
	});
	if (code > 0) exitCode = code;
}
process.exit(exitCode);
