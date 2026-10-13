// The live Store - the ONLY module in the reconciler that talks to D1 directly.
import { newId } from "@/lib/ids";
import { ADMIN_API_KEY_SCOPES } from "@/lib/api/scopes";
import { generateApiKey } from "@/lib/api-keys";
import { applyMigrations as runMigrations, cfApi, d1, findAdmin, keychain, r2DeleteObjects, request, resolveInstanceUrl, sleep, sqlEscape, workerSecretNames } from "../wrangler";
import type { ApiAccount, ApiDomain, ApiMailbox } from "../spec";
import { INDIRECT_SCOPE, SUBJECT_OBJECT_KEYS, SUBJECT_SCOPE, SUBJECT_SCOPE_UNATTRIBUTABLE } from "../subject-scope";
import type { RoutingRulePatch, RoutingRuleRow, RoutingRuleValues, Store, SubjectCount } from "./types";

// A SQL literal: NULL, or an escaped quoted string.
const lit = (value: string | null) => (value === null ? "NULL" : `'${sqlEscape(value)}'`);

// The license_settings row the app's entitlement gate reads. instance_id is
// generated in SQL so this also works on a fresh database.
const licenceOn = (plan: string) => `INSERT INTO license_settings (id, instance_id, plan, state, features, seat_limit, updated_at)
VALUES ('default', lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), '${plan}', 'active', '[]', 1, strftime('%s','now'))
ON CONFLICT(id) DO UPDATE SET plan = excluded.plan, state = excluded.state, features = excluded.features, updated_at = excluded.updated_at;`;
const licenceOff = "UPDATE license_settings SET plan='community', state='inactive', features='[]', updated_at=strftime('%s','now') WHERE id='default';";
const licenceStatus = "SELECT plan, state FROM license_settings WHERE id='default';";

