#!/usr/bin/env node
// The entry point: a TARGET and a VERB, as terraform has.
import { UsageError, parseCli, usage, type Cli, type Target } from "./args";
import { refreshColos } from "./colos";
import { conform, verify } from "./conform";
import { CONFORMANCE_DIR, loadDocumentTarget, loadFolderTarget, loadProject, loadProjects, type Project } from "./document";
import { liveProbes } from "./probes";
import { deployServer } from "./deploy";
import { liveDeps, resolveInstance, runFleet, subjectInstances } from "./fleet";
import { pushRunbook } from "./resources/push";
import { router } from "./router";
import { SOURCE_CHANGES, printSourceChanges, sourceChangeNeeded } from "./src-changes";
import { subjectLines, subjectTotal, subjectUnknown } from "./subject-scope";
import { recordedLogins } from "./vault";
import { message } from "./wrangler";

function projectsFor(target: Target, dir: string): Project[] {
	if (target.kind === "project") return [loadProject(target.name, dir)];
	if (target.kind === "document") return [loadDocumentTarget(target.path)];
	if (target.kind === "folder") return loadFolderTarget(target.path);
	return loadProjects(dir);
}

// A subject is an OPERATION on one person, not desired state, so it is a verb rather than a
// document. It looks on every server: an address says nothing about where its data is.
async function subject(cli: Cli, email: string, action: "plan" | "destroy"): Promise<number> {
	const { flags } = cli;
	const deps = liveDeps(cli.credentials);
	// Typed instance flags name one instance; otherwise it is the whole fleet.
	const single = flags.local || cli.explicit.db || cli.explicit.url;
	const projects: Project[] = single ? [{ name: flags.local ? "local" : flags.db, dir: cli.dir, server: null, entries: [] }] : loadProjects(cli.dir);
	const erase = action === "destroy" && flags.confirmDestroy;
	let code = 0;
	let found = 0;
	for (const { name, instance } of subjectInstances(projects, cli, deps.template())) {
		code = Math.max(code, await deps.openStore(instance, async (store) => {
			const report = await store.subjectReport(email);
			if (!report.userId) {
				console.log(`${name}: no account for ${email}.`);
				return 0;
			}
			found += 1;
			console.log(`${name}: ${email} — ${report.mailboxIds.length} mailbox(es)\n`);
			for (const line of subjectLines(report)) console.log(line);
			const total = subjectTotal(report);
			console.log(`\n  ${total} row(s) in ${report.counts.filter((count) => count.rows > 0).length} table(s)`);
			const unknown = subjectUnknown(report);
			if (unknown.length > 0) {
				console.log(`  cannot be attributed to anyone (no user or owner column): ${unknown.join(", ")}`);
				sourceChangeNeeded(SOURCE_CHANGES[1]);
			}
			for (const blocker of report.blockers) console.log(`  ! cannot be erased: ${blocker}`);
			if (!erase || report.blockers.length > 0) return 1;

			const result = await store.eraseSubject(email);
			console.log(`\n  ✓ erased ${result.email}: ${subjectTotal({ ...report, counts: result.deleted })} row(s), ${result.objectsDeleted}/${result.objectKeys.length} object(s)`);
			// Their login goes from the credentials folder too.
			deps.vault(name).forgetLogin(email);
			sourceChangeNeeded(SOURCE_CHANGES[0]);
			const left = (await store.subjectReport(email)).userId !== null || result.objectsDeleted < result.objectKeys.length;
			if (left) console.log("  ✗ something of theirs is still there");
			return left ? 1 : 0;
		}).catch((error) => {
			console.error(`${name}: ${message(error)}`);
			return 1;
		}));
	}
	if (action === "destroy" && !flags.confirmDestroy && found > 0) console.log("\nNothing was erased. Re-run with --confirm-destroy to erase it.");
	return code;
}

// `apply` builds a server that does not exist. This rolls the CODE - and whatever wrangler.jsonc
// now binds - out to the ones that do: one at a time, since builds share an output folder.
async function deploy(cli: Cli, projects: Project[]): Promise<number> {
	const template = liveDeps().template();
	const results: Array<[string, boolean]> = [];
	for (const project of projects) {
		const server = project.server;
		if (!server || server.local || server.template) continue;
		const { deployment } = resolveInstance(project, cli, template);
		results.push([server.name, !!deployment && !!(await deployServer(server, deployment, { base: project.dir, dryRun: false, print: console.log, template }))]);
	}
	console.log("\n──────── summary");
	for (const [name, ok] of results) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
	console.log(`\n${results.filter(([, ok]) => ok).length}/${results.length} server(s) deployed`);
	return results.every(([, ok]) => ok) ? 0 : 1;
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
		if (command.kind === "subject") return await subject(cli, command.email, command.action);
		if (command.kind === "router") return await router(loadProjects(cli.dir), cli.flags, cli.router);
		if (command.kind === "deploy") return await deploy(cli, projectsFor(command.target, cli.dir));
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
