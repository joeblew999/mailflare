// App-coupled helpers for scripts run under `tsx` (so they resolve `@/` paths).
// Keeping key-minting here means the temp-key format and scopes come straight from
// the app and cannot drift from what the Worker enforces.
import { randomBytes } from "node:crypto";
import { d1, findAdmin, resolveInstanceUrl, sqlEscape } from "./joeblew999-lib";
import { ADMIN_API_KEY_SCOPES } from "@/lib/api/scopes";
import { generateApiKey } from "@/lib/api-keys";
import { addDomainSchema, createUserAccountSchema, mailboxSchema, updateManagedAccountSchema } from "@/lib/validators";

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
	const schema = REQUEST_SCHEMAS[kind];
	if (!schema) throw new Error(`no schema registered for "${kind}"`);
	const parsed = schema.safeParse(body);
	if (!parsed.success) {
		throw new Error(`the app's ${kind} schema rejected this body: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
	}
	return parsed.data;
}

// Insert a short-lived admin API key into D1 and return it.
export function mintAdminKey({ db, local, adminId, name = "smoke" }: { db?: string; local?: boolean; adminId: string; name?: string }) {
	const { fullKey, prefix, hash } = generateApiKey();
	const id = `key_${name}_${randomBytes(6).toString("hex")}`;
	d1(
		`INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, mailbox_scope_enabled, created_at)
     VALUES ('${sqlEscape(id)}', 'legacy', '${sqlEscape(adminId)}', '${sqlEscape(name)}', '${sqlEscape(prefix)}', '${sqlEscape(hash)}', '${sqlEscape(JSON.stringify(ADMIN_API_KEY_SCOPES))}', 0, strftime('%s','now'));`,
		{ db, local },
	);
	return { fullKey, keyId: id, prefix };
}

// Mint an MCP key (kind "mcp"): scoped to MCP tools, optionally limited to mailboxes.
export function mintMcpKey({ db, local, adminId, name, scopes, mailboxIds = [] }: { db?: string; local?: boolean; adminId: string; name: string; scopes: string[]; mailboxIds?: string[] }) {
	const { fullKey, prefix, hash } = generateApiKey();
	const id = `key_mcp_${randomBytes(6).toString("hex")}`;
	d1(
		`INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, mailbox_scope_enabled, created_at)
     VALUES ('${sqlEscape(id)}', 'mcp', '${sqlEscape(adminId)}', '${sqlEscape(name)}', '${sqlEscape(prefix)}', '${sqlEscape(hash)}', '${sqlEscape(JSON.stringify(scopes))}', ${mailboxIds.length ? 1 : 0}, strftime('%s','now'));`,
		{ db, local },
	);
	for (const mailboxId of mailboxIds) {
		d1(`INSERT INTO mcp_key_mailboxes (key_id, mailbox_id) VALUES ('${sqlEscape(id)}', '${sqlEscape(mailboxId)}');`, { db, local });
	}
	return { fullKey, keyId: id, prefix };
}

/**
 * Resolve the instance, find the admin, mint a temporary API key, run `fn` with it,
 * and always delete the key afterwards. Callers cannot leak the key: a bare
 * `process.exit` or an early return previously skipped the delete.
 *
 * Pass `base` to reuse an already-resolved origin (avoids a second lookup).
 */
export async function withAdminKey(
	{ db, local, url, base, name = "smoke" }: { db?: string; local?: boolean; url?: string; base?: string; name?: string },
	fn: (context: { base: string; key: string; admin: { id: string; email: string }; keyId: string; prefix: string }) => Promise<number>,
) {
	const origin = base ?? (await resolveInstanceUrl({ url }));
	if (!origin) throw new Error("Could not determine the instance URL. Pass --url or set MAILFLARE_URL.");

	const admin = findAdmin({ db, local });
	if (!admin) throw new Error("No admin user found — is the instance set up?");

	const { fullKey, keyId, prefix } = mintAdminKey({ db, local, adminId: admin.id, name });
	try {
		return await fn({ base: origin, key: fullKey, admin, keyId, prefix });
	} finally {
		d1(`DELETE FROM api_keys WHERE id='${sqlEscape(keyId)}';`, { db, local });
	}
}
