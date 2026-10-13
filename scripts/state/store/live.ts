// The live Store - the ONLY module in the reconciler that writes SQL.
import { is } from "drizzle-orm";
import { SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "@/db/schema";
import { newId } from "@/lib/ids";
import { ADMIN_API_KEY_SCOPES } from "@/lib/api/scopes";
import { generateApiKey } from "@/lib/api-keys";
import { apiError, applyMigrations, cfApi, credential, d1, r2DeleteObjects, request, resolveInstanceUrl, sleep, sqlEscape, workerSecretNames } from "../wrangler";
import type { Database, Row } from "../wrangler";
import type { ApiAccount, ApiDomain, ApiMailbox } from "../spec";
import { INDIRECT_SCOPE, SUBJECT_OBJECT_KEYS, SUBJECT_SCOPE, SUBJECT_SCOPE_UNATTRIBUTABLE, depthOf, subjectPredicate } from "../subject-scope";
import type { ManagedTable, SettingValue, SettingsRow, Store, SubjectCount } from "./types";

/** Which instance a store drives: its database, and how to reach its API. */
export type Instance = Database & {
	/** The origin, when known. Otherwise it is derived from the Worker's name. */
	url?: string;
	worker?: string;
	/** The bucket holding the instance's objects, for erasure, and the jurisdiction it is in. */
	bucket?: string;
	jurisdiction?: string;
};

// A SQL literal: NULL, a number, or an escaped quoted string.
const quote = (value: string) => `'${sqlEscape(value)}'`;
const lit = (value: SettingValue) => (value === null ? "NULL" : typeof value === "number" ? String(value) : quote(value));
const equals = (where: SettingsRow, columns: string[]) => columns.map((column) => (where[column] === null ? `${column} IS NULL` : `${column}=${lit(where[column])}`)).join(" AND ");

// The app's own schema: every table and column a generic row statement names is checked against
// it, so a typo fails here with a reason instead of at the database.
const COLUMNS = new Map(Object.values(schema).filter((value) => is(value, SQLiteTable)).map((table) => {
	const config = getTableConfig(table as SQLiteTable);
	return [config.name, new Set(config.columns.map((column) => column.name))];
}));
function columnsOf(table: ManagedTable, row: SettingsRow): string[] {
	const known = COLUMNS.get(table);
	if (!known) throw new Error(`no such table: ${table}`);
	const names = Object.keys(row);
	const unknown = names.filter((name) => !known.has(name));
	if (unknown.length > 0) throw new Error(`${table} has no column ${unknown.join(", ")}`);
	return names;
}
const hasColumn = (table: ManagedTable, column: string) => COLUMNS.get(table)?.has(column) ?? false;

// The rows the migrations seed (0009, 0012). A wipe empties every table, and the app updates
// these rows rather than upserting them, so a reset must put them back.
export const SEED_ROWS = [
	"INSERT INTO backup_settings (id, enabled, schedule_type, retention_enabled, retention_days, updated_at) VALUES ('default', 0, 'daily', 0, 30, unixepoch());",
	"INSERT INTO app_settings (id, app_name, updated_at) VALUES ('default', 'Mailflare', unixepoch());",
];

// instance_id is generated in SQL (a v4 uuid) so this also works on a database with no row.
const UUID = "lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))";
const licenceOn = (plan: string) => `INSERT INTO license_settings (id, instance_id, plan, state, features, seat_limit, updated_at)
VALUES ('default', ${UUID}, ${quote(plan)}, 'active', '[]', NULL, unixepoch())
ON CONFLICT(id) DO UPDATE SET plan = excluded.plan, state = excluded.state, updated_at = excluded.updated_at;`;
const licenceOff = "UPDATE license_settings SET plan='community', state='inactive', features='[]', updated_at=unixepoch() WHERE id='default';";

// A stale key is one a run left behind when it was killed. Nobody holds its secret.
const STALE_KEYS = "DELETE FROM api_keys WHERE kind='legacy' AND name='state' AND created_at < unixepoch() - 3600;";

export function makeLiveStore(instance: Instance): Store {
	let adminRow: { id: string; email: string } | null = null;
	let base = "";
	let key = "";
	let keyId: string | null = null;
	let minting: Promise<string> | null = null;

	const sql = (statement: string): Promise<Row[]> => d1(statement, instance);
	const batch = (statements: string[]) => sql(statements.join("\n"));

	// The primary admin when there is one: only it may create admin accounts.
	const admin = async () => {
		if (!adminRow) {
			const [row] = await sql("SELECT id, email FROM users WHERE role='admin' AND disabled=0 ORDER BY is_primary_admin DESC, created_at LIMIT 1;");
			if (!row) throw new Error("no admin user — is the instance set up? (`reset` makes one)");
			adminRow = { id: String(row.id), email: String(row.email) };
		}
		return adminRow;
	};

	// The origin and the temporary key are resolved on the FIRST HTTP call, so a run that only
	// touches instance data (licence, settings) needs neither.
	const auth = (): Promise<string> => {
		minting ??= (async () => {
			base = (await resolveInstanceUrl({ url: instance.url, worker: instance.worker })) ?? "";
			if (!base) throw new Error("could not determine the instance URL — give the server a url, pass --url, or set MAILFLARE_URL");
			const { fullKey, prefix, hash } = generateApiKey();
			const id = newId("key");
			const owner = await admin();
			await batch([
				STALE_KEYS,
				`INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, mailbox_scope_enabled, created_at)
				 VALUES (${quote(id)}, 'legacy', ${quote(owner.id)}, 'state', ${quote(prefix)}, ${quote(hash)}, ${quote(JSON.stringify(ADMIN_API_KEY_SCOPES))}, 0, unixepoch());`,
			]);
			key = fullKey;
			keyId = id;
			return base;
		})();
		return minting;
	};
	const call = async (path: string, options: { method?: string; body?: unknown } = {}) => request(await auth(), path, { key, ...options });
	// A list that fails is not an empty list: reading "nothing exists" from a 401 would plan
	// to create everything, or report a teardown as done.
	const list = async <T>(path: string, field: string): Promise<T[]> => {
		const res = await call(path);
		if (res.status !== 200) throw new Error(`GET ${path} failed: ${apiError(res)}`);
		return (res.json?.[field] ?? []) as T[];
	};

	const subject = async (email: string) => {
		const [row] = await sql(`SELECT id, is_primary_admin FROM users WHERE lower(email)=${quote(email.trim().toLowerCase())} LIMIT 1;`);
		if (!row) return null;
		const userId = String(row.id);
		const mailboxIds = (await sql(`SELECT id FROM mailboxes WHERE user_id=${quote(userId)};`)).map((mailbox) => String(mailbox.id));
		return { userId, mailboxIds, primaryAdmin: Boolean(row.is_primary_admin), where: (table: string) => subjectPredicate(table, userId, mailboxIds, quote) };
	};
	const subjectTables = [...SUBJECT_SCOPE.map((scope) => scope.table), ...INDIRECT_SCOPE.map((link) => link.table)];

	const subjectReport: Store["subjectReport"] = async (email) => {
		const found = await subject(email);
		if (!found) return { email, userId: null, mailboxIds: [], counts: [], blockers: [] };
		// One statement for every table: a count per table is a round trip per table.
		const scoped = subjectTables.map((table) => ({ table, where: found.where(table) })).filter((entry) => entry.where);
		const [row] = await sql(`SELECT ${scoped.map((entry, index) => `(SELECT count(*) FROM "${entry.table}" WHERE ${entry.where}) AS c${index}`).join(", ")};`);
		const counts: SubjectCount[] = scoped.map((entry, index) => ({ table: entry.table, rows: Number(row?.[`c${index}`] ?? 0) }));
		// Surfaces the tables that cannot be attributed at all, so the caller can say so.
		for (const table of SUBJECT_SCOPE_UNATTRIBUTABLE) counts.push({ table, rows: -1 });

		// Deleting a user cascades to the domains they own, and from there to every mailbox on
		// them - other people's included. That is never what erasing one person means.
		const blockers: string[] = [];
		const owned = (await sql(`SELECT hostname FROM domains WHERE user_id=${quote(found.userId)};`)).map((domain) => String(domain.hostname));
		if (owned.length > 0) blockers.push(`owns ${owned.length} domain(s) (${owned.join(", ")}) — deleting the account would delete every mailbox on them`);
		if (found.primaryAdmin) blockers.push("is the primary admin — the instance cannot run without one");
		return { email, userId: found.userId, mailboxIds: found.mailboxIds, counts, blockers };
	};

	return {
		get base() {
			return base;
		},
		admin,

		async currentMx(hostname) {
			const token = credential("CLOUDFLARE_API_TOKEN");
			if (!token) return null;
			const zone = await cfApi<Array<{ id: string }>>(`/zones?name=${encodeURIComponent(hostname)}`, token);
			const zoneId = zone?.result?.[0]?.id;
			if (!zoneId) return null;
			const records = await cfApi<Array<{ priority?: number; content?: string }>>(`/zones/${zoneId}/dns_records?type=MX&per_page=100`, token);
			return records?.result ?? null;
		},

		async routedElsewhere(hostname) {
			const token = credential("CLOUDFLARE_API_TOKEN");
			if (!token || instance.local) return {};
			const zone = await cfApi<Array<{ id: string }>>(`/zones?name=${encodeURIComponent(hostname)}`, token);
			const zoneId = zone?.result?.[0]?.id;
			if (!zoneId) return {};
			type Rule = { enabled?: boolean; matchers?: Array<{ type?: string; field?: string; value?: string }>; actions?: Array<{ type?: string; value?: string[] }> };
			const rules = await cfApi<Rule[]>(`/zones/${zoneId}/email/routing/rules?per_page=50`, token);
			const elsewhere: Record<string, string> = {};
			for (const rule of rules?.result ?? []) {
				const address = rule.matchers?.find((matcher) => matcher.type === "literal" && matcher.field === "to")?.value?.toLowerCase();
				const action = rule.actions?.[0];
				const ours = action?.type === "worker" && (action.value ?? []).includes(instance.worker ?? "");
				if (address && rule.enabled !== false && action && !ours) elsewhere[address] = `${action.type}${action.value?.length ? ` to ${action.value.join(", ")}` : ""}`;
			}
			return elsewhere;
		},

		listDomains: () => list<ApiDomain>("/api/v1/domains", "domains"),
		onboardDomain: (body) => call("/api/v1/domains", { method: "POST", body }),
		removeDomain: (domainId) => call(`/api/v1/domains/${domainId}`, { method: "DELETE" }),

		listMailboxes: () => list<ApiMailbox>("/api/v1/mailboxes", "mailboxes"),
		createMailbox: (body) => call("/api/v1/mailboxes", { method: "POST", body }),
		updateMailbox: (mailboxId, body) => call(`/api/v1/mailboxes/${mailboxId}`, { method: "PATCH", body }),
		deleteMailbox: (mailboxId) => call(`/api/v1/mailboxes/${mailboxId}`, { method: "DELETE" }),

		async listAccounts() {
			const res = await call("/api/v1/accounts");
			if (res.status === 200) return (res.json?.accounts ?? []) as ApiAccount[];
			// The route needs a Pro or Team licence. Without one the accounts still exist, and a
			// plan made before the licence is applied must see them.
			if (res.status !== 403) throw new Error(`GET /api/v1/accounts failed: ${apiError(res)}`);
			const owner = await admin();
			const rows = await sql(`SELECT id, email, name, role, is_primary_admin, disabled, can_manage_mailboxes, can_manage_domains, can_manage_users FROM users WHERE id=${quote(owner.id)} OR created_by_user_id=${quote(owner.id)};`);
			return rows.map((row) => ({
				id: String(row.id), email: String(row.email), name: String(row.name ?? ""), role: row.role, isPrimaryAdmin: Boolean(row.is_primary_admin), disabled: Boolean(row.disabled),
				canManageMailboxes: Boolean(row.can_manage_mailboxes), canManageDomains: Boolean(row.can_manage_domains), canManageUsers: Boolean(row.can_manage_users),
			})) as ApiAccount[];
		},
		createAccount: (body) => call("/api/v1/accounts", { method: "POST", body }),
		updateAccount: (accountId, body) => call(`/api/v1/accounts/${accountId}`, { method: "PATCH", body }),

		async userIdByEmail(email) {
			const [row] = await sql(`SELECT id FROM users WHERE lower(email)=${quote(email.trim().toLowerCase())} LIMIT 1;`);
			return row ? String(row.id) : null;
		},
		async accessList(mailboxIds) {
			if (mailboxIds.length === 0) return [];
			const rows = await sql(`SELECT a.mailbox_id, a.user_id, a.permission, u.email FROM mailbox_access a JOIN users u ON u.id = a.user_id WHERE a.mailbox_id IN (${mailboxIds.map(quote).join(", ")});`);
			return rows.map((row) => ({ mailboxId: String(row.mailbox_id), userId: String(row.user_id), email: String(row.email).toLowerCase(), permission: String(row.permission) }));
		},
		async grantAccess(mailboxId, userId, permission) {
			const owner = await admin();
			await sql(`INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_by_user_id, created_at)
			    VALUES (${quote(newId("mac"))}, ${quote(mailboxId)}, ${quote(userId)}, ${quote(permission)}, ${quote(owner.id)}, unixepoch())
			    ON CONFLICT(mailbox_id, user_id) DO UPDATE SET permission=excluded.permission;`);
		},
		async revokeAccess(mailboxId, userId) {
			await sql(`DELETE FROM mailbox_access WHERE mailbox_id=${quote(mailboxId)} AND user_id=${quote(userId)};`);
		},

		async routingRules(domainId) {
			const rows = await sql(`SELECT id, pattern, action, match_value, forward_to, keep_copy, mailbox_id, reject_reason, priority, enabled FROM routing_rules WHERE domain_id=${quote(domainId)} AND scope='domain' ORDER BY created_at;`);
			return rows as never;
		},
		async insertRoutingRule(v) {
			await sql(`INSERT INTO routing_rules (id, user_id, domain_id, scope, name, enabled, pattern, match_field, match_operator, match_value, action, mailbox_id, forward_to, keep_copy, reject_reason, priority, created_at)
			    VALUES (${quote(newId("rr"))}, ${quote(v.userId)}, ${quote(v.domainId)}, 'domain', ${quote(v.name)}, ${v.enabled}, ${quote(v.pattern)}, ${quote(v.matchField)}, ${quote(v.matchOperator)}, ${quote(v.matchValue)}, ${quote(v.action)}, ${lit(v.mailboxId)}, ${lit(v.forwardTo)}, ${v.keepCopy}, ${lit(v.rejectReason)}, ${v.priority}, unixepoch());`);
		},
		async updateRoutingRule(ruleId, patch) {
			await sql(`UPDATE routing_rules SET match_value=${quote(patch.matchValue)}, forward_to=${lit(patch.forwardTo)}, keep_copy=${patch.keepCopy}, mailbox_id=${lit(patch.mailboxId)}, reject_reason=${lit(patch.rejectReason)}, priority=${patch.priority}, enabled=${patch.enabled} WHERE id=${quote(ruleId)};`);
		},
		async deleteRoutingRule(ruleId) {
			await sql(`DELETE FROM routing_rules WHERE id=${quote(ruleId)};`);
		},

		async mcpKey(name) {
			const owner = await admin();
			const [row] = await sql(
				`SELECT k.id, k.scopes, k.mailbox_scope_enabled, (SELECT group_concat(mailbox_id) FROM mcp_key_mailboxes WHERE key_id=k.id) AS mailboxes
				 FROM api_keys k WHERE k.user_id=${quote(owner.id)} AND k.kind='mcp' AND k.name=${quote(name)} ORDER BY k.created_at LIMIT 1;`,
			);
			if (!row) return null;
			let scopes: string[] = [];
			try {
				scopes = JSON.parse(String(row.scopes));
			} catch {
				// an unreadable scope list is a key with no scopes, which the plan will correct
			}
			return { id: String(row.id), scopes, mailboxIds: row.mailbox_scope_enabled ? String(row.mailboxes ?? "").split(",").filter(Boolean) : null };
		},
		async mcpKeyNames() {
			const owner = await admin();
			return (await sql(`SELECT id, name FROM api_keys WHERE user_id=${quote(owner.id)} AND kind='mcp' ORDER BY created_at;`)).map((row) => ({ id: String(row.id), name: String(row.name) }));
		},
		async domainNames() {
			return (await sql("SELECT hostname FROM domains ORDER BY hostname;")).map((row) => String(row.hostname).toLowerCase());
		},
		async createMcpKey({ name, scopes, mailboxIds }) {
			const { fullKey, prefix, hash } = generateApiKey();
			const id = newId("key");
			const owner = await admin();
			await batch([
				`INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, mailbox_scope_enabled, created_at)
				 VALUES (${quote(id)}, 'mcp', ${quote(owner.id)}, ${quote(name)}, ${quote(prefix)}, ${quote(hash)}, ${quote(JSON.stringify(scopes))}, ${mailboxIds ? 1 : 0}, unixepoch());`,
				...(mailboxIds ?? []).map((mailboxId) => `INSERT INTO mcp_key_mailboxes (key_id, mailbox_id) VALUES (${quote(id)}, ${quote(mailboxId)});`),
			]);
			return { fullKey };
		},
		async updateMcpKey(keyId, { scopes, mailboxIds }) {
			await batch([
				`UPDATE api_keys SET scopes=${quote(JSON.stringify(scopes))}, mailbox_scope_enabled=${mailboxIds ? 1 : 0} WHERE id=${quote(keyId)};`,
				`DELETE FROM mcp_key_mailboxes WHERE key_id=${quote(keyId)};`,
				...(mailboxIds ?? []).map((mailboxId) => `INSERT INTO mcp_key_mailboxes (key_id, mailbox_id) VALUES (${quote(keyId)}, ${quote(mailboxId)});`),
			]);
		},
		async deleteMcpKey(keyId) {
			await sql(`DELETE FROM api_keys WHERE id=${quote(keyId)} AND kind='mcp';`);
		},

		async licenseRow() {
			const [row] = await sql("SELECT plan, state FROM license_settings WHERE id='default';");
			return row ? { plan: String(row.plan), state: String(row.state) } : null;
		},
		async setLicense(plan) {
			await sql(plan === null ? licenceOff : licenceOn(plan));
		},

		async rows(table, where) {
			const columns = columnsOf(table, where);
			return (await sql(`SELECT * FROM ${table}${columns.length > 0 ? ` WHERE ${equals(where, columns)}` : ""};`)) as SettingsRow[];
		},
		async insertRow(table, values) {
			const stamped = { ...values };
			const columns = columnsOf(table, stamped);
			const stamps = ["created_at", "updated_at"].filter((column) => hasColumn(table, column) && !(column in stamped));
			await sql(`INSERT INTO ${table} (${[...columns, ...stamps].join(", ")}) VALUES (${[...columns.map((column) => lit(stamped[column])), ...stamps.map(() => "unixepoch()")].join(", ")});`);
		},
		async updateRows(table, where, values) {
			const keys = columnsOf(table, where);
			const columns = columnsOf(table, values);
			if (keys.length === 0) throw new Error(`refusing to update every row of ${table}`);
			const sets = [...columns.map((column) => `${column}=${lit(values[column])}`), ...(hasColumn(table, "updated_at") && !("updated_at" in values) ? ["updated_at=unixepoch()"] : [])];
			await sql(`UPDATE ${table} SET ${sets.join(", ")} WHERE ${equals(where, keys)};`);
		},
		async deleteRows(table, where) {
			const keys = columnsOf(table, where);
			if (keys.length === 0) throw new Error(`refusing to delete every row of ${table}`);
			await sql(`DELETE FROM ${table} WHERE ${equals(where, keys)};`);
		},
		async upsertRow(table, key, values) {
			const keys = columnsOf(table, key);
			const columns = columnsOf(table, values);
			const stamps = ["created_at", "updated_at"].filter((column) => hasColumn(table, column) && !(column in values));
			const all = { ...key, ...values };
			const names = [...keys, ...columns];
			const updates = [...columns.map((column) => `${column}=excluded.${column}`), ...(stamps.includes("updated_at") ? ["updated_at=excluded.updated_at"] : [])];
			await sql(`INSERT INTO ${table} (${[...names, ...stamps].join(", ")}) VALUES (${[...names.map((column) => lit(all[column])), ...stamps.map(() => "unixepoch()")].join(", ")})
			    ON CONFLICT(${keys.join(", ")}) DO UPDATE SET ${updates.join(", ")};`);
		},

		subjectReport,
		async eraseSubject(email) {
			const trimmed = email.trim().toLowerCase();
			const report = await subjectReport(trimmed);
			const found = await subject(trimmed);
			if (!found) return { email: trimmed, userId: null, deleted: [], objectKeys: [], objectsDeleted: 0 };
			if (report.blockers.length > 0) throw new Error(`cannot erase ${trimmed}: ${report.blockers.join("; ")}`);

			// The bytes first: once the rows are gone there is no way to find the objects.
			const objectKeys: string[] = [];
			for (const ref of SUBJECT_OBJECT_KEYS) {
				const where = ref.table === "users" ? `id=${quote(found.userId)}` : found.where(ref.table);
				if (!where) continue;
				for (const row of await sql(`SELECT "${ref.column}" AS k FROM "${ref.table}" WHERE ${where} AND "${ref.column}" IS NOT NULL;`)) objectKeys.push(String(row.k));
			}

			// Deepest children first and the user last, as one batch so it cannot half-apply.
			// Domains are not here: the subject owns none, or the blockers would have stopped this.
			const order = subjectTables.filter((table) => table !== "domains" && table !== "mailboxes").sort((a, b) => depthOf(b) - depthOf(a));
			const statements = [...order, "mailboxes"].map((table) => ({ table, where: found.where(table) })).filter((entry) => entry.where).map((entry) => `DELETE FROM "${entry.table}" WHERE ${entry.where};`);
			await batch([...statements, `DELETE FROM users WHERE id=${quote(found.userId)};`]);

			let objectsDeleted = 0;
			if (objectKeys.length > 0) {
				if (!instance.bucket) throw new Error(`the rows are gone, but ${objectKeys.length} object(s) could not be deleted: no bucket is known for this server`);
				objectsDeleted = await r2DeleteObjects(objectKeys, { bucket: instance.bucket, local: instance.local, jurisdiction: instance.jurisdiction, config: instance.config });
			}
			return { email: trimmed, userId: found.userId, deleted: report.counts.filter((count) => count.rows > 0), objectKeys, objectsDeleted };
		},

		applyMigrations: () => applyMigrations(instance),
		async userCount() {
			if ((await sql("SELECT name FROM sqlite_master WHERE type='table' AND name='users';")).length === 0) return null;
			return Number((await sql("SELECT count(*) AS n FROM users;"))[0]?.n ?? 0);
		},
		async schemaPresent() {
			return (await sql("SELECT name FROM sqlite_master WHERE type='table' AND name='users';")).length > 0;
		},
		async domainCount() {
			return Number((await sql("SELECT count(*) AS n FROM domains;"))[0]?.n ?? 0);
		},
		async wipeData() {
			// FTS shadow tables are excluded: deleting from the base table fires the triggers that
			// empty them. One batch, so a wipe cannot stop half way.
			const tables = await sql("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' AND name NOT LIKE '%_fts%';");
			await batch([...tables.map((row) => `DELETE FROM "${String(row.name)}";`), ...SEED_ROWS]);
			// Everything this store remembered about the instance is gone with it.
			adminRow = null;
			key = "";
			keyId = null;
			minting = null;
		},
		async insertAdmin({ id, email, name, passwordHash }) {
			await sql(`INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, can_manage_mailboxes, can_manage_domains, can_manage_users, created_at)
			    VALUES (${quote(id)}, ${quote(email)}, ${quote(passwordHash)}, ${quote(name)}, 'admin', 1, 1, 1, 1, unixepoch());`);
		},

		workerSecrets: () => workerSecretNames(instance.config),
		async pushSubscriptionCount() {
			return Number((await sql("SELECT count(*) AS n FROM push_subscriptions;"))[0]?.n ?? 0);
		},
		async clearPushSubscriptions() {
			await sql("DELETE FROM push_subscriptions;");
		},
		async firstAdminEmail() {
			const [row] = await sql("SELECT email FROM users WHERE role='admin' ORDER BY is_primary_admin DESC, created_at LIMIT 1;");
			return row ? String(row.email) : null;
		},
		async sendViaCloudflare({ from, to, subject: title, text, html }) {
			const token = credential("CLOUDFLARE_API_TOKEN");
			const accountId = credential("CLOUDFLARE_ACCOUNT_ID");
			if (!token || !accountId) throw new Error("missing CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID — export them, run via `fnox exec`, or store them in the keychain");
			const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ from, to, subject: title, text, html }),
			});
			const payload = (await response.json().catch(() => null)) as { success?: boolean; errors?: unknown; result?: { message_id?: string } } | null;
			if (!response.ok || !payload?.success) throw new Error(`Cloudflare send failed (HTTP ${response.status}): ${JSON.stringify(payload?.errors ?? payload)}`);
			return { messageId: payload.result?.message_id };
		},
		async messageStatusBySubject(title) {
			const [row] = await sql(`SELECT status FROM messages WHERE subject=${quote(title)} LIMIT 1;`);
			return row ? { status: String(row.status) } : null;
		},
		wait: sleep,

		async dispose() {
			if (!keyId) return;
			const id = keyId;
			keyId = null;
			await sql(`DELETE FROM api_keys WHERE id=${quote(id)};`);
		},
	};
}
