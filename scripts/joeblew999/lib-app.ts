// App-coupled helpers for scripts run under `tsx` (so they resolve `@/` paths).
// Keeping key-minting and request validation here means the temp-key format, the
// scopes and the request bodies come straight from the app and cannot drift from
// what the Worker enforces.
import { newId } from "@/lib/ids";
import { ADMIN_API_KEY_SCOPES } from "@/lib/api/scopes";
import { generateApiKey } from "@/lib/api-keys";
import { addDomainSchema, createUserAccountSchema, mailboxSchema, updateManagedAccountSchema } from "@/lib/validators";
import { d1, findAdmin, resolveInstanceUrl, sqlEscape } from "./lib";
import { makeLiveStore } from "./provision/store-live";
import type { Store } from "./provision/store-types";

// The app's own request schemas, keyed by what we send. Validating here means a
// hand-written body cannot drift from what the route accepts: it throws before the
// request is made, instead of 400-ing halfway through a run.
const REQUEST_SCHEMAS = {
	domain: addDomainSchema,
	mailbox: mailboxSchema,
	account: createUserAccountSchema,
	accountUpdate: updateManagedAccountSchema,
};

export function validateBody(kind: string, body: unknown) {
	const schema = REQUEST_SCHEMAS[kind as keyof typeof REQUEST_SCHEMAS];
	if (!schema) throw new Error(`no schema registered for "${kind}"`);
	const parsed = schema.safeParse(body);
	if (!parsed.success) {
		throw new Error(`the app's ${kind} schema rejected this body: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
	}
	return parsed.data;
}

// Insert a short-lived admin API key into D1 and return it.
export function mintAdminKey({ db, local, adminId, name = "provision" }: { db?: string; local?: boolean; adminId: string; name?: string }) {
	const { fullKey, prefix, hash } = generateApiKey();
	const id = newId("key");
	d1(
		`INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, mailbox_scope_enabled, created_at)
     VALUES ('${sqlEscape(id)}', 'legacy', '${sqlEscape(adminId)}', '${sqlEscape(name)}', '${sqlEscape(prefix)}', '${sqlEscape(hash)}', '${sqlEscape(JSON.stringify(ADMIN_API_KEY_SCOPES))}', 0, strftime('%s','now'));`,
		{ db, local },
	);
	return { fullKey, keyId: id, prefix };
}

export function deleteApiKey({ db, local, keyId }: { db?: string; local?: boolean; keyId: string }) {
	d1(`DELETE FROM api_keys WHERE id='${sqlEscape(keyId)}';`, { db, local });
}

/**
 * Build the live Store for a run: resolve the instance, find the admin, mint ONE
 * temporary API key for the whole run, and always delete it afterwards. One key per
 * run (not per domain) is what lets a mass run touch thousands of domains without
 * thousands of key round-trips.
 */
export async function withProvisionStore(
	{ db, local, url, name = "provision" }: { db?: string; local?: boolean; url?: string; name?: string },
	fn: (store: Store) => Promise<number>,
): Promise<number> {
	const base = await resolveInstanceUrl({ url });
	if (!base) throw new Error("Could not determine the instance URL. Pass --url or set MAILFLARE_URL.");

	const admin = findAdmin({ db, local });
	if (!admin) throw new Error("No admin user found — is the instance set up?");

	const { fullKey, keyId } = mintAdminKey({ db, local, adminId: admin.id, name });
	try {
		return await fn(makeLiveStore({ base, key: fullKey, admin, db: db ?? "mailflare", local: Boolean(local) }));
	} finally {
		deleteApiKey({ db, local, keyId });
	}
}