export function makeLiveStore({
	db = "mailflare",
	local = false,
	url,
	name = "state",
}: {
	db?: string;
	local?: boolean;
	url?: string;
	name?: string;
}): Store {
	let adminRow: { id: string; email: string } | null = null;
	let base = "";
	let key = "";
	let keyId: string | null = null;

	const sql = (statement: string) => d1(statement, { db, local });

	// A table is in scope directly, or through the chain of parents that own it. Shared by
	// the report and the erasure, so they can never disagree about what is the subject's.
	const subjectPredicate = (userId: string, quotedMailboxes: string) => {
		const predicate = (table: string, seen: Set<string> = new Set()): string | null => {
			if (seen.has(table)) return null;
			seen.add(table);
			const scope = SUBJECT_SCOPE.find((entry) => entry.table === table);
			if (scope) {
				const parts = (scope.userColumns ?? []).map((column) => `${column}='${sqlEscape(userId)}'`);
				if (scope.mailboxColumn && quotedMailboxes) parts.push(`${scope.mailboxColumn} IN (${quotedMailboxes})`);
				return parts.length > 0 ? parts.join(" OR ") : null;
			}
			const link = INDIRECT_SCOPE.find((entry) => entry.table === table);
			if (!link) return null;
			const inner = predicate(link.parent, seen);
			return inner ? `${link.column} IN (SELECT id FROM "${link.parent}" WHERE ${inner})` : null;
		};
		return predicate;
	};

	// Domains are infrastructure, not just rows: deleting one orphans its Cloudflare DNS and
	// Email Routing. Reported, never silently done.
	const ERASE_SKIPPED = [{ table: "domains", reason: "infrastructure — remove with --cleanup --remove-domain" }];

	// The admin is only needed by the SQL paths that record a user id.
	const admin = () => {
		if (!adminRow) {
			adminRow = findAdmin({ db, local });
			if (!adminRow) throw new Error("No admin user found — is the instance set up?");
		}
		return adminRow;
	};

	const mintAdminKey = () => {
		const { fullKey, prefix, hash } = generateApiKey();
		const id = newId("key");
		sql(`INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, mailbox_scope_enabled, created_at)
		    VALUES ('${sqlEscape(id)}', 'legacy', '${sqlEscape(admin().id)}', '${sqlEscape(name)}', '${sqlEscape(prefix)}', '${sqlEscape(hash)}', '${sqlEscape(JSON.stringify(ADMIN_API_KEY_SCOPES))}', 0, strftime('%s','now'));`);
		return { fullKey, keyId: id };
	};

	// The origin and the temporary key are resolved on the FIRST HTTP call, so a run
	const auth = async () => {
		if (keyId) return base;
		base = (await resolveInstanceUrl({ url })) ?? "";
		if (!base) throw new Error("Could not determine the instance URL. Pass --url or set MAILFLARE_URL.");
		const minted = mintAdminKey();
		key = minted.fullKey;
		keyId = minted.keyId;
		return base;
	};
	const call = async (path: string, options: { method?: string; body?: unknown } = {}) => request(await auth(), path, { key, ...options });

	return {
		get base() {
			return base;
		},
		get admin() {
			return admin();
		},

		async currentMx(hostname) {
			const token = process.env.CLOUDFLARE_API_TOKEN?.trim() || keychain("CLOUDFLARE_API_TOKEN");
			if (!token) return null;
			const zone = await cfApi<Array<{ id: string }>>(`/zones?name=${encodeURIComponent(hostname)}`, token);
			const zoneId = zone?.result?.[0]?.id;
			if (!zoneId) return null;
			const records = await cfApi<Array<{ priority?: number; content?: string }>>(`/zones/${zoneId}/dns_records?type=MX&per_page=100`, token);
			return records?.result ?? null;
		},

		async listDomains() {
			const res = await call("/api/v1/domains");
			return (res.json?.domains ?? []) as ApiDomain[];
		},
		onboardDomain: (body) => call("/api/v1/domains", { method: "POST", body }),
		removeDomain: (domainId) => call(`/api/v1/domains/${domainId}`, { method: "DELETE" }),

		async listMailboxes() {
			const res = await call("/api/v1/mailboxes");
			return (res.json?.mailboxes ?? []) as ApiMailbox[];
		},
		createMailbox: (body) => call("/api/v1/mailboxes", { method: "POST", body }),
		deleteMailbox: (mailboxId) => call(`/api/v1/mailboxes/${mailboxId}`, { method: "DELETE" }),
		mailboxOwnerId(mailboxId) {
			const [row] = sql(`SELECT user_id FROM mailboxes WHERE id='${sqlEscape(mailboxId)}';`);
			return row?.user_id ?? null;
		},

		async listAccounts() {
			const res = await call("/api/v1/accounts");
			return (res.json?.accounts ?? []) as ApiAccount[];
		},
		createAccount: (body) => call("/api/v1/accounts", { method: "POST", body }),
		updateAccount: (accountId, body) => call(`/api/v1/accounts/${accountId}`, { method: "PATCH", body }),

		userIdByEmail(email) {
			const [row] = sql(`SELECT id FROM users WHERE lower(email)='${sqlEscape(email.trim().toLowerCase())}' LIMIT 1;`);
			return row?.id ?? null;
		},
		accessPermission(mailboxId, userId) {
			const [row] = sql(
				`SELECT permission FROM mailbox_access WHERE mailbox_id='${sqlEscape(mailboxId)}' AND user_id='${sqlEscape(userId)}';`,
			);
			return row?.permission ?? null;
		},
		grantAccess(mailboxId, userId, permission) {
			sql(`INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at)
			    VALUES ('${newId("mac")}', '${sqlEscape(mailboxId)}', '${sqlEscape(userId)}', '${sqlEscape(permission)}', strftime('%s','now'))
			    ON CONFLICT(mailbox_id, user_id) DO UPDATE SET permission=excluded.permission;`);
		},
		revokeAccess(mailboxId, userId) {
			sql(`DELETE FROM mailbox_access WHERE mailbox_id='${sqlEscape(mailboxId)}' AND user_id='${sqlEscape(userId)}';`);
		},

		routingRule(domainId, pattern, action) {
			const [row] = sql(
				`SELECT id, match_value, forward_to, keep_copy, mailbox_id, reject_reason, priority, enabled
				 FROM routing_rules
				 WHERE domain_id='${sqlEscape(domainId)}' AND scope='domain' AND pattern='${sqlEscape(pattern)}' AND action='${sqlEscape(action)}';`,
			);
			return (row as RoutingRuleRow) ?? null;
		},
		insertRoutingRule(v: RoutingRuleValues) {
			sql(`INSERT INTO routing_rules (id, user_id, domain_id, scope, name, enabled, pattern, match_field, match_operator, match_value, action, forward_to, keep_copy, reject_reason, priority, created_at)
			    VALUES ('${newId("rr")}', '${sqlEscape(v.userId)}', '${sqlEscape(v.domainId)}', 'domain', '${sqlEscape(v.name)}', ${v.enabled}, '${sqlEscape(v.pattern)}', '${sqlEscape(v.matchField)}', '${sqlEscape(v.matchOperator)}', '${sqlEscape(v.matchValue)}', '${sqlEscape(v.action)}', ${lit(v.forwardTo)}, ${v.keepCopy}, ${lit(v.rejectReason)}, ${v.priority}, strftime('%s','now'));`);
		},
		updateRoutingRule(ruleId, patch: RoutingRulePatch) {
			sql(`UPDATE routing_rules SET match_value='${sqlEscape(patch.matchValue)}', forward_to=${lit(patch.forwardTo)}, keep_copy=${patch.keepCopy}, mailbox_id=${lit(patch.mailboxId)}, reject_reason=${lit(patch.rejectReason)}, priority=${patch.priority}, enabled=${patch.enabled} WHERE id='${sqlEscape(ruleId)}';`);
		},
		deleteRoutingRule(domainId, pattern, action) {
			sql(`DELETE FROM routing_rules WHERE domain_id='${sqlEscape(domainId)}' AND scope='domain' AND pattern='${sqlEscape(pattern)}' AND action='${sqlEscape(action)}';`);
		},

		mcpKey(userId, name) {
			const [row] = sql(
				`SELECT id FROM api_keys WHERE user_id='${sqlEscape(userId)}' AND kind='mcp' AND name='${sqlEscape(name)}';`,
			);
			return row ? { id: row.id } : null;
		},
		createMcpKey({ name: mcpName, scopes, mailboxIds }) {
			const { fullKey, prefix, hash } = generateApiKey();
			const id = newId("key");
			sql(`INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, mailbox_scope_enabled, created_at)
			    VALUES ('${sqlEscape(id)}', 'mcp', '${sqlEscape(admin().id)}', '${sqlEscape(mcpName)}', '${sqlEscape(prefix)}', '${sqlEscape(hash)}', '${sqlEscape(JSON.stringify(scopes))}', ${mailboxIds.length ? 1 : 0}, strftime('%s','now'));`);
			for (const mailboxId of mailboxIds) {
				sql(`INSERT INTO mcp_key_mailboxes (key_id, mailbox_id) VALUES ('${sqlEscape(id)}', '${sqlEscape(mailboxId)}');`);
			}
			return { fullKey };
		},
		deleteMcpKey(userId, mcpName) {
			sql(`DELETE FROM api_keys WHERE user_id='${sqlEscape(userId)}' AND kind='mcp' AND name='${sqlEscape(mcpName)}';`);
		},

		async subjectReport(email) {
			const userId = sql(`SELECT id FROM users WHERE lower(email)='${sqlEscape(email.trim().toLowerCase())}' LIMIT 1;`)[0]?.id ?? null;
			if (!userId) return { email, userId: null, mailboxIds: [], counts: [] };
			const mailboxIds = sql(`SELECT id FROM mailboxes WHERE user_id='${sqlEscape(userId)}';`).map((row) => String(row.id));
			const quotedMailboxes = mailboxIds.map((id) => `'${sqlEscape(id)}'`).join(", ");
			const predicate = subjectPredicate(userId, quotedMailboxes);
			const counts: SubjectCount[] = [];
			for (const table of [...SUBJECT_SCOPE.map((scope) => scope.table), ...INDIRECT_SCOPE.map((link) => link.table)]) {
				const where = predicate(table);
				if (!where) continue;
				const [row] = sql(`SELECT count(*) AS n FROM "${table}" WHERE ${where};`);
				counts.push({ table, rows: Number(row?.n ?? 0) });
			}
			// Surfaces the tables that cannot be attributed at all, so the caller can say so.
			for (const table of SUBJECT_SCOPE_UNATTRIBUTABLE) counts.push({ table, rows: -1 });
			return { email, userId, mailboxIds, counts };
		},
		async eraseSubject(email) {
			const trimmed = email.trim().toLowerCase();
			const userId = sql(`SELECT id FROM users WHERE lower(email)='${sqlEscape(trimmed)}' LIMIT 1;`)[0]?.id ?? null;
			if (!userId) return { email: trimmed, userId: null, deleted: [], objectKeys: [], objectsDeleted: 0, skipped: [] };

			const mailboxIds = sql(`SELECT id FROM mailboxes WHERE user_id='${sqlEscape(userId)}';`).map((row) => String(row.id));
			const quotedMailboxes = mailboxIds.map((id) => `'${sqlEscape(id)}'`).join(", ");
			const predicate = subjectPredicate(userId, quotedMailboxes);

			// The bytes first: once the rows are gone there is no way to find the objects.
			const objectKeys: string[] = [];
			for (const ref of SUBJECT_OBJECT_KEYS) {
				const where = ref.table === "users" ? `id='${sqlEscape(userId)}'` : predicate(ref.table);
				if (!where) continue;
				for (const row of sql(`SELECT "${ref.column}" AS k FROM "${ref.table}" WHERE ${where} AND "${ref.column}" IS NOT NULL;`)) {
					if (row.k) objectKeys.push(String(row.k));
				}
			}

			// Children before parents, and the user last: one batch, so it cannot half-apply.
			const indirect = INDIRECT_SCOPE.map((link) => link.table);
			const direct = SUBJECT_SCOPE.map((scope) => scope.table).filter((table) => table !== "users" && table !== "mailboxes");
			const order = [...indirect, ...direct, "mailboxes"];
			const deleted: SubjectCount[] = [];
			const statements: string[] = [];
			for (const table of order) {
				const where = predicate(table);
				if (!where) continue;
				const [row] = sql(`SELECT count(*) AS n FROM "${table}" WHERE ${where};`);
				deleted.push({ table, rows: Number(row?.n ?? 0) });
				statements.push(`DELETE FROM "${table}" WHERE ${where};`);
			}
			for (const ref of SUBJECT_OBJECT_KEYS) {
				const where = ref.table === "users" ? `id='${sqlEscape(userId)}'` : predicate(ref.table);
				if (where && !statements.some((statement) => statement.startsWith(`DELETE FROM "${ref.table}"`))) {
					statements.push(`DELETE FROM "${ref.table}" WHERE ${where};`);
				}
			}
			statements.push(`DELETE FROM users WHERE id='${sqlEscape(userId)}';`);
			sql(statements.join("\n"));

			const objectsDeleted = objectKeys.length > 0 ? r2DeleteObjects(objectKeys) : 0;
			return { email: trimmed, userId, deleted, objectKeys, objectsDeleted, skipped: ERASE_SKIPPED };
		},
		domainCount() {
			return Number(sql("SELECT count(*) AS n FROM domains;")[0]?.n ?? 0);
		},
		applyMigrations() {
			runMigrations({ db, local });
		},
		schemaPresent() {
			return sql("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%';").length > 0;
		},
		wipeData() {
			// FTS shadow tables are excluded: deleting from the base tables fires the
			const tables = sql("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' AND name NOT LIKE '%_fts%';");
			for (const row of tables) sql(`DELETE FROM "${String(row.name)}";`);
		},
		insertAdmin({ id, email, name, passwordHash }) {
			sql(`INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, can_manage_mailboxes, can_manage_domains, can_manage_users, created_at)
			    VALUES ('${sqlEscape(id)}', '${sqlEscape(email)}', '${sqlEscape(passwordHash)}', '${sqlEscape(name)}', 'admin', 1, 1, 1, 1, strftime('%s','now'));`);
		},

		licenseRow() {
			const [row] = sql(licenceStatus);
			return row ? { plan: String(row.plan), state: String(row.state) } : null;
		},
		setLicense(plan) {
			sql(plan === null ? licenceOff : licenceOn(plan));
		},

		workerSecrets() {
			return workerSecretNames();
		},
		pushSubscriptionCount() {
			return sql("SELECT id FROM push_subscriptions;").length;
		},
		clearPushSubscriptions() {
			sql("DELETE FROM push_subscriptions;");
		},
		firstAdminEmail() {
			const [row] = sql("SELECT email FROM users ORDER BY created_at LIMIT 1;");
			return row?.email ?? null;
		},
		async sendViaCloudflare({ from, to, subject, text, html }) {
			const token = process.env.CLOUDFLARE_API_TOKEN?.trim() || keychain("CLOUDFLARE_API_TOKEN");
			const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || keychain("CLOUDFLARE_ACCOUNT_ID");
			if (!token || !accountId) throw new Error("Missing CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID — export them, run via `fnox exec`, or store them in the keychain.");
			const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ from, to, subject, text, html }),
			});
			const payload = (await response.json().catch(() => null)) as { success?: boolean; errors?: unknown; result?: { message_id?: string } } | null;
			if (!response.ok || !payload?.success) throw new Error(`Cloudflare send failed (HTTP ${response.status}): ${JSON.stringify(payload?.errors ?? payload)}`);
			return { messageId: payload.result?.message_id };
		},
		async messageStatusBySubject(subject) {
			const [row] = sql(`SELECT status FROM messages WHERE subject='${sqlEscape(subject)}' LIMIT 1;`);
			return row ? { status: String(row.status) } : null;
		},
		async wait(ms) {
			sleep(ms);
		},

		dispose() {
			if (!keyId) return;
			sql(`DELETE FROM api_keys WHERE id='${sqlEscape(keyId)}';`);
			keyId = null;
		},
	};
}
