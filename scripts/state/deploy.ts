// Deploying a SERVER. Deliberately thin: it shells the repo's own deploy path
// (`npm run build`, then `npm run deploy:worker -- --env <name>`) and then records the
// server in the fleet so the rest of this system can reach it.
//
// It creates no cloud resources. Creating a D1, a bucket or a queue, and recovering from a
// half-finished attempt, is wrangler's job - and inventing a database_id would be worse
// than stopping. The `env.<name>` block in wrangler.jsonc is the source of truth, and it is
// the thing a human must add.
import { readFileSync, writeFileSync } from "node:fs";
import { FLEET_PATH, loadFleet, type InstanceDecl } from "./document";
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
	const block = envBlockFor(readWranglerConfig(), name);
	if (!block) {
		console.error(`No env.${name} in ${WRANGLER_PATH} — there is no server called "${name}" to deploy.`);
		console.error(`Add an env.${name} block (its own name, d1 database_id, r2 bucket and queues), then re-run.`);
		console.error("This system does not create cloud resources: that is wrangler's job.");
		return 1;
	}

	const database = db ?? block.databaseName ?? name;
	if (dryRun) {
		console.log(`Would deploy the server "${name}":\n`);
		console.log(`  1. npm run build`);
		console.log(`  2. npm run deploy:worker -- --env ${name}`);
		console.log(`  3. register it in ${FLEET_PATH} as { name: "${name}", db: "${database}" }`);
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
	writeFileSync(FLEET_PATH, `${JSON.stringify({ instances: upsertInstance(loadFleet(), { name, db: database, ...(origin ? { url: origin } : {}) }) }, null, 2)}\n`);

	console.log(`\n✓ deployed "${name}" and registered it in ${FLEET_PATH}`);
	if (!origin) console.log("  ⚠ no origin recorded (no Cloudflare credentials) — pass --url, or set MAILFLARE_URL");
	console.log(`\nNext: npm run state -- --fresh --instance ${name}`);
	return 0;
}
