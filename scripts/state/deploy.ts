// Bringing a SERVER into being, and taking it away: its database, bucket and queues in the
// jurisdiction it declares, its Worker, its secrets and its schema. Everything is idempotent,
// so a deploy that stopped half way is finished by running it again.
import { rmSync } from "node:fs";
import { answeredFrom } from "./colos";
import { saveServer, serverDocPath } from "./document";
import { BUILT_CONFIG, applyMigrations, cfApi, credential, resolveInstanceUrl, run, sleep, timed, wrangler, writeBuiltConfig, writeServerConfig, type Deployment, type WranglerConfig } from "./wrangler";
import type { Server } from "./spec";

export type DeployOptions = { base: string; dryRun: boolean; print: (text: string) => void; template: WranglerConfig };

// What a Worker needs that a config file must not hold. Each is read here by name (environment,
// then keychain) and put on the server. Only CF_TOKEN is required: the app manages DNS with it.
export const SERVER_SECRETS = ["CF_TOKEN", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "GITHUB_UPDATE_TOKEN", "GITHUB_UPDATE_REPO"];
const secretValue = (name: string) => credential(name) ?? (name === "CF_TOKEN" ? credential("CLOUDFLARE_API_TOKEN") : null);
/** The secrets a server is given. One that does not manage DNS is never given a Cloudflare token. */
export const secretsFor = (server: Server) => SERVER_SECRETS.filter((name) => name !== "CF_TOKEN" || server.managesDns !== false);

/** The steps that deploy a server, as text. The build is one for the whole run, whatever the number of servers. */
export function deploySteps(server: Server, deployment: Deployment): string[] {
	const where = server.jurisdiction ? ` in jurisdiction ${server.jurisdiction}` : server.region ? ` near ${server.region}` : "";
	const upload = `npx wrangler deploy --config ${BUILT_CONFIG.replace(/wrangler\.json$/, deployment.generated ? `wrangler.${deployment.worker}.json` : "wrangler.json")}`;
	if (!deployment.generated) return ["npm run build", upload, `apply the migrations to ${deployment.database}`];
	return [
		`create the database ${deployment.database}${where}`,
		`create the bucket ${deployment.bucket}${server.jurisdiction ? ` in jurisdiction ${server.jurisdiction}` : ""}`,
		`create the queues ${deployment.queues.join(", ")}`,
		"npm run build    (once, for every server in the run)",
		`${upload}${deployment.placement ? `    placed beside ${deployment.placement}` : ""}`,
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
 * Where Cloudflare says a database is kept. A failure to ask is an error, never "nowhere":
 * reading an unanswered question as "not pinned" would fail a server that is where it should be.
 */
export async function databasePlace(deployment: Deployment): Promise<{ jurisdiction: string | null; region: string | null }> {
	const token = credential("CLOUDFLARE_API_TOKEN");
	const account = credential("CLOUDFLARE_ACCOUNT_ID");
	if (token && account && deployment.databaseId) {
		const info = (await cfApi<{ jurisdiction?: string | null; running_in_region?: string | null }>(`/accounts/${account}/d1/database/${deployment.databaseId}`, token))?.result;
		if (info) return { jurisdiction: info.jurisdiction ?? null, region: info.running_in_region ?? null };
	}
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const said = await wrangler(["d1", "info", deployment.database], { config: deployment.config });
		const field = (name: string) => new RegExp(`${name}\\s*│\\s*([A-Za-z]+)`).exec(said.stdout)?.[1] ?? null;
		// An unpinned database is reported as the word "null".
		if (said.status === 0 && /jurisdiction\s*│/.test(said.stdout)) return { jurisdiction: field("jurisdiction") === "null" ? null : field("jurisdiction"), region: field("running_in_region") };
		await sleep(2000);
	}
	throw new Error(`Cloudflare could not be asked about the database ${deployment.database}`);
}

/** Is the server's bucket there, in the jurisdiction it declares? Asked of the API, else of wrangler. */
export async function bucketIsThere(deployment: Deployment): Promise<boolean> {
	const token = credential("CLOUDFLARE_API_TOKEN");
	const account = credential("CLOUDFLARE_ACCOUNT_ID");
	if (token && account) {
		const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${deployment.bucket}`, { headers: { Authorization: `Bearer ${token}`, ...(deployment.jurisdiction ? { "cf-r2-jurisdiction": deployment.jurisdiction } : {}) }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
		if (response && (response.ok || response.status === 404)) return response.ok;
	}
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const listed = await wrangler(["r2", "bucket", "list", ...(deployment.jurisdiction ? ["--jurisdiction", deployment.jurisdiction] : [])], { config: deployment.config });
		if (listed.status === 0) return listed.stdout.includes(deployment.bucket);
		await sleep(2000);
	}
	throw new Error(`Cloudflare could not be asked about the bucket ${deployment.bucket}`);
}

/**
 * How a deployed server differs from its document in what only a DEPLOY can change: what it is
 * told about itself, and a placement it should not have. (One it should have is `place`'s: that
 * is a setting, changed without a deploy.) Empty when it matches, or when Cloudflare cannot be asked.
 */
export async function serverDrift(deployment: Deployment): Promise<string[]> {
	if (!deployment.generated) return [];
	const settings = await workerSettings(deployment.worker);
	if (!settings) return [];
	return [
		...(settings.placement && deployment.placements.length === 0 ? [`it runs beside ${settings.placement}, not wherever a request arrives`] : []),
		...((settings.vars.MAILFLARE_JURISDICTION ?? null) !== (deployment.jurisdiction ?? null) ? [`it is told its jurisdiction is ${settings.vars.MAILFLARE_JURISDICTION ?? "none"}, not ${deployment.jurisdiction ?? "none"}`] : []),
		...(settings.vars.MAILFLARE_WORKER_NAME !== deployment.worker ? ["it is not told its own name"] : []),
	];
}

/** Move a deployed Worker beside another cloud region: one call, and no upload. */
export async function setPlacement(worker: string, region: string): Promise<void> {
	const token = credential("CLOUDFLARE_API_TOKEN");
	const account = credential("CLOUDFLARE_ACCOUNT_ID");
	if (!token || !account) throw new Error("moving a Worker needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID");
	const form = new FormData();
	form.set("settings", new Blob([JSON.stringify({ placement: { mode: "targeted", region } })], { type: "application/json" }));
	const response = await timed("cloudflare api", `PATCH /workers/scripts/${worker}/settings (placement ${region})`, () => fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/settings`, { method: "PATCH", headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(60_000) }));
	if (!response.ok) throw new Error(`could not place ${worker} beside ${region}: ${((await response.json().catch(() => null)) as { errors?: Array<{ message?: string }> } | null)?.errors?.[0]?.message ?? `HTTP ${response.status}`}`);
}

