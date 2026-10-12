// The live Store - the ONLY module in the provisioner that talks to D1 directly.
//
// Domains, mailboxes and accounts go over the app's key-authenticated /api/v1
// surface. API/MCP keys, mailbox-access grants and domain routing rules have no
// key-authenticated route in the app (they require a session cookie or a Team
// session), so they are written with SQL. Confining that SQL here keeps the column
// names and the escaping in exactly one place instead of scattering them.
import { newId } from "@/lib/ids";
import { generateApiKey } from "@/lib/api-keys";
import { cfApi, d1, keychain, request, sqlEscape } from "../joeblew999-lib";
import type { ApiAccount, ApiDomain, ApiMailbox } from "./types";
import type { RoutingRulePatch, RoutingRuleRow, RoutingRuleValues, Store } from "./store-types";

// A SQL literal: NULL, or an escaped quoted string.
const lit = (value: string | null) => (value === null ? "NULL" : `'${sqlEscape(value)}'`);

export function makeLiveStore({
	base,
	key,
	admin,
	db,
	local,
}: {
	base: string;
	key: string;
	admin: { id: string; email: string };
	db: string;
	local: boolean;
}): Store {
	const sql = (statement: string) => d1(statement, { db, local });
	const call = (path: string, options: { method?: string; body?: unknown } = {}) => request(base, path, { key, ...options });

	return {
		base,
		admin,

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
		createMcpKey({ name, scopes, mailboxIds }) {
			const { fullKey, prefix, hash } = generateApiKey();
			const id = newId("key");
			sql(`INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, mailbox_scope_enabled, created_at)
			    VALUES ('${sqlEscape(id)}', 'mcp', '${sqlEscape(admin.id)}', '${sqlEscape(name)}', '${sqlEscape(prefix)}', '${sqlEscape(hash)}', '${sqlEscape(JSON.stringify(scopes))}', ${mailboxIds.length ? 1 : 0}, strftime('%s','now'));`);
			for (const mailboxId of mailboxIds) {
				sql(`INSERT INTO mcp_key_mailboxes (key_id, mailbox_id) VALUES ('${sqlEscape(id)}', '${sqlEscape(mailboxId)}');`);
			}
			return { fullKey };
		},
		deleteMcpKey(userId, name) {
			sql(`DELETE FROM api_keys WHERE user_id='${sqlEscape(userId)}' AND kind='mcp' AND name='${sqlEscape(name)}';`);
		},
	};
}
