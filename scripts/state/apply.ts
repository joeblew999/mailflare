#!/usr/bin/env node
// The entry point: a TARGET and a VERB, as terraform has.
import { UsageError, parseCli, usage, type Cli, type Target } from "./args";
import { refreshColos } from "./colos";
import { holds, parseBackup } from "./backup";
import { conform, verify } from "./conform";
import { CONFORMANCE_DIR, loadDocumentTarget, loadFolderTarget, loadProject, loadProjects, type Project } from "./document";
import { liveProbes } from "./probes";
import { deployServer } from "./deploy";
import { liveDeps, resolveInstance, runFleet, subjectInstances } from "./fleet";
import { backupKeys } from "./resources/erased";
import { pushRunbook } from "./resources/push";
import { limiter } from "./runner";
import { router } from "./router";
import { AI_USAGE_UNATTRIBUTABLE, printSourceChanges, sourceChangeNeeded } from "./src-changes";
import { digestOf, subjectLines, subjectTotal, subjectUnknown, tombstones } from "./subject-scope";
import { recordedLogins } from "./vault";
import { message } from "./wrangler";

function projectsFor(target: Target, dir: string): Project[] {
	if (target.kind === "project") return [loadProject(target.name, dir)];
	if (target.kind === "document") return [loadDocumentTarget(target.path)];
	if (target.kind === "folder") return loadFolderTarget(target.path);
	return loadProjects(dir);
}

// Where one person is, on every server: an address says nothing about where its data lives.
// Read-only. Erasing is desired state, so it is written in a document - this says which, and what.
async function subject(cli: Cli, email: string): Promise<number> {
	const { flags } = cli;
	const deps = liveDeps(cli.credentials);
	// Typed instance flags name one instance; otherwise it is the whole fleet.
	const single = flags.local || cli.explicit.db || cli.explicit.url;
	const projects: Project[] = single ? [{ name: flags.local ? "local" : flags.db, dir: cli.dir, server: null, entries: [] }] : loadProjects(cli.dir);
	const digest = digestOf(email);
	let code = 0;
	for (const { name, instance } of subjectInstances(projects, cli, deps.template())) {
		const project = projects.find((candidate) => candidate.name === name);
		const said = await deps.openStore(instance, async (store) => {
			const report = await store.subjectReport(email);
			// Every backup is read: one that still holds them is the thing an erasure most often misses.
			const backups = [...(await backupKeys(store)).keys()];
			let holding = 0;
			for (const key of backups) {
				const document = parseBackup((await store.readObject(key)) ?? "");
				if (!document || holds(document, [digest]).length > 0) holding += 1;
			}
			return { report, backups: backups.length, holding };
		}).catch((error) => {
			console.error(`${name}: ${message(error)}`);
			code = 1;
			return null;
		});
		if (!said) continue;
		const { report } = said;
		const elsewhere = report.elsewhere.filter((count) => count.rows > 0).map((count) => `${count.rows} ${count.table}`);
		const declared = (project?.entries ?? []).filter((entry) => (entry.spec.accounts ?? []).some((account) => `${account.username.trim().toLowerCase()}@${String(entry.spec.domain).trim().toLowerCase()}` === email) || entry.spec.fresh?.admin?.email?.trim().toLowerCase() === email);
		const tombstoned = (project?.entries ?? []).filter((entry) => tombstones(entry.spec).some((stone) => stone.digest === digest));
		if (!report.userId && said.holding === 0 && elsewhere.length === 0 && declared.length === 0 && tombstoned.length === 0) {
			console.log(`${name}: nothing of ${email}.`);
			continue;
		}
		console.log(`\n${name}: ${email}`);
		if (report.userId) {
			console.log(`  an account, ${report.mailboxIds.length} mailbox(es), ${subjectTotal(report)} row(s) in ${report.counts.filter((count) => count.rows > 0).length} table(s), ${report.objects} object(s) in the bucket`);
			for (const line of subjectLines(report)) console.log(`  ${line}`);
			const unknown = subjectUnknown(report);
			if (unknown.length > 0) {
				console.log(`  cannot be attributed to anyone (no user or owner column): ${unknown.join(", ")}`);
				sourceChangeNeeded(AI_USAGE_UNATTRIBUTABLE);
			}
		} else console.log("  no account");
		console.log(`  backups: ${said.holding} of ${said.backups} hold them`);
		if (elsewhere.length > 0) console.log(`  named in other people's data, which is theirs and stays: ${elsewhere.join(", ")}`);
		for (const entry of declared) console.log(`  declared in ${entry.name}`);
		for (const entry of tombstoned) console.log(`  declared erased in ${entry.name}`);
		for (const blocker of report.blockers) console.log(`  ! cannot be erased: ${blocker}`);
		const stale = tombstoned.length > 0 && (report.userId || said.holding > 0);
		if (stale) console.log("  ! declared erased, and still here: apply with --confirm-destroy");
		if (stale || report.blockers.length > 0) code = 1;
		if (tombstoned.length === 0 && (report.userId || said.holding > 0) && report.blockers.length === 0) {
			console.log(`\n  To erase them from ${name}: take them out of "accounts" if they are there, and add to a document of this server`);
			console.log(`      "erased": ["${email}"]`);
			console.log(`  or, to keep no address in the document:`);
			console.log(`      "erased": ["${digest}"]`);
			console.log(`  then: npm run state -- ${name} plan   and   npm run state -- ${name} apply --confirm-destroy`);
		}
	}
	return code;
}

