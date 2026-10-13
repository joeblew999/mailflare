/* eslint-disable @typescript-eslint/no-explicit-any -- external JSON (wrangler, the app's API) is untyped here. */
// The transport: wrangler, the Cloudflare API, the keychain and the app's HTTP API. Free of app
// imports, and asynchronous throughout so many servers can be driven at once.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { placementOf } from "./spec";

export const WRANGLER_CONFIG = "wrangler.jsonc";
const WRANGLER = existsSync("node_modules/.bin/wrangler") ? ["node_modules/.bin/wrangler"] : ["npx", "wrangler"];

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export type Ran = { status: number; stdout: string; stderr: string };

/** Run a command to completion. `inherit` streams its output, for the long ones; `input` goes to its stdin. */
export function run(command: string, args: string[], { env, inherit = false, input }: { env?: Record<string, string>; inherit?: boolean; input?: string } = {}): Promise<Ran> {
	return new Promise((done) => {
		const child = spawn(command, args, { env: env ? { ...process.env, ...env } : process.env, stdio: inherit ? "inherit" : [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => (stdout += chunk));
		child.stderr?.on("data", (chunk) => (stderr += chunk));
		child.on("error", (error) => done({ status: 1, stdout, stderr: `${stderr}${error.message}` }));
		child.on("close", (status) => done({ status: status ?? 1, stdout, stderr }));
		if (input !== undefined) child.stdin?.end(input);
	});
}

/**
 * Always with an explicit config: a build leaves a redirect to whichever server it built, and
 * every server of the fleet has a config of its own.
 */
export function wrangler(args: string[], { config = WRANGLER_CONFIG, ...options }: { config?: string; env?: Record<string, string>; inherit?: boolean; input?: string } = {}): Promise<Ran> {
	return run(WRANGLER[0], [...WRANGLER.slice(1), ...args, "--config", config], options);
}

// --- wrangler.jsonc ---------------------------------------------------------------

// JSONC allows comments and trailing commas; JSON.parse does not. String-aware, so a URL's
// `//` survives.
export function stripJsonc(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];
		if (char === '"') {
			const start = i;
			for (i += 1; i < text.length && text[i] !== '"'; i += 1) if (text[i] === "\\") i += 1;
			out += text.slice(start, i + 1);
		} else if (char === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i += 1;
			out += "\n";
		} else if (char === "/" && text[i + 1] === "*") {
			i = text.indexOf("*/", i + 2);
			if (i < 0) break;
			i += 1;
		} else out += char;
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Only the parts of wrangler.jsonc this system reads. The rest is carried over as it is. */
export type WranglerConfig = Record<string, unknown> & {
	name?: string;
	services?: Array<{ binding?: string; service?: string }>;
	d1_databases?: Array<{ binding?: string; database_name?: string; database_id?: string }>;
	r2_buckets?: Array<{ binding?: string; bucket_name?: string; jurisdiction?: string }>;
	queues?: { producers?: Array<{ queue?: string }>; consumers?: Array<{ queue?: string }> };
	vars?: Record<string, string>;
};

export function readWranglerConfig(path = WRANGLER_CONFIG): WranglerConfig {
	return JSON.parse(stripJsonc(readFileSync(path, "utf8")));
}

/** What a server is made of on Cloudflare, and the config wrangler reaches it through. */
export type Deployment = {
	/** wrangler.jsonc for the default server; a generated file for every other. */
	config: string;
	generated: boolean;
	worker: string;
	database: string;
	databaseId?: string;
	bucket: string;
	queues: string[];
	jurisdiction?: string;
	/** The cloud region its Worker runs beside. */
	placement?: string;
};

/** The parts of a server.json that decide its deployment. */
export type ServerShape = { name: string; db?: string; databaseId?: string; bucket?: string; jurisdiction?: string; country?: string; placement?: string };

/**
 * wrangler.jsonc IS the default server and the TEMPLATE for every other: same Worker, same
 * bindings, its own name, database, bucket and queues.
 */
export function deploymentFor(template: WranglerConfig, server: ServerShape): Deployment {
	const base = template.name ?? "mailflare";
	const queues = (template.queues?.producers ?? []).map((producer) => String(producer.queue));
	if (server.name === base) {
		return { config: WRANGLER_CONFIG, generated: false, worker: base, database: template.d1_databases?.[0]?.database_name ?? base, databaseId: template.d1_databases?.[0]?.database_id, bucket: template.r2_buckets?.[0]?.bucket_name ?? `${base}-raw`, queues, jurisdiction: template.r2_buckets?.[0]?.jurisdiction };
	}
	return {
		config: `wrangler.${server.name}.json`,
		generated: true,
		worker: server.name,
		database: server.db ?? server.name,
		databaseId: server.databaseId,
		bucket: server.bucket ?? `${server.name}-raw`,
		queues: queues.map((queue) => queue.replace(base, server.name)),
		jurisdiction: server.jurisdiction,
		placement: placementOf(server),
	};
}

/** The full wrangler config of a non-default server: the template, with its own resources. */
export function serverConfig(template: WranglerConfig, deployment: Deployment): WranglerConfig {
	const base = template.name ?? "mailflare";
	const rename = (queue?: string) => String(queue).replace(base, deployment.worker);
	const config: WranglerConfig = structuredClone(template);
	delete config.$schema;
	config.name = deployment.worker;
	// The Worker calls itself through this binding, so it must name itself.
	config.services = (template.services ?? []).map((service) => (service.service === base ? { ...service, service: deployment.worker } : service));
	config.d1_databases = (template.d1_databases ?? []).map((database, index) => (index === 0 ? { ...database, database_name: deployment.database, database_id: deployment.databaseId ?? "" } : database));
	config.r2_buckets = (template.r2_buckets ?? []).map((bucket, index) => (index === 0 ? { ...bucket, bucket_name: deployment.bucket, ...(deployment.jurisdiction ? { jurisdiction: deployment.jurisdiction } : {}) } : bucket));
	config.queues = {
		producers: (template.queues?.producers ?? []).map((producer) => ({ ...producer, queue: rename(producer.queue) })),
		consumers: (template.queues?.consumers ?? []).map((consumer) => ({ ...consumer, queue: rename(consumer.queue) })),
	};
	// What src/ reads to know which server it is (see --source-changes).
	config.vars = { ...(template.vars ?? {}), MAILFLARE_WORKER_NAME: deployment.worker, ...(deployment.jurisdiction ? { MAILFLARE_JURISDICTION: deployment.jurisdiction } : {}) };
	// Where it runs: Cloudflare places the Worker in the data center nearest this cloud region.
	if (deployment.placement) config.placement = { region: deployment.placement };
	return config;
}

/** Write a generated server's config where wrangler and the build will read it. */
export function writeServerConfig(template: WranglerConfig, deployment: Deployment): void {
	if (deployment.generated) writeFileSync(deployment.config, `${JSON.stringify(serverConfig(template, deployment), null, "\t")}\n`);
}

// --- D1 -----------------------------------------------------------------------------

/** Which database a statement is for. `config` is the server's wrangler config; the default when absent. */
export type Database = { db: string; local: boolean; config?: string };
export type Row = Record<string, any>;

// wrangler reports a failure as JSON on stdout when --json is set.
function wranglerError(result: Ran): string {
	try {
		const parsed = JSON.parse(result.stdout);
		const text = parsed?.error?.text;
		if (text) return [text, ...(parsed.error.notes ?? []).map((note: any) => note.text)].filter(Boolean).join(" — ");
	} catch {
		// not JSON
	}
	return (result.stderr || result.stdout || "wrangler failed").trim();
}

// Failures that say the statement never ran, so running it again is safe. 7403 is what
// parallel wrangler processes get while one of them is refreshing the login they share.
const TRANSIENT = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|timed out|internal error|50[0234]\b|database is locked|SQLITE_BUSY|7403|not authorized to access this service|Authentication error/i;
const RETRY_AFTER = [1500, 4000, 9000];

// The local database is one SQLite file, so its statements go one at a time.
let localQueue: Promise<unknown> = Promise.resolve();

/** Run SQL (one statement, or several as one batch) and return the first statement's rows. */
export async function d1(sql: string, { db, local, config }: Database): Promise<Row[]> {
	const execute = async () => {
		const args = ["d1", "execute", db, local ? "--local" : "--remote", "--json", "--command", sql];
		let result = await wrangler(args, { config });
		for (const delay of RETRY_AFTER) {
			if (result.status === 0 || !TRANSIENT.test(wranglerError(result))) break;
			await sleep(delay);
			result = await wrangler(args, { config });
		}
		if (result.status !== 0) throw new Error(`database ${db}: ${wranglerError(result)}`);
		const parsed = JSON.parse(result.stdout);
		return ((Array.isArray(parsed) ? parsed[0] : parsed)?.results ?? []) as Row[];
	};
	if (!local) return execute();
	const next = localQueue.then(execute);
	localQueue = next.catch(() => undefined);
	return next;
}

/**
 * Make sure wrangler's login is fresh BEFORE fanning out: processes started together would
 * each try to refresh it, and all but one would fail.
 */
export async function warmUp(): Promise<void> {
	await wrangler(["whoami"]);
}

/** Bring a database up to the current schema. */
export async function applyMigrations({ db, local, config }: Database): Promise<void> {
	// CI=1 skips wrangler's confirmation prompt. Its exit status is not trustworthy when it does,
	// so the caller verifies the schema instead.
	await wrangler(["d1", "migrations", "apply", db, local ? "--local" : "--remote"], { config, env: { CI: "1" } });
}

/** Secret names only — Cloudflare never returns secret values. Null when they cannot be listed. */
export async function workerSecretNames(config?: string): Promise<string[] | null> {
	const result = await wrangler(["secret", "list"], { config });
	if (result.status !== 0) return null;
	try {
		return JSON.parse(result.stdout).map((entry: any) => entry.name);
	} catch {
		return null;
	}
}

/** Delete objects from a bucket, one wrangler call each. Returns how many went. */
export async function r2DeleteObjects(keys: string[], { bucket, local, jurisdiction, config }: { bucket: string; local: boolean; jurisdiction?: string; config?: string }): Promise<number> {
	let deleted = 0;
	for (const key of keys) {
		const result = await wrangler(["r2", "object", "delete", `${bucket}/${key}`, local ? "--local" : "--remote", ...(jurisdiction && !local ? ["--jurisdiction", jurisdiction] : [])], { config });
		if (result.status === 0) deleted += 1;
	}
	return deleted;
}

/** Quote a value for a single-quoted SQL string. */
export function sqlEscape(value: unknown) {
	return String(value).replace(/'/g, "''");
}

// --- Cloudflare and the keychain ---------------------------------------------------

const secrets = new Map<string, string | null>();

// fnox keeps this project's secrets under the keychain service "mailflare" (fnox.toml), and
// the machine-wide ones under "fnox".
const KEYCHAIN_SERVICES = ["mailflare", "fnox"];

/** A secret by name: from the environment, else the macOS keychain. Null when it is nowhere. */
export function credential(name: string): string | null {
	const fromEnv = process.env[name]?.trim();
	if (fromEnv) return fromEnv;
	if (!secrets.has(name)) {
		let found: string | null = null;
		for (const service of KEYCHAIN_SERVICES) {
			const result = spawnSync("security", ["find-generic-password", "-s", service, "-a", name, "-w"], { encoding: "utf8" });
			if (result.status === 0 && result.stdout.trim()) {
				found = result.stdout.trim();
				break;
			}
		}
		secrets.set(name, found);
	}
	return secrets.get(name) ?? null;
}

/** Cloudflare API responses wrap their payload in { result }. Null when the call fails. */
export async function cfApi<T>(path: string, token: string, init: RequestInit = {}): Promise<{ result?: T } | null> {
	const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }).catch(() => null);
	if (!response?.ok) return null;
	return (await response.json().catch(() => null)) as { result?: T } | null;
}

/** A Worker's workers.dev address, or null without Cloudflare credentials. */
export async function workersDevUrl(worker: string): Promise<string | null> {
	const token = credential("CLOUDFLARE_API_TOKEN");
	const account = credential("CLOUDFLARE_ACCOUNT_ID");
	if (!token || !account) return null;
	const subdomain = await cfApi<{ subdomain?: string }>(`/accounts/${account}/workers/subdomain`, token);
	return subdomain?.result?.subdomain ? `https://${worker}.${subdomain.result.subdomain}.workers.dev` : null;
}

/** The instance's origin: an explicit one, else MAILFLARE_URL, else the Worker's workers.dev address. */
export async function resolveInstanceUrl({ url, worker }: { url?: string; worker?: string } = {}): Promise<string | null> {
	const explicit = url || process.env.MAILFLARE_URL;
	if (explicit) return explicit.replace(/\/+$/, "");
	return worker ? workersDevUrl(worker) : null;
}

// --- the app's HTTP API -------------------------------------------------------------

/** The status plus the parsed body (json is null when the body is not JSON). */
export type ApiResult = { status: number; text: string; json: any };

export async function request(base: string, path: string, { method = "GET", key, body }: { method?: string; key?: string; body?: unknown } = {}): Promise<ApiResult> {
	let response: Response;
	try {
		response = await fetch(`${base}${path}`, {
			method,
			headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
			body: body ? JSON.stringify(body) : undefined,
		});
	} catch (error) {
		const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : message(error);
		throw new Error(`could not reach ${base} (${cause})`);
	}
	const text = await response.text();
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {
		// not JSON
	}
	return { status: response.status, text, json };
}

/** A failed response, as one line: the app answers with a string or a zod error object. */
export function apiError(result: ApiResult): string {
	const error = result.json?.error;
	const detail = typeof error === "string" ? error : error ? JSON.stringify(error.fieldErrors ?? error) : result.text.slice(0, 160).replace(/\s+/g, " ");
	return `HTTP ${result.status}${detail ? ` — ${detail}` : ""}`;
}
