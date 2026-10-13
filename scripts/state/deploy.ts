// Bringing a SERVER into being, and taking it away: its database, bucket and queues in the
// jurisdiction it declares, its Worker, its secrets and its schema. Everything is idempotent,
// so a deploy that stopped half way is finished by running it again.
import { rmSync } from "node:fs";
import { saveServer, serverDocPath } from "./document";
import { applyMigrations, cfApi, credential, resolveInstanceUrl, run, sleep, wrangler, writeServerConfig, type Deployment, type WranglerConfig } from "./wrangler";
import type { Server } from "./spec";

export type DeployOptions = { base: string; dryRun: boolean; print: (text: string) => void; template: WranglerConfig };

// What a Worker needs that a config file must not hold. Each is read here by name (environment,
// then keychain) and put on the server. Only CF_TOKEN is required: the app manages DNS with it.
export const SERVER_SECRETS = ["CF_TOKEN", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "GITHUB_UPDATE_TOKEN", "GITHUB_UPDATE_REPO"];
const secretValue = (name: string) => credential(name) ?? (name === "CF_TOKEN" ? credential("CLOUDFLARE_API_TOKEN") : null);
/** The secrets a server is given. One that does not manage DNS is never given a Cloudflare token. */
export const secretsFor = (server: Server) => SERVER_SECRETS.filter((name) => name !== "CF_TOKEN" || server.managesDns !== false);

/** The steps that deploy a server, as text. The Vite plugin picks the config at BUILD time. */
export function deploySteps(server: Server, deployment: Deployment): string[] {
	const where = server.jurisdiction ? ` in jurisdiction ${server.jurisdiction}` : server.region ? ` near ${server.region}` : "";
	if (!deployment.generated) return ["npm run deploy", `apply the migrations to ${deployment.database}`];
	return [
		`create the database ${deployment.database}${where}`,
		`create the bucket ${deployment.bucket}${server.jurisdiction ? ` in jurisdiction ${server.jurisdiction}` : ""}`,
		`create the queues ${deployment.queues.join(", ")}`,
		`MAILFLARE_WRANGLER_CONFIG=${deployment.config} npm run build`,
		"npm run deploy:worker",
		`put the secrets ${secretsFor(server).filter((name) => secretValue(name)).join(", ") || "(none found)"}${server.managesDns === false ? " — and no Cloudflare token" : ""}`,
		`apply the migrations to ${deployment.database}`,
	];
}

/** What Cloudflare says a deployed Worker is told and where it is placed. Null when it cannot be asked. */
export async function workerSettings(worker: string): Promise<{ vars: Record<string, string | undefined>; secrets: string[]; placement: string | null } | null> {
	const token = credential("CLOUDFLARE_API_TOKEN");
	const account = credential("CLOUDFLARE_ACCOUNT_ID");
	if (!token || !account) return null;
	type Settings = { bindings?: Array<{ type: string; name: string; text?: string }> };
	// The settings name a placement only by an id; the service says which region that id is.
	type Service = { default_environment?: { script?: { placement?: { target?: Array<{ region?: string }> } } } };
	const settings = (await cfApi<Settings>(`/accounts/${account}/workers/scripts/${worker}/settings`, token))?.result;
	if (!settings) return null;
	const service = (await cfApi<Service>(`/accounts/${account}/workers/services/${worker}`, token))?.result;
	const bindings = settings.bindings ?? [];
	return { vars: Object.fromEntries(bindings.filter((binding) => binding.type === "plain_text").map((binding) => [binding.name, binding.text])), secrets: bindings.filter((binding) => binding.type === "secret_text").map((binding) => binding.name), placement: service?.default_environment?.script?.placement?.target?.[0]?.region ?? null };
}

/**
 * How a deployed server differs from its document in what only a DEPLOY can change: where it
 * runs, and what it is told about itself. Empty when it matches, or when Cloudflare cannot be asked.
 */
export async function serverDrift(deployment: Deployment): Promise<string[]> {
	if (!deployment.generated) return [];
	const settings = await workerSettings(deployment.worker);
	if (!settings) return [];
	const anywhere = "wherever a request arrives";
	return [
		...(settings.placement !== (deployment.placement ?? null) ? [`it runs ${settings.placement ? `beside ${settings.placement}` : anywhere}, not ${deployment.placement ? `beside ${deployment.placement}` : anywhere}`] : []),
		...((settings.vars.MAILFLARE_JURISDICTION ?? null) !== (deployment.jurisdiction ?? null) ? [`it is told its jurisdiction is ${settings.vars.MAILFLARE_JURISDICTION ?? "none"}, not ${deployment.jurisdiction ?? "none"}`] : []),
		...(settings.vars.MAILFLARE_WORKER_NAME !== deployment.worker ? ["it is not told its own name"] : []),
	];
}