// `apply` builds a server that does not exist. This rolls the CODE - and whatever wrangler.jsonc
// now binds - out to the ones that do. It is built once, and the servers are uploaded to
// several at a time: what a fleet costs is the uploads, not a build each.
async function deploy(cli: Cli, projects: Project[]): Promise<number> {
	const deps = liveDeps();
	const template = deps.template();
	const targets = projects.filter((project) => project.server && !project.server.local && !project.server.template);
	const limit = limiter(Math.max(cli.concurrency, 4));
	const began = Date.now();
	if (targets.length > 1) await deps.warmUp();
	const results: Array<[string, boolean]> = await Promise.all(targets.map((project) => limit(async (): Promise<[string, boolean]> => {
		const server = project.server!;
		const { deployment } = resolveInstance(project, cli, template);
		return [server.name, !!deployment && !!(await deployServer(server, deployment, { base: project.dir, dryRun: false, print: console.log, template }))];
	})));
	console.log("\n──────── summary");
	for (const [name, ok] of results) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
	console.log(`\n${results.filter(([, ok]) => ok).length}/${results.length} server(s) deployed in ${Math.round((Date.now() - began) / 1000)}s`);
	return results.every(([, ok]) => ok) ? 0 : 1;
}

// Cloudflare stops honouring a placement for a while now and then, and until it is moved the
// server runs wherever a request arrives. This asks every server where it answers from - one
// request each - and moves any that is not home. It is seconds, so it is what to put on a schedule.
async function keepPlaced(cli: Cli, projects: Project[]): Promise<number> {
	const deps = liveDeps();
	const template = deps.template();
	const limit = limiter(Math.max(cli.concurrency, 8));
	const targets = projects.filter((project) => project.server?.country && project.server.url && !project.server.local);
	const results = await Promise.all(targets.map((project) => limit(async () => {
		const server = project.server!;
		const { deployment } = resolveInstance(project, cli, template);
		const placed = deployment ? await deps.place(server, deployment, server.url!, { fix: true }).catch((error) => ({ ok: false, said: message(error) })) : { ok: false, said: "it has no deployment" };
		console.log(`  ${placed.ok ? (placed.said ? "~" : "✓") : "✗"} ${server.name}: ${placed.said ?? `answers from ${server.country!.toUpperCase()}`}`);
		return placed.ok;
	})));
	if (targets.length === 0) console.log("No deployed server declares a country.");
	return results.every(Boolean) ? 0 : 1;
}

async function main(): Promise<number> {
	let cli: Cli;
	try {
		cli = parseCli();
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		console.error(`${error.message}\n\nRun with --help for the commands.`);
		return 1;
	}
	const { command } = cli;
	if (command.kind === "help") return usage(), 0;
	if (command.kind === "source-changes") return printSourceChanges(), 0;
	if (command.kind === "steps") return pushRunbook(cli.flags.db, cli.flags.local), 0;
	// One JSON document per person: what to send them. The same documents are files beside the vault.
	if (command.kind === "logins") return console.log(JSON.stringify(recordedLogins(cli.credentials, command.project), null, 2)), 0;
	try {
		if (command.kind === "colos") return await refreshColos();
		if (command.kind === "subject") return await subject(cli, command.email);
		if (command.kind === "router") return await router(loadProjects(cli.dir), cli.flags, cli.router);
		if (command.kind === "deploy") return await deploy(cli, projectsFor(command.target, cli.dir));
		if (command.kind === "place") return await keepPlaced(cli, projectsFor(command.target, cli.dir));
		if (command.kind === "verify") return await verify(projectsFor(command.target, cli.dir), cli.concurrency, liveDeps(cli.credentials), liveProbes);
		if (command.kind === "conform") {
			// With no target, the servers kept for this: read again at each step, since a deploy
			// writes an origin into a server's document and a destroy takes it out.
			const target = command.target;
			const load = () => (target ? projectsFor(target, cli.dir) : loadProjects(CONFORMANCE_DIR, { disposable: true }));
			return await conform({ concurrency: Math.max(cli.concurrency, 4), quick: command.quick, load, probes: liveProbes }, liveDeps(cli.credentials));
		}
		const code = await runFleet(projectsFor(command.target, cli.dir), cli, liveDeps(cli.credentials));
		// The whole fleet includes its front door, read again: a deploy just wrote new origins.
		if (command.target.kind !== "all" || command.verb === "reset") return code;
		return Math.max(code, await router(loadProjects(cli.dir), cli.flags, cli.router));
	} catch (error) {
		console.error(message(error));
		return 1;
	}
}

process.exit(await main());
