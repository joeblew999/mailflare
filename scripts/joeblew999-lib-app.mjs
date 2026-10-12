// App-coupled helpers for scripts run under `tsx` (so they resolve `@/` paths).
// Keeping key-minting here means the temp-key format and scopes come straight from
// the app and cannot drift from what the Worker enforces.
import { randomBytes } from "node:crypto";
import { d1, sqlEscape } from "./joeblew999-lib.mjs";
import { ADMIN_API_KEY_SCOPES } from "@/lib/api/scopes";
import { generateApiKey } from "@/lib/api-keys";

// Insert a short-lived admin API key into D1 and return it.
export function mintAdminKey({ db, local, adminId, name = "smoke" }) {
	const { fullKey, prefix, hash } = generateApiKey();
	const id = `key_${name}_${randomBytes(6).toString("hex")}`;
	d1(
		`INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, mailbox_scope_enabled, created_at)
     VALUES ('${sqlEscape(id)}', 'legacy', '${sqlEscape(adminId)}', '${sqlEscape(name)}', '${sqlEscape(prefix)}', '${sqlEscape(hash)}', '${sqlEscape(JSON.stringify(ADMIN_API_KEY_SCOPES))}', 0, strftime('%s','now'));`,
		{ db, local },
	);
	return { fullKey, keyId: id, prefix };
}
