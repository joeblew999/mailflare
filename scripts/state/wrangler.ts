/* eslint-disable @typescript-eslint/no-explicit-any -- external HTTP JSON is validated by the app's zod schemas at runtime, not by these types. */
// Shared helpers for the repo's scripts. Kept free of app imports so this module runs
// under both `node` and `tsx`; callers add app imports (zod schemas, ids) where needed.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function run(command: string, args: string[], env?: Record<string, string>) {
	return spawnSync(command, args, { encoding: "utf8", env: env ? { ...process.env, ...env } : process.env });
}

// Read a secret from the macOS keychain; fnox stores entries under service "fnox"
// with the secret name as the account.
export function keychain(account: string, service = "fnox") {
	const result = run("security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
	return result.status === 0 ? result.stdout.trim() : null;
}

export function sleep(ms: number) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Run SQL through wrangler and return the result rows.
export function d1(sql: string, { db = "mailflare", local = false }: { db?: string; local?: boolean } = {}) {
	const result = run("npx", ["wrangler", "d1", "execute", db, local ? "--local" : "--remote", "--json", "--command", sql]);
	if (result.status !== 0) throw new Error(result.stderr || result.stdout || "wrangler d1 execute failed");
	const parsed = JSON.parse(result.stdout);
	const first = Array.isArray(parsed) ? parsed[0] : parsed;
	return first?.results ?? [];
}

// Bring a database up to the current schema. It targets whatever wrangler is pointed
// at, so the same call readies the local dev database and a deployed D1 (the latter
// needs database_id + migrations_dir in wrangler.jsonc, which the repo sets).
export function applyMigrations({ db = "mailflare", local = false }: { db?: string; local?: boolean } = {}) {
	// CI=1 skips wrangler's confirmation prompt. That prompt path is what made the exit code
	// unreliable: it applied every migration and still reported non-zero. The schema check
	// below stays the real proof.
	const result = run("npx", ["wrangler", "d1", "migrations", "apply", db, local ? "--local" : "--remote"], { CI: "1" });
	// The exit status is not trustworthy: in a non-interactive context wrangler skips
	// the confirmation, applies every migration, and can still report non-zero. The
	// caller checks the schema it actually needs (Store.schemaPresent), which is the
	// thing that matters, so warn rather than fail here.
	if (result.status !== 0) console.warn("  ⚠ wrangler reported a non-zero exit while applying migrations — verifying the schema instead");
}

// Secret names only — Cloudflare never returns secret values.
export function workerSecretNames() {
	const result = run("npx", ["wrangler", "secret", "list"]);
	if (result.status !== 0) return null;
	try {
		return JSON.parse(result.stdout).map((entry) => entry.name);
	} catch {
		return null;
	}
}

// Quote a value for a single-quoted SQL string.
export function sqlEscape(value: unknown) {
	return String(value).replace(/'/g, "''");
}

// Call the app's HTTP API with a bearer key. Returns the status plus parsed JSON
// (json is null when the body is not JSON, e.g. the branding icon bytes).
export type ApiResult = { status: number; text: string; json: any };

export async function request(
	base: string,
	path: string,
	{ method = "GET", key, body }: { method?: string; key?: string; body?: unknown } = {},
): Promise<ApiResult> {
	const response = await fetch(`${base}${path}`, {
		method,
		headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await response.text();
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {
		// not JSON
	}
	return { status: response.status, text, json };
}

// The first R2 bucket in wrangler.jsonc.
export function r2BucketName() {
	try {
		const match = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8").match(/"bucket_name"\s*:\s*"([^"]+)"/);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

// Delete objects from R2. One wrangler call per key - slow, but it is the only handle this
// runtime has on the bucket, and leaving the bytes behind is not an option.
export function r2DeleteObjects(keys: string[]): number {
	const bucket = r2BucketName();
	if (!bucket) throw new Error("could not read the R2 bucket name from wrangler.jsonc");
	let deleted = 0;
	for (const key of keys) {
		const result = run("npx", ["wrangler", "r2", "object", "delete", `${bucket}/${key}`, "--remote"]);
		if (result.status === 0) deleted += 1;
		else console.warn(`  ⚠ could not delete r2://${bucket}/${key}`);
	}
	return deleted;
}

// The Worker name is the first top-level "name" in wrangler.jsonc.
export function workerNameFromConfig() {
	try {
		const match = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8").match(/^\s*"name"\s*:\s*"([^"]+)"/m);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

// Cloudflare API responses wrap their payload in { result }. `json()` is typed
// `unknown` under @cloudflare/workers-types, so this keeps the envelope explicit
// instead of leaking `any` into callers.
export async function cfApi<T>(path: string, token: string) {
	const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!response.ok) return null;
	return (await response.json().catch(() => null)) as { result?: T } | null;
}

// Resolve the instance URL without hard-coding it: explicit value, then
// MAILFLARE_URL, then <worker>.<account-subdomain>.workers.dev from the API.
// Returns null when nothing can be determined.
export async function resolveInstanceUrl({ url, token, account, worker }: { url?: string; token?: string | null; account?: string | null; worker?: string } = {}) {
	const explicit = url || process.env.MAILFLARE_URL;
	if (explicit) return explicit.replace(/\/+$/, "");

	const name = worker || workerNameFromConfig();
	const tokenValue = token || process.env.CLOUDFLARE_API_TOKEN?.trim() || keychain("CLOUDFLARE_API_TOKEN");
	const accountValue = account || process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || keychain("CLOUDFLARE_ACCOUNT_ID");
	if (!name || !tokenValue || !accountValue) return null;

	const subdomain = await cfApi<{ subdomain?: string }>(`/accounts/${accountValue}/workers/subdomain`, tokenValue);
	return subdomain?.result?.subdomain ? `https://${name}.${subdomain.result.subdomain}.workers.dev` : null;
}

// The primary admin account, used as the default recipient/target.
export function findAdmin({ db, local }: { db?: string; local?: boolean } = {}) {
	const [admin] = d1("SELECT id, email FROM users WHERE role='admin' ORDER BY created_at LIMIT 1;", { db, local });
	return admin ?? null;
}