/** What `place` asks and does, so the deciding can be tested without Cloudflare. */
export type Placing = {
	/** The data center that answers the server, and its country - asked until it is `home`, for a few seconds. */
	answers(origin: string, home: string, seconds: number): Promise<{ colo: string | null; country: string | null }>;
	/** The cloud region the Worker is placed beside now. Undefined when Cloudflare cannot be asked. */
	current(worker: string): Promise<string | null | undefined>;
	move(worker: string, region: string): Promise<void>;
};
const livePlacing: Placing = {
	async answers(origin, home, seconds) {
		const until = Date.now() + seconds * 1000;
		for (;;) {
			const seen = await answeredFrom(origin);
			if (seen.country === home || Date.now() >= until) return seen;
			await sleep(1000);
		}
	},
	current: async (worker) => (await workerSettings(worker))?.placement,
	move: setPlacement,
};

export type Placed = {
	/** It answers from its country, or has none to answer from. */
	ok: boolean;
	/** What was wrong, and what was or would be done about it. Null when nothing was. */
	said: string | null;
};

/**
 * Keep a server answering from its country. A placement names ONE cloud region, and Cloudflare
 * stops honouring one at a time - for every Worker on it, for tens of minutes - while another
 * name for the same place goes on working. So this asks where the server really answers from,
 * and when that is not its country, moves it to the next way of naming it: one API call, a few
 * seconds, no upload. With `fix` false it only says what it would do.
 */