const exists = (text: string) => /already exists|already own|already taken|already been taken|is taken/i.test(text);

/** The database's id by name, or null when there is no such database. */
async function databaseId(name: string): Promise<string | null> {
	const listed = await wrangler(["d1", "list", "--json"]);
	if (listed.status !== 0) throw new Error(`could not list databases: ${(listed.stderr || listed.stdout).trim()}`);
	const found = (JSON.parse(listed.stdout) as Array<{ name: string; uuid: string }>).find((database) => database.name === name);
	return found?.uuid ?? null;
}

/** Create what the server is made of. Returns the database id. Safe to run again. */
async function provision(server: Server, deployment: Deployment, print: (text: string) => void): Promise<string> {
	let id = deployment.databaseId ?? (await databaseId(deployment.database));
	if (!id) {
		// A jurisdiction is a guarantee and a region only a hint, which Cloudflare ignores beside one.
		const where = server.jurisdiction ? ["--jurisdiction", server.jurisdiction] : server.region ? ["--location", server.region] : [];
		const made = await wrangler(["d1", "create", deployment.database, ...where]);
		if (made.status !== 0) throw new Error(`could not create the database ${deployment.database}: ${(made.stderr || made.stdout).trim()}`);
		id = /"database_id":\s*"([0-9a-f-]{36})"/.exec(made.stdout)?.[1] ?? (await databaseId(deployment.database));
		if (!id) throw new Error(`created the database ${deployment.database}, but could not learn its id`);
		print(`  + database ${deployment.database}${server.jurisdiction ? ` (jurisdiction ${server.jurisdiction})` : ""}`);
	}
	const bucket = await wrangler(["r2", "bucket", "create", deployment.bucket, ...(server.jurisdiction ? ["--jurisdiction", server.jurisdiction] : server.region ? ["--location", server.region] : [])]);
	if (bucket.status !== 0 && !exists(bucket.stderr + bucket.stdout)) throw new Error(`could not create the bucket ${deployment.bucket}: ${(bucket.stderr || bucket.stdout).trim()}`);
	if (bucket.status === 0) print(`  + bucket ${deployment.bucket}${server.jurisdiction ? ` (jurisdiction ${server.jurisdiction})` : ""}`);
	for (const queue of deployment.queues) {
		const made = await wrangler(["queues", "create", queue]);
		if (made.status !== 0 && !exists(made.stderr + made.stdout)) throw new Error(`could not create the queue ${queue}: ${(made.stderr || made.stdout).trim()}`);
		if (made.status === 0) print(`  + queue ${queue}`);
	}
	return id;
}

/** Put the secrets the Worker lacks. Values go in on stdin, never on a command line. */
async function putSecrets(server: Server, deployment: Deployment, print: (text: string) => void): Promise<void> {
	const managesDns = server.managesDns !== false;
	if (managesDns && !secretValue("CF_TOKEN")) throw new Error("no CF_TOKEN (or CLOUDFLARE_API_TOKEN) in the environment or keychain — the server needs one to manage DNS and Email Routing");
	const listed = await wrangler(["secret", "list"], { config: deployment.config });
	const present: string[] = listed.status === 0 ? JSON.parse(listed.stdout).map((entry: { name: string }) => entry.name) : [];
	// "Never touches a zone" is a promise, so a token left over from before is taken away.
	if (!managesDns && present.includes("CF_TOKEN")) {
		const removed = await wrangler(["secret", "delete", "CF_TOKEN"], { config: deployment.config, input: "y\n" });
		if (removed.status !== 0) throw new Error(`could not remove CF_TOKEN from a server that must not manage DNS: ${(removed.stderr || removed.stdout).trim()}`);
		print("  - secret CF_TOKEN");
	}
	for (const name of secretsFor(server)) {
		const value = secretValue(name);
		if (!value || present.includes(name)) continue;
		const put = await wrangler(["secret", "put", name], { config: deployment.config, input: value });
		if (put.status !== 0) throw new Error(`could not put the secret ${name}: ${(put.stderr || put.stdout).trim()}`);
		print(`  + secret ${name}`);
	}
}

