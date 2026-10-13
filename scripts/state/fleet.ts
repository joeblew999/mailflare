// Running MANY servers: each project against its own instance, with one shared limit on how
// much is in flight. Everything outside is injected, so the whole thing runs in a unit test.
import { deployServer, destroyServer, place, serverDrift, type Placed } from "./deploy";
import { LOCAL_URL, type Cli } from "./args";
import { limiter, runDocuments, type DocResult, type Limiter } from "./runner";
import { deploymentFor, message, readWranglerConfig, warmUp, writeServerConfig, type Deployment, type WranglerConfig } from "./wrangler";
import { withStore, type OpenStore } from "./app";
import { fileVault, type Vault } from "./vault";
import type { Project } from "./document";
import type { Server } from "./spec";
import type { Instance } from "./store/live";

export type FleetDeps = {
	openStore: OpenStore;
	/** wrangler.jsonc: the default server, and the template for every other. */
	template(): WranglerConfig;
	/** Write a server's generated config, so wrangler can reach it. */
	writeConfig(template: WranglerConfig, deployment: Deployment): void;
	deploy: typeof deployServer;
	undeploy: typeof destroyServer;
	/** How a deployed server differs from its document in what only a deploy can change. */
	serverDrift: typeof serverDrift;
	/** Is the server answering from its country? And, when asked to, move it until it is. */
	place(server: Server, deployment: Deployment, origin: string, options: { fix: boolean }): Promise<Placed>;
	/** Called once before a parallel run reaches for anything deployed. */
	warmUp(): Promise<void>;
	vault(project: string): Vault;
	print(text: string): void;
};

export const liveDeps = (credentials?: string): FleetDeps => ({
	openStore: withStore,
	template: readWranglerConfig,
	writeConfig: writeServerConfig,
	deploy: deployServer,
	undeploy: destroyServer,
	serverDrift,
	place,
	warmUp,
	vault: (project) => fileVault(project, credentials),
	print: console.log,
});

type Run = Pick<Cli, "flags" | "concurrency" | "explicit">;
export type Resolved = { instance: Instance; deployment: Deployment | null };

/** Where a project runs. A typed flag wins over the server document, and the document over wrangler.jsonc. */
export function resolveInstance(project: Project, { flags, explicit }: Run, template: WranglerConfig): Resolved {
	const server = project.server;
	// A bare document has no server of its own: it is for the default one.
	const deployment = deploymentFor(template, server ?? { name: template.name ?? "mailflare" });
	if (flags.local || server?.local) {
		const top = deploymentFor(template, { name: template.name ?? "mailflare" });
		return {
			deployment: null,
			// --local on a deployed server's project means the dev instance, never its recorded origin.
			instance: { db: explicit.db ? flags.db : (server?.local ? server.db : undefined) ?? top.database, local: true, url: explicit.url ? flags.url : (server?.local ? server.url : undefined) ?? process.env.MAILFLARE_URL ?? LOCAL_URL, bucket: top.bucket },
		};
	}
	return {
		deployment,
		instance: { db: explicit.db ? flags.db : deployment.database, local: false, config: deployment.config, url: explicit.url ? flags.url : server?.url, worker: deployment.worker, bucket: deployment.bucket, jurisdiction: deployment.jurisdiction },
	};
}

export type ProjectResult = { name: string; documents: DocResult[]; error?: string; /** The server itself differs from its document, and a plan does not deploy. */ server?: string };

async function runProject(project: Project, run: Run, deps: FleetDeps, limit: Limiter, building: Limiter, buffered: boolean): Promise<ProjectResult> {
	const { flags } = run;
	const pending = (): DocResult[] => project.entries.map((entry) => ({ name: entry.name, ok: false, pending: flags.status }));
	try {
		const template = deps.template();
		let { instance, deployment } = resolveInstance(project, run, template);
		const server = project.server;
		const options = { base: project.dir, dryRun: flags.status, print: deps.print, template };
		if (server?.template && !flags.status) throw new Error(`"${server.name}" is a template: copy the folder, name it after the server, and remove "template" from its server.json`);

		// A server with no recorded origin has not been deployed. Deploying one is part of
		// applying its project, and there is nothing on it to plan against or to destroy.
		if (server && deployment && !instance.url) {
			if (flags.cleanup) {
				deps.print(`\n"${server.name}" is not deployed (its server.json has no url) — nothing to destroy.`);
				return { name: project.name, documents: project.entries.map((entry) => ({ name: entry.name, ok: true })) };
			}
			const deployed = await building(() => deps.deploy(server, deployment!, options));
			if (!deployed) return flags.status ? { name: project.name, documents: pending() } : { name: project.name, documents: pending(), error: "the deploy failed" };
			({ instance, deployment } = resolveInstance({ ...project, server: deployed }, run, template));
		}
		// A server's own document is reconciled too: where it runs and what it is told can only be
		// changed by deploying it again.
		let differs: string | undefined;
		if (server && deployment && instance.url && !flags.cleanup) {
			const drift = await deps.serverDrift(deployment);
			if (drift.length > 0) {
				deps.print(`\n~ server ${server.name}: ${drift.join("; ")}${flags.status ? " — apply deploys it again" : ""}`);
				if (flags.status) differs = drift.join("; ");
				else if (!(await building(() => deps.deploy(server, deployment!, options)))) return { name: project.name, documents: pending(), error: "the deploy failed" };
			}
		}
		if (deployment) deps.writeConfig(template, deployment);
		// Where it runs is checked as a fact, not as a setting: Cloudflare stops honouring a
		// placement for a while now and then, and the server is moved to another name for its country.
		if (server && deployment && instance.url && !instance.local && !flags.cleanup) {
			const placed = await deps.place(server, deployment, instance.url, { fix: !flags.status });
			if (placed.said) deps.print(`\n~ server ${server.name}: ${placed.said}`);
			if (!placed.ok) differs = [differs, placed.said].filter(Boolean).join("; ");
		}

		const vault = deps.vault(server?.name ?? "documents");
		if (instance.url) vault.at(instance.url);
		const documents = await deps.openStore(instance, (store) => runDocuments(store, flags, project.entries, { limit, print: deps.print, buffered, vault, complete: project.complete }));
		// The teardown finishes with the server, so the tenants are gone before the Worker is.
		if (flags.cleanup && server && deployment && documents.every((result) => result.ok || flags.status)) {
			if (!(await deps.undeploy(server, deployment, options))) return { name: project.name, documents, error: "the Worker could not be removed" };
		}
		return { name: project.name, documents, server: differs };
	} catch (error) {
		return { name: project.name, documents: pending().map((document) => ({ ...document, pending: false })), error: message(error) };
	}
}