export async function place(server: Server, deployment: Deployment, origin: string, { fix }: { fix: boolean }, io: Placing = livePlacing): Promise<Placed> {
	const home = server.country?.toLowerCase();
	const ways = deployment.placements;
	if (!home || ways.length === 0) return { ok: true, said: null };
	const HOME = home.toUpperCase();
	// The fact first, and it is one request: where does it answer from?
	const seen = await io.answers(origin, home, 8);
	if (seen.country === home) return { ok: true, said: null };
	const current = await io.current(deployment.worker);
	// Not on any of them: it was never placed, or its document now says somewhere else.
	const off = current !== undefined && (current === null || !ways.includes(current));

	const why = off ? `it runs ${current ? `beside ${current}` : "wherever a request arrives"}, which is not ${HOME}` : `it is not answering from ${HOME}${seen.colo ? ` but from ${seen.colo}${seen.country ? `, in ${seen.country.toUpperCase()}` : ""}` : ""}: Cloudflare is not honouring ${current ?? "its placement"}`;
	const others = ways.filter((way) => way !== current);
	if (current === undefined) return { ok: false, said: `${why} — and Cloudflare cannot be asked or told without CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID` };
	if (others.length === 0) return { ok: false, said: `${why}, and its document names no other way to run in ${HOME}` };
	if (!fix) return { ok: false, said: `${why} — apply moves it beside ${others[0]}` };

	const tried: string[] = [];
	for (const way of others) {
		await io.move(deployment.worker, way);
		const now = await io.answers(origin, home, 12);
		if (now.country === home) return { ok: true, said: `${why}. Moved beside ${way}, and it answers from ${HOME} (the data center ${now.colo})` };
		tried.push(way);
	}
	return { ok: false, said: `${why}, and nor is it honouring ${tried.join(", ")}: it runs wherever a request arrives until one of them is` };
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

// One build is every server's: the code is the same, and the only thing a build writes that
// names a server is the config wrangler deploys with. So it is built once in a run, and each
// server is an upload - which is what lets many be deployed at the same time.
let built: Promise<void> | null = null;
function buildOnce(): Promise<void> {
	built ??= (async () => {
		const result = await run("npm", ["run", "build"], { inherit: true });
		if (result.status !== 0) throw new Error("npm run build failed");
		// The build leaves a redirect to the config it wrote; every wrangler here names its own.
		rmSync(".wrangler/deploy/config.json", { force: true });
	})();
	return built;
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
	const began = Date.now();
	let current = server;
	try {
		let live = deployment;
		// What a server is made of is created once. One that is already deployed has it all, so
		// asking Cloudflare again is skipped - and done after all if the upload says otherwise.
		const standing = !!server.url && !!deployment.databaseId;
		const make = async () => {
			const id = await provision(server, deployment, print);
			if (id !== current.databaseId) current = saveServer(server.name, { databaseId: id }, base);
			live = { ...deployment, databaseId: id };
		};
		if (deployment.generated && !standing) await make();
		// A server that was moved to another way of naming its country stays on it: the upload
		// carries the placement, and going back to one Cloudflare is not honouring helps nobody.
		const now = standing && deployment.placements.length > 1 ? await workerSettings(deployment.worker).then((settings) => settings?.placement, () => undefined) : undefined;
		if (now && deployment.placements.includes(now)) live = { ...live, placement: now };
		if (deployment.generated) writeServerConfig(template, live);
		await buildOnce();
		// Cloudflare's API refuses an upload now and then ("internal authentication error", most
		// often when several go up at once). It is the same upload again a few seconds later.
		const upload = async () => {
			for (let attempt = 0; ; attempt += 1) {
				const result = await wrangler(["deploy"], { config: writeBuiltConfig(live), inherit: true });
				if (result.status === 0 || attempt >= 2) return result;
				await sleep(4000 * (attempt + 1));
			}
		};
		let uploaded = await upload();
		if (uploaded.status !== 0 && deployment.generated && standing) {
			await make();
			writeServerConfig(template, live);
			uploaded = await upload();
		}
		if (uploaded.status !== 0) throw new Error("wrangler deploy failed");
		const deployedAt = Date.now();
		if (live.generated) await putSecrets(server, live, print);
		await applyMigrations({ db: live.database, local: false, config: live.config });

		// Deriving the origin needs Cloudflare credentials; a custom domain goes in server.json by hand.
		const origin = server.url ?? (await resolveInstanceUrl({ worker: live.worker }));
		if (!origin) throw new Error(`deployed, but its origin is unknown — add "url" to ${serverDocPath(server.name, base)}`);
		// A new Worker takes a moment to answer on its address, and a moment more to answer every
		// time: it is ready when it has answered three times running.
		for (let attempt = 0, good = 0; attempt < 40 && good < 3; attempt += 1) {
			const response = await fetch(origin, { redirect: "manual" }).catch(() => null);
			good = response && response.status < 500 && response.status !== 404 ? good + 1 : 0;
			if (good < 3) await sleep(good > 0 ? 500 : 2000);
		}
		current = saveServer(server.name, { url: origin }, base);
		const took = `${Math.round((Date.now() - began) / 1000)}s`;
		print(`  ✓ "${server.name}" is at ${origin} (${took}), recorded in ${serverDocPath(server.name, base)}`);
		if (live.placements.length > 0 && server.country) {
			const placed = await place(server, live, origin, { fix: true });
			const since = Math.round((Date.now() - deployedAt) / 1000);
			if (placed.ok) print(`  ✓ and it answers from ${server.country.toUpperCase()}, ${since}s after the upload${placed.said ? ` — ${placed.said}` : ""}`);
			else print(`  ! ${placed.said}`);
		}
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