/** Provision, build, deploy, migrate, and record what was learned. Returns the server as it now is, or null. */
export async function deployServer(server: Server, deployment: Deployment, { base, dryRun, print, template }: DeployOptions): Promise<Server | null> {
	if (dryRun) {
		print(`\nWould deploy the server "${server.name}":\n`);
		deploySteps(server, deployment).forEach((step, index) => print(`  ${index + 1}. ${step}`));
		print(`  ${deploySteps(server, deployment).length + 1}. record its origin in ${serverDocPath(server.name, base)}`);
		return null;
	}

	print(`\nDeploying the server "${server.name}"…`);
	let current = server;
	try {
		let live = deployment;
		if (deployment.generated) {
			const id = await provision(server, deployment, print);
			if (id !== server.databaseId) current = saveServer(server.name, { databaseId: id }, base);
			live = { ...deployment, databaseId: id };
			writeServerConfig(template, live);
		}
		const steps: Array<[string[], Record<string, string>?]> = live.generated
			? [[["run", "build"], { MAILFLARE_WRANGLER_CONFIG: live.config }], [["run", "deploy:worker"]]]
			: [[["run", "deploy"]]];
		for (const [args, env] of steps) {
			const result = await run("npm", args, { env, inherit: true });
			if (result.status !== 0) throw new Error(`npm ${args.join(" ")} failed`);
		}
		// The build left a redirect to THIS server's config; a later bare `wrangler` must not follow it.
		if (live.generated) rmSync(".wrangler/deploy/config.json", { force: true });
		if (live.generated) await putSecrets(server, live, print);
		await applyMigrations({ db: live.database, local: false, config: live.config });

		// Deriving the origin needs Cloudflare credentials; a custom domain goes in server.json by hand.
		const origin = server.url ?? (await resolveInstanceUrl({ worker: live.worker }));
		if (!origin) throw new Error(`deployed, but its origin is unknown — add "url" to ${serverDocPath(server.name, base)}`);
		// A new Worker takes a moment to answer on its address.
		for (let attempt = 0; attempt < 30; attempt += 1) {
			const response = await fetch(origin, { redirect: "manual" }).catch(() => null);
			if (response && response.status < 500 && response.status !== 404) break;
			await sleep(2000);
		}
		current = saveServer(server.name, { url: origin }, base);
		print(`  ✓ "${server.name}" is at ${origin}, recorded in ${serverDocPath(server.name, base)}`);
		return current;
	} catch (error) {
		print(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

/**
 * The inverse of deploy, and deliberately NOT symmetric in what it deletes. It removes the
 * Worker; the database, bucket and queues stay, because destroying data is a decision.
 */
export async function destroyServer(server: Server, deployment: Deployment, { base, dryRun, print }: DeployOptions): Promise<boolean> {
	if (dryRun) {
		print(`\nWould remove the server "${server.name}":\n`);
		print(`  1. detach it from its queues, then npx wrangler delete --config ${deployment.config}    removes the Worker`);
		print(`  2. ${serverDocPath(server.name, base)} loses its url`);
		print(`  Kept: the database ${deployment.database}, the bucket ${deployment.bucket} and the queues — delete those with wrangler.`);
		return true;
	}
	// Cloudflare refuses to delete a Worker that still consumes a queue, so it is detached first.
	// The queues stay; the next deploy attaches it again.
	for (const queue of deployment.queues) {
		const detached = await wrangler(["queues", "consumer", "remove", queue, deployment.worker], { config: deployment.config });
		if (detached.status !== 0 && !/no worker consumer|not a consumer|does not exist|not found|10064|11004/i.test(detached.stderr + detached.stdout)) {
			print(`  ✗ could not detach ${deployment.worker} from the queue ${queue}: ${(detached.stderr || detached.stdout).trim()}`);
			return false;
		}
	}
	const deleted = await wrangler(["delete"], { config: deployment.config });
	if (deleted.status !== 0) {
		print(`  ✗ wrangler delete failed: ${(deleted.stderr || deleted.stdout).trim()}`);
		return false;
	}
	saveServer(server.name, { url: undefined }, base);
	print(`\n✓ removed the Worker "${deployment.worker}". Kept: the database ${deployment.database}, the bucket ${deployment.bucket}, the queues, and the documents.`);
	return true;
}