/** Reconcile every project, each on its own server, and say what happened to each document. */
export async function reconcile(projects: Project[], run: Run, deps: FleetDeps = liveDeps()): Promise<ProjectResult[]> {
	const { flags, concurrency } = run;
	const limit = limiter(concurrency);
	// One build is every server's (deploy.ts), so deploys are uploads and run side by side.
	const building = limiter(concurrency);
	const results: ProjectResult[] = [];
	if (concurrency === 1) for (const project of projects) results.push(await runProject(project, run, deps, limit, building, false));
	else if (projects.some((project) => !project.server?.local) && !flags.local) await deps.warmUp();
	if (concurrency > 1) results.push(...(await Promise.all(projects.map((project) => runProject(project, run, deps, limit, building, true)))));
	return results;
}

/** Reconcile every project and report. Returns 0 when all of them are as wanted. */
export async function runFleet(projects: Project[], run: Run, deps: FleetDeps = liveDeps()): Promise<number> {
	const { flags, concurrency } = run;
	const doing = flags.cleanup ? "Destroying" : flags.fresh ? "Resetting" : flags.status ? "Planning" : "Applying";
	const documents = projects.reduce((sum, project) => sum + project.entries.length, 0);
	const preview = flags.status && (flags.cleanup || flags.fresh);
	deps.print(`${preview ? `${doing} (a preview — nothing is written)` : doing}: ${documents} document(s) on ${projects.length} server(s)${concurrency > 1 ? `, ${concurrency} at a time` : ""}`);
	const results = await reconcile(projects, run, deps);

	deps.print("\n──────── summary");
	let ok = 0;
	let total = 0;
	for (const result of results) {
		if (result.error) deps.print(`  ✗ ${result.name}: ${result.error}`);
		if (result.server) deps.print(`  ~ ${result.name}: the server itself  (${result.server})`);
		for (const document of result.documents) {
			total += 1;
			const good = document.ok && !result.error;
			if (good) ok += 1;
			// In a preview, work left to do is not a failure.
			const waiting = document.pending && !result.error;
			deps.print(`  ${good ? "✓" : waiting ? "~" : "✗"} ${document.name}${waiting ? "  (changes to make)" : ""}`);
		}
	}
	deps.print(`\n${ok}/${total} document(s) ${flags.status ? (flags.cleanup ? "already gone" : "reconciled") : "ok"}`);
	if (preview) deps.print(`\nNothing was changed. Re-run with --confirm-destroy to ${flags.cleanup ? "destroy" : "reset"}.`);
	// An apply makes and changes things on its own word; taking things away needs yours.
	if (!flags.status && results.some((result) => result.documents.some((document) => document.pending))) {
		deps.print("\nSome things on the servers are in no document, and were left in place.\nRe-run with --confirm-destroy to remove them, or add them to the documents.");
	}
	return ok === total && results.every((result) => !result.error && !result.server) ? 0 : 1;
}

/** The instances a subject is looked for on: every server once, by database. */
export function subjectInstances(projects: Project[], run: Run, template: WranglerConfig): Array<{ name: string; instance: Instance }> {
	const seen = new Set<string>();
	const found: Array<{ name: string; instance: Instance }> = [];
	for (const project of projects) {
		const { instance, deployment } = resolveInstance(project, run, template);
		const key = `${instance.local ? "local" : instance.config}:${instance.db}`;
		if (!seen.has(key) && (instance.local || instance.url || !project.server)) {
			if (deployment) writeServerConfig(template, deployment);
			found.push({ name: project.server?.name ?? project.name, instance });
		}
		seen.add(key);
	}
	return found;
}
