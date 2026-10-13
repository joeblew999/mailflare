// Deploying a SERVER. Deliberately thin: it shells the repo's own deploy path
// (`npm run build`, then `npm run deploy:worker -- --env <name>`) and then records the
// server in the fleet so the rest of this system can reach it.
//
// It creates no cloud resources. Creating a D1, a bucket or a queue, and recovering from a
// half-finished attempt, is wrangler's job - and inventing a database_id would be worse
// than stopping. The `env.<name>` block in wrangler.jsonc is the source of truth, and it is
// the thing a human must add.
import { readFileSync } from "node:fs";
import { loadServer, saveServer, serverDocPath, type InstanceDecl } from "./document";
import { resolveInstanceUrl, run } from "./wrangler";

const WRANGLER_PATH = "wrangler.jsonc";

// wrangler.jsonc is JSONC: comments and trailing commas are legal, JSON.parse is not.
export function stripJsonc(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/,(\s*[}\]])/g, "$1");
}

/** Only the parts of wrangler.jsonc this module reads. */
export type WranglerConfig = {
	name?: string;
	env?: Record<string, { name?: string; d1_databases?: Array<{ database_name?: string }> }>;
};

export function readWranglerConfig(path = WRANGLER_PATH): WranglerConfig {
	return JSON.parse(stripJsonc(readFileSync(path, "utf8")));
}

/** The server's env block, or null when it has not been declared. */
export function envBlockFor(config: WranglerConfig, name: string): { databaseName?: string } | null {
	const block = config?.env?.[name];
	if (!block) return null;
	return { databaseName: block.d1_databases?.[0]?.database_name };
}

/** Register or update a server in the fleet, keeping it sorted and duplicate-free. */
export function upsertInstance(fleet: InstanceDecl[], entry: InstanceDecl): InstanceDecl[] {
	return [...fleet.filter((instance) => instance.name !== entry.name), entry].sort((a, b) => a.name.localeCompare(b.name));
}

export async function deployServer({ name, dryRun, url, db }: { name: string; dryRun: boolean; url?: string; db?: string }): Promise<number> {
	const server = loadServer(name); // throws when the project folder has no server.json
	const block = envBlockFor(readWranglerConfig(), name);
	if (!block) {
		console.error(`No env.${name} in ${WRANGLER_PATH} — there is nothing to deploy for "${name}".`);
		console.error(`Add an env.${name} block to ${WRANGLER_PATH}, alongside the top-level one:`);
		console.error(`  "env": { "${name}": { "name": "${name}", "d1_databases": [ { "binding": "DB", "database_name": "${server.db ?? name}", "database_id": "<its own id>" } ] } }`);
		console.error("This system does not create cloud resources, and will not invent a database_id: that is wrangler's job.");
		return 1;
	}
	// The folder and the env block must agree, or the deploy would target the wrong database.
	if (server.db && block.databaseName && server.db !== block.databaseName) {
		console.error(`"${name}" disagrees with itself: ${serverDocPath(name)} says db "${server.db}", ${WRANGLER_PATH} says "${block.databaseName}".`);
		return 1;
	}

	const database = db ?? block.databaseName ?? server.db ?? name;
	if (dryRun) {
		console.log(`Would deploy the server "${name}":\n`);
		console.log(`  1. npm run build`);
		console.log(`  2. npm run deploy:worker -- --env ${name}`);
		console.log(`  3. record its origin in ${serverDocPath(name)} (database ${database})`);
		console.log(`\n  then: npm run state -- --fresh --instance ${name}`);
		return 0;
	}

	const built = run("npm", ["run", "build"]);
	if (built.status !== 0) {
		console.error(built.stderr || built.stdout || "the build failed");
		return 1;
	}
	const deployed = run("npm", ["run", "deploy:worker", "--", "--env", name]);
	if (deployed.status !== 0) {
		console.error(deployed.stderr || deployed.stdout || "the deploy failed");
		return 1;
	}

	// The origin, so `--instance <name>` needs no --url. Deriving it needs Cloudflare
	// credentials; without them the entry is still registered, just without an origin.
	const origin = url ?? (await resolveInstanceUrl({ worker: name })) ?? undefined;
	if (origin) saveServer(name, { url: origin });
	console.log(`\n✓ deployed "${name}"${origin ? ` and recorded its origin in ${serverDocPath(name)}` : ""}`);
	if (!origin) console.log("  ⚠ no origin recorded (no Cloudflare credentials) — pass --url, or set MAILFLARE_URL");
	console.log(`\nNext: npm run state -- --fresh --instance ${name}`);
	return 0;
}

/**
 * The inverse of deploy, and deliberately NOT symmetric in what it deletes. It removes the
 * Worker; it does not remove the database, bucket or queues, because this system does not
 * create those either, and destroying data is a decision rather than a cleanup.
 */
export async function destroyServer({ name, dryRun, confirmed }: { name: string; dryRun: boolean; confirmed: boolean }): Promise<number> {
	const server = loadServer(name);
	console.log(`Destroying the server "${name}" (database ${server.db ?? "unset"}):\n`);
	console.log(`  1. npx wrangler delete --env ${name}          removes the Worker`);
	console.log(`  2. ${serverDocPath(name)} loses its origin     deregisters it from the fleet`);
	console.log(`  3. NOT removed: the database, bucket and queues — delete them with wrangler`);
	console.log(`     (wrangler d1 delete ${server.db ?? "<db>"}, wrangler r2 bucket delete <bucket>, wrangler queues delete <queue>)`);

	if (dryRun || !confirmed) {
		if (!confirmed) console.log("\nRe-run with --confirm-destroy to do steps 1 and 2.");
		return 0;
	}
	const deleted = run("npx", ["wrangler", "delete", "--env", name]);
	if (deleted.status !== 0) {
		console.error(deleted.stderr || deleted.stdout || "wrangler delete failed");
		return 1;
	}
	saveServer(name, { url: undefined });
	console.log(`\n✓ "${name}" undeployed and deregistered. Its folder and documents are untouched.`);
	return 0;
}
