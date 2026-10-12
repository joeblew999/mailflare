// Shared helpers for the repo's scripts. Deliberately plain JS with no app imports,
// so it works under both `node` and `tsx` (features-smoke.mjs runs under tsx to
// import app code, the others under node).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function run(command, args) {
	return spawnSync(command, args, { encoding: "utf8" });
}

// Read a secret from the macOS keychain; fnox stores entries under service "fnox"
// with the secret name as the account.
export function keychain(account, service = "fnox") {
	const result = run("security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
	return result.status === 0 ? result.stdout.trim() : null;
}

export function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Run SQL through wrangler and return the result rows.
export function d1(sql, { db = "mailflare", local = false } = {}) {
	const result = run("npx", ["wrangler", "d1", "execute", db, local ? "--local" : "--remote", "--json", "--command", sql]);
	if (result.status !== 0) throw new Error(result.stderr || result.stdout || "wrangler d1 execute failed");
	const parsed = JSON.parse(result.stdout);
	const first = Array.isArray(parsed) ? parsed[0] : parsed;
	return first?.results ?? [];
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
export function sqlEscape(value) {
	return String(value).replace(/'/g, "''");
}

// Call the app's HTTP API with a bearer key. Returns the status plus parsed JSON
// (json is null when the body is not JSON, e.g. the branding icon bytes).
export async function request(base, path, { method = "GET", key, body } = {}) {
	const response = await fetch(`${base}${path}`, {
		method,
		headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await response.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		// not JSON
	}
	return { status: response.status, text, json };
}

// The whole plan state lives in one license_settings row; these are the writes the
// app's getLicenseEntitlements reads.
export const licenceSql = {
	// Upsert: instance_id is generated in SQL so this also works on a fresh database.
	on: (plan) => `
INSERT INTO license_settings (id, instance_id, plan, state, features, seat_limit, updated_at)
VALUES (
	'default',
	lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
	'${plan}', 'active', '[]', 1, strftime('%s','now')
)
ON CONFLICT(id) DO UPDATE SET
	plan = excluded.plan, state = excluded.state, features = excluded.features, updated_at = excluded.updated_at;`,
	off: "UPDATE license_settings SET plan='community', state='inactive', features='[]', updated_at=strftime('%s','now') WHERE id='default';",
	status: "SELECT plan, state, seat_limit, features FROM license_settings WHERE id='default';",
};

// Mirrors getLicenseEntitlements (src/lib/licenses/service.ts) for display. It needs
// D1, so it cannot be imported — keep this the one place that mirrors the gates.
export function entitlementsFor(plan, active) {
	const isTeam = active && plan === "team";
	const isPro = active && plan === "pro";
	return {
		branding: active,
		accounts: active,
		forwarding: active,
		sharing: isTeam,
		seatLimit: isPro ? "from license" : isTeam ? "unlimited" : "1",
	};
}

// The Worker name is the first top-level "name" in wrangler.jsonc.
export function workerNameFromConfig() {
	try {
		const match = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").match(/^\s*"name"\s*:\s*"([^"]+)"/m);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

// Resolve the instance URL without hard-coding it: explicit value, then
// MAILFLARE_URL, then <worker>.<account-subdomain>.workers.dev from the API.
// Returns null when nothing can be determined.
export async function resolveInstanceUrl({ url, token, account } = {}) {
	const explicit = url || process.env.MAILFLARE_URL;
	if (explicit) return explicit.replace(/\/+$/, "");

	const name = workerNameFromConfig();
	const tokenValue = token || process.env.CLOUDFLARE_API_TOKEN?.trim() || keychain("CLOUDFLARE_API_TOKEN");
	const accountValue = account || process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || keychain("CLOUDFLARE_ACCOUNT_ID");
	if (!name || !tokenValue || !accountValue) return null;

	const subdomain = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountValue}/workers/subdomain`, {
		headers: { Authorization: `Bearer ${tokenValue}` },
	}).then((r) => r.json()).catch(() => null);
	return subdomain?.result?.subdomain ? `https://${name}.${subdomain.result.subdomain}.workers.dev` : null;
}

// The primary admin account, used as the default recipient/target.
export function findAdmin({ db, local } = {}) {
	const [admin] = d1("SELECT id, email FROM users WHERE role='admin' ORDER BY created_at LIMIT 1;", { db, local });
	return admin ?? null;
}
