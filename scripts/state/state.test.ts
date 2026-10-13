// Drives the whole reconciler through the Store seam: a full lifecycle with no D1, no Workers
// binding and no network. The fake is ours, so green here is necessary, not sufficient - the
// sandbox is what runs the real app. Run with `npm run state:test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { is } from "drizzle-orm";
import { SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "@/db/schema";
import { BACKUP_TABLE_GROUPS } from "@/lib/backups/table-groups";
import { UsageError, parseCli } from "./args";
import { dangling, holds, parseBackup, scrub, type BackupDocument } from "./backup";
import { coloOf, countryOfColo, hasColo, loadColos, parseColoList } from "./colos";
import { makeContext } from "./context";
import { deploySteps, secretsFor } from "./deploy";
import { loadDocuments, loadProject, loadProjects } from "./document";
import { run } from "./driver";
import { conform, reporter, rounds } from "./conform";
import { resolveInstance, runFleet, type FleetDeps } from "./fleet";
import { fleetMap, fleetVersion } from "./router";
import { memoryVault } from "./vault";
import { foreignMx } from "./resources/domain";
import { scrubBackups } from "./resources/erased";
import { limiter, runDocuments } from "./runner";
import { SOURCE_CHANGES, SOURCE_CHANGES_MADE } from "./src-changes";
import { BACKUP_GROUPS, MCP_SCOPES, PLACEMENTS } from "./spec";
import { SEED_ROWS, type Instance } from "./store/live";
import { INDIRECT_SCOPE, INSTANCE_OBJECT_KEYS, INSTANCE_TABLES, SUBJECT_OBJECT_KEYS, SUBJECT_SCOPE, SUBJECT_SCOPE_UNATTRIBUTABLE, depthOf, digestOf, isSubjectScoped, subjectLines, subjectPredicate, subjectTotal, subjectUnknown, tombstones } from "./subject-scope";
import { erasedAndDeclared, validateInstanceDocument, validateServer, validateSpec, validateTenantDocument } from "./validate";
import { deploymentFor, serverConfig, stripJsonc, type WranglerConfig } from "./wrangler";
import type { Flags } from "./flags";
import type { Spec } from "./spec";
import type { McpKeyRow, SettingsRow, Store } from "./store/types";

const ok = (json: unknown = {}) => ({ status: 200, text: "", json });
const created = (json: unknown = {}) => ({ status: 201, text: "", json });
const refused = (status: number, error: string) => ({ status, text: error, json: { error } });

type Box = { id: string; domainId: string; localPart: string; hostname: string; displayName: string | null; type: string; userId: string };
type Account = { id: string; email: string; name: string; role: string; disabled: boolean; canManageMailboxes: boolean; isPrimaryAdmin?: boolean };
type Seed = {
	domains?: Array<{ id: string; hostname: string }>;
	mailboxes?: Array<Partial<Box> & { id: string; localPart: string }>;
	accounts?: Array<Partial<Account> & { id: string; email: string }>;
	access?: Array<{ mailboxId: string; userId: string; permission: string }>;
	routing?: Array<Record<string, unknown>>;
	keys?: Array<McpKeyRow & { name: string }>;
	license?: { plan: string; state: string } | null;
	settings?: { app_settings?: SettingsRow; backup_settings?: SettingsRow };
	mx?: Array<{ content: string }>;
	elsewhere?: Record<string, string>;
	pushSubscriptions?: number;
	schema?: boolean;
};

/** The app in miniature: enough of its behaviour that a lifecycle means something. */
function fakeStore(seed: Seed = {}) {
	const state = {
		domains: seed.domains ?? [],
		mailboxes: (seed.mailboxes ?? []).map((box) => ({ domainId: "d1", hostname: seed.domains?.[0]?.hostname ?? "dev.example", displayName: null, type: "personal", userId: "u_admin", ...box })) as Box[],
		accounts: (seed.accounts ?? []).map((account) => ({ name: account.email.split("@")[0], role: "user", disabled: false, canManageMailboxes: false, ...account })) as Account[],
		access: seed.access ?? [],
		routing: (seed.routing ?? []) as Array<Record<string, unknown>>,
		keys: seed.keys ?? [],
		license: seed.license ?? null,
		// Every other table the generic row methods touch, and what they added to people and boxes.
		tables: { app_settings: seed.settings?.app_settings ? [{ id: "default", ...seed.settings.app_settings }] : [], backup_settings: seed.settings?.backup_settings ? [{ id: "default", ...seed.settings.backup_settings }] : [] } as Record<string, SettingsRow[]>,
		extra: new Map<string, SettingsRow>(),
		pushSubscriptions: seed.pushSubscriptions ?? 0,
		// The bucket: backups are objects in it, as they are on a server.
		objects: new Map<string, string>(),
		sent: [] as string[],
		schema: seed.schema ?? true,
		admin: { id: "u_admin", email: "admin@instance.test" } as { id: string; email: string } | null,
	};
	const calls: string[] = [];
	let seq = 0;
	const hostnameOf = (domainId: string) => state.domains.find((domain) => domain.id === domainId)?.hostname ?? "";
	// `users` and `mailboxes` are the fake's own people and boxes, seen as rows.
	const all = (table: string): SettingsRow[] => {
		if (table === "users") return [...state.accounts.map((account) => ({ id: account.id, email: account.email })), ...(state.admin && !state.accounts.some((account) => account.id === state.admin!.id) ? [state.admin] : [])].map((row) => ({ ...row, ...(state.extra.get(`users:${row.id}`) ?? {}) }));
		if (table === "mailboxes") return state.mailboxes.map((box) => ({ id: box.id, user_id: box.userId, ...(state.extra.get(`mailboxes:${box.id}`) ?? {}) }));
		return state.tables[table] ?? [];
	};
	const store: Store = {
		base: "https://instance.test",
		async admin() {
			if (!state.admin) throw new Error("no admin user");
			return state.admin;
		},
		async currentMx() {
			return seed.mx ?? [];
		},
		async routedElsewhere() {
			return seed.elsewhere ?? {};
		},
		async listDomains() {
			calls.push("listDomains");
			return state.domains as never;
		},
		async onboardDomain(body) {
			calls.push("onboardDomain");
			state.domains.push({ id: `dom_${++seq}`, hostname: String((body as { hostname: string }).hostname) });
			return ok();
		},
		async removeDomain(id) {
			calls.push(`removeDomain:${id}`);
			const gone = state.mailboxes.filter((box) => box.domainId === id).map((box) => box.id);
			state.domains = state.domains.filter((domain) => domain.id !== id);
			state.mailboxes = state.mailboxes.filter((box) => box.domainId !== id);
			state.routing = state.routing.filter((rule) => rule.domainId !== id);
			state.access = state.access.filter((grant) => !gone.includes(grant.mailboxId));
			return ok();
		},
		async listMailboxes() {
			return state.mailboxes as never;
		},
		async createMailbox(body) {
			const b = body as { domainId: string; localPart: string; displayName?: string; type?: string; ownerUserId?: string };
			calls.push(`createMailbox:${b.localPart}`);
			if (state.mailboxes.some((box) => box.domainId === b.domainId && box.localPart === b.localPart)) return refused(409, "Mailbox already exists");
			if (b.type === "shared" && state.license?.plan !== "team") return refused(403, "A Team license is required to create shared inboxes");
			const id = `mbx_${++seq}`;
			state.mailboxes.push({ id, domainId: b.domainId, localPart: b.localPart, hostname: hostnameOf(b.domainId), displayName: b.displayName ?? null, type: b.type ?? "personal", userId: b.ownerUserId ?? state.admin?.id ?? "u_admin" });
			return created({ id });
		},
		async updateMailbox(id, body) {
			calls.push(`updateMailbox:${id}`);
			const box = state.mailboxes.find((entry) => entry.id === id);
			if (box) box.displayName = (body as { displayName: string }).displayName;
			return ok();
		},
		async deleteMailbox(id) {
			calls.push(`deleteMailbox:${id}`);
			state.mailboxes = state.mailboxes.filter((box) => box.id !== id);
			state.access = state.access.filter((grant) => grant.mailboxId !== id);
			return ok();
		},
		async listAccounts() {
			return state.accounts as never;
		},
		async createAccount(body) {
			const b = body as { username: string; role: string; domainId: string };
			calls.push(`createAccount:${b.username}`);
			if (!["pro", "team"].includes(state.license?.plan ?? "")) return refused(403, "A Pro or Team license is required to manage accounts");
			const account = { id: `u_${++seq}`, email: `${b.username}@${hostnameOf(b.domainId)}`, name: b.username, role: b.role, disabled: false, canManageMailboxes: false };
			state.accounts.push(account);
			// The app gives every account a mailbox of its own name.
			state.mailboxes.push({ id: `mbx_${++seq}`, domainId: b.domainId, localPart: b.username, hostname: hostnameOf(b.domainId), displayName: b.username, type: "personal", userId: account.id });
			return created({ account });
		},
		async updateAccount(id, body) {
			calls.push(`updateAccount:${id}:${JSON.stringify(body)}`);
			if (!["pro", "team"].includes(state.license?.plan ?? "")) return refused(403, "A Pro or Team license is required to manage accounts");
			const account = state.accounts.find((entry) => entry.id === id);
			if (account) Object.assign(account, body);
			return ok();
		},
		async userIdByEmail(email) {
			return state.accounts.find((account) => account.email === email.toLowerCase())?.id ?? null;
		},
		async accessList(mailboxIds) {
			return state.access.filter((grant) => mailboxIds.includes(grant.mailboxId)).map((grant) => ({ ...grant, email: state.accounts.find((account) => account.id === grant.userId)?.email ?? "" }));
		},
		async grantAccess(mailboxId, userId, permission) {
			calls.push(`grantAccess:${userId}:${permission}`);
			state.access = [...state.access.filter((grant) => !(grant.mailboxId === mailboxId && grant.userId === userId)), { mailboxId, userId, permission }];
		},
		async revokeAccess(mailboxId, userId) {
			calls.push(`revokeAccess:${userId}`);
			state.access = state.access.filter((grant) => !(grant.mailboxId === mailboxId && grant.userId === userId));
		},
		async routingRules(domainId) {
			return state.routing.filter((rule) => rule.domainId === domainId) as never;
		},
		async insertRoutingRule(v) {
			calls.push(`insertRoutingRule:${v.pattern}:${v.action}`);
			state.routing.push({ id: `rr_${++seq}`, domainId: v.domainId, pattern: v.pattern, action: v.action, match_value: v.matchValue, forward_to: v.forwardTo, keep_copy: v.keepCopy, mailbox_id: v.mailboxId, reject_reason: v.rejectReason, priority: v.priority, enabled: v.enabled });
		},
		async updateRoutingRule(id, patch) {
			calls.push(`updateRoutingRule:${id}`);
			const rule = state.routing.find((entry) => entry.id === id);
			if (rule) Object.assign(rule, { match_value: patch.matchValue, forward_to: patch.forwardTo, keep_copy: patch.keepCopy, mailbox_id: patch.mailboxId, reject_reason: patch.rejectReason, priority: patch.priority, enabled: patch.enabled });
		},
		async deleteRoutingRule(id) {
			calls.push(`deleteRoutingRule:${id}`);
			state.routing = state.routing.filter((rule) => rule.id !== id);
		},
		async mcpKey(name) {
			return state.keys.find((key) => key.name === name) ?? null;
		},
		async mcpKeyNames() {
			return state.keys.map((key) => ({ id: key.id, name: key.name }));
		},
		async domainNames() {
			return state.domains.map((domain) => domain.hostname);
		},
		async createMcpKey({ name, scopes, mailboxIds }) {
			calls.push(`createMcpKey:${name}`);
			state.keys.push({ id: `key_${++seq}`, name, scopes, mailboxIds });
			return { fullKey: `ep_${name}` };
		},
		async updateMcpKey(id, values) {
			calls.push(`updateMcpKey:${id}`);
			Object.assign(state.keys.find((key) => key.id === id) ?? {}, values);
		},
		async deleteMcpKey(id) {
			calls.push(`deleteMcpKey:${id}`);
			state.keys = state.keys.filter((key) => key.id !== id);
		},
		async licenseRow() {
			return state.license;
		},
		async setLicense(plan) {
			calls.push(`setLicense:${plan ?? "community"}`);
			state.license = plan === null ? { plan: "community", state: "inactive" } : { plan, state: "active" };
		},
		async rows(table, where) {
			return all(table).filter((row) => Object.entries(where).every(([column, value]) => (row[column] ?? null) === value));
		},
		async insertRow(table, values) {
			calls.push(`insertRow:${table}`);
			(state.tables[table] ??= []).push({ ...values });
		},
		async updateRows(table, where, values) {
			calls.push(`updateRows:${table}:${Object.keys(values).join(",")}`);
			for (const row of await store.rows(table, where)) {
				if (table === "users" || table === "mailboxes") state.extra.set(`${table}:${row.id}`, { ...(state.extra.get(`${table}:${row.id}`) ?? {}), ...values });
				else Object.assign(row, values);
			}
		},
		async deleteRows(table, where) {
			calls.push(`deleteRows:${table}`);
			const gone = new Set(await store.rows(table, where));
			state.tables[table] = (state.tables[table] ?? []).filter((row) => !gone.has(row));
		},
		async upsertRow(table, key, values) {
			calls.push(`upsertRow:${table}:${Object.keys(values).join(",")}`);
			const [existing] = await store.rows(table, key);
			if (existing) Object.assign(existing, values);
			else (state.tables[table] ??= []).push({ ...key, ...values });
		},
		async subjectReport(email) {
			const account = state.accounts.find((entry) => entry.email === email.toLowerCase());
			if (!account) return { email, userId: null, mailboxIds: [], counts: [], objects: 0, elsewhere: [], blockers: [] };
			const mailboxIds = state.mailboxes.filter((box) => box.userId === account.id).map((box) => box.id);
			return { email, userId: account.id, mailboxIds, counts: [{ table: "mailboxes", rows: mailboxIds.length }, { table: "mailbox_access", rows: state.access.filter((grant) => grant.userId === account.id).length }], objects: 0, elsewhere: [], blockers: account.isPrimaryAdmin ? ["is the primary admin — the instance cannot run without one"] : [] };
		},
		async eraseSubject(email) {
			const report = await store.subjectReport(email);
			calls.push(`eraseSubject:${email}`);
			if (report.blockers.length > 0) throw new Error(`cannot erase ${email}: ${report.blockers.join("; ")}`);
			state.accounts = state.accounts.filter((account) => account.id !== report.userId);
			state.mailboxes = state.mailboxes.filter((box) => box.userId !== report.userId);
			state.access = state.access.filter((grant) => grant.userId !== report.userId && !report.mailboxIds.includes(grant.mailboxId));
			return { email, userId: report.userId, deleted: report.counts, objectKeys: [], objectsDeleted: 0 };
		},
		async listObjects(prefix) {
			return [...state.objects.keys()].filter((key) => key.startsWith(prefix));
		},
		async readObject(key) {
			return state.objects.get(key) ?? null;
		},
		async writeObject(key, content) {
			calls.push(`writeObject:${key}`);
			state.objects.set(key, content);
		},
		async deleteObjects(keys) {
			for (const key of keys) calls.push(`deleteObject:${key}`);
			return keys.filter((key) => state.objects.delete(key)).length;
		},
		// A backup is the people and their mailboxes, in the app's own format: enough to erase from and restore.
		async takeBackup() {
			const id = `bak_${++seq}`;
			calls.push("takeBackup");
			const key = `backups/database/${id}/mailflare.json`;
			const tables = {
				users: all("users").map((row) => {
					const account = state.accounts.find((entry) => entry.id === row.id);
					return { id: row.id, email: row.email, name: account?.name ?? "root", role: account?.role ?? "admin", disabled: Number(account?.disabled ?? false), can_manage_mailboxes: Number(account?.canManageMailboxes ?? true), is_primary_admin: Number(account?.isPrimaryAdmin ?? false), listed: Number(!!account) };
				}),
				domains: state.domains.map((domain) => ({ id: domain.id, hostname: domain.hostname, user_id: state.admin?.id ?? null })),
				mailboxes: state.mailboxes.map((box) => ({ id: box.id, user_id: box.userId, domain_id: box.domainId, local_part: box.localPart, hostname: box.hostname, display_name: box.displayName, type: box.type })),
				mailbox_access: state.access.map((grant, index) => ({ id: `mac_${index}`, mailbox_id: grant.mailboxId, user_id: grant.userId, permission: grant.permission, created_by_user_id: state.admin?.id ?? null })),
			};
			state.objects.set(key, JSON.stringify({ format: "mailflare-database-backup", version: 1, createdAt: new Date().toISOString(), tables }));
			(state.tables.backups ??= []).push({ id, status: "completed", r2_key: key, size: 1, created_at: seq });
			return id;
		},
		async restoreBackup(content) {
			calls.push("restoreBackup");
			const { tables } = JSON.parse(content) as { tables: Record<string, Array<Record<string, string | number | null>>> };
			state.accounts = tables.users.filter((row) => row.listed).map((row) => ({ id: String(row.id), email: String(row.email), name: String(row.name), role: String(row.role), disabled: Boolean(row.disabled), canManageMailboxes: Boolean(row.can_manage_mailboxes), isPrimaryAdmin: Boolean(row.is_primary_admin) }));
			state.mailboxes = tables.mailboxes.map((row) => ({ id: String(row.id), userId: String(row.user_id), domainId: String(row.domain_id), localPart: String(row.local_part), hostname: String(row.hostname), displayName: row.display_name === null ? null : String(row.display_name), type: String(row.type) }));
			state.access = tables.mailbox_access.map((row) => ({ mailboxId: String(row.mailbox_id), userId: String(row.user_id), permission: String(row.permission) }));
		},
		async applyMigrations() {
			calls.push("applyMigrations");
		},
		async schemaPresent() {
			return state.schema;
		},
		async userCount() {
			return state.schema ? state.accounts.length + (state.admin && !state.accounts.some((account) => account.id === state.admin!.id) ? 1 : 0) : null;
		},
		async domainCount() {
			return state.domains.length;
		},
		async wipeData() {
			calls.push("wipeData");
			Object.assign(state, { domains: [], mailboxes: [], accounts: [], access: [], routing: [], keys: [], license: null, admin: null, tables: {}, extra: new Map() });
		},
		async insertAdmin({ id, email }) {
			calls.push(`insertAdmin:${email}`);
			state.admin = { id, email };
			state.accounts.push({ id, email, name: "root", role: "admin", disabled: false, canManageMailboxes: true, isPrimaryAdmin: true });
		},
		async workerSecrets() {
			return ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"];
		},
		async pushSubscriptionCount() {
			return state.pushSubscriptions;
		},
		async clearPushSubscriptions() {
			calls.push("clearPushSubscriptions");
			state.pushSubscriptions = 0;
		},
		async firstAdminEmail() {
			return state.admin?.email ?? null;
		},
		async sendViaCloudflare({ subject }) {
			calls.push("sendViaCloudflare");
			state.sent.push(subject);
			return { messageId: "cf_1" };
		},
		async messageStatusBySubject(subject) {
			return state.sent.includes(subject) ? { status: "received" } : null;
		},
		async wait() {},
		async dispose() {},
	};
	return { store, state, calls };
}

const flags = (over: Partial<Flags> = {}): Flags => ({ status: false, cleanup: false, fresh: false, confirmMx: false, confirmDestroy: false, rotatePasswords: false, db: "test", local: false, ...over });
const PLAN = flags({ status: true });
const DESTROY = flags({ cleanup: true, confirmDestroy: true });

/** Run one document and return its exit code and what it printed. */
async function runOn(store: Store, f: Flags, spec: Spec, vault = memoryVault()) {
	const lines: string[] = [];
	const code = await run(makeContext(store, f, spec, { log: (line) => lines.push(line), vault }));
	return { code, text: lines.join("\n") };
}
const writes = (calls: string[]) => calls.filter((call) => !call.startsWith("list"));

const TEAM = { plan: "team", state: "active" };
const DOMAIN = [{ id: "d1", hostname: "dev.example" }];

// A tenant that uses everything, with each kind of reference to something it makes itself.
const FULL: Spec = {
	domain: "dev.example",
	onboard: { receivingProvider: "none" },
	mailboxes: [
		{ role: "office", displayName: "Office" },
		{ role: "support", displayName: "Support", shared: true, access: [{ email: "sam@dev.example", permission: "read_only" }] },
	],
	accounts: [{ username: "sam", name: "Sam", role: "user", password: "password-123" }],
	routing: [
		{ pattern: "*", action: "forward", forwardTo: "ops@example.com", keepCopy: true, mailbox: "support" },
		{ pattern: "no-reply", action: "reject", rejectReason: "No such user" },
	],
	mcpKeys: [{ name: "agent", mailboxes: ["support", "sam"], scopes: ["mcp:read"] }, { name: "reader" }],
	teardown: { accounts: "disable", domain: "remove" },
};

// --- the lifecycle ----------------------------------------------------------------

test("a mailbox of the wrong kind is a problem, since the app cannot convert one", async () => {
	const { store, calls } = fakeStore({ domains: DOMAIN, mailboxes: [{ id: "m1", localPart: "team", type: "personal" }] });
	const wrong = await runOn(store, PLAN, { domain: "dev.example", mailboxes: [{ role: "team", shared: true }] });
	assert.match(wrong.text, /! mailbox\.team@dev\.example\s+exists as a personal mailbox/);
	assert.equal((await runOn(store, flags(), { domain: "dev.example", mailboxes: [{ role: "team", shared: true }] })).code, 1);
	assert.deepEqual(writes(calls), []);
});

// --- the document wins: what a written section does not hold is removed -------------

test("a document only speaks for the sections it writes, and never for another's people", async () => {
	const seed = {
		domains: DOMAIN,
		license: TEAM,
		accounts: [{ id: "u_sam", email: "sam@dev.example" }, { id: "u_else", email: "someone@other.example" }],
		mailboxes: [{ id: "m1", localPart: "office" }, { id: "m2", localPart: "retired" }, { id: "m3", localPart: "sam", userId: "u_sam" }],
		access: [{ mailboxId: "m1", userId: "u_sam", permission: "read_only" }],
		routing: [{ id: "rr_1", domainId: "d1", pattern: "*", action: "forward" }],
	};
	// A section left out is not managed: this document says nothing about mailboxes, accounts or rules.
	assert.equal((await runOn(fakeStore(seed).store, PLAN, { domain: "dev.example" })).code, 0);
	// A mailbox that writes no `access` list keeps whatever grants it has; an empty list is a complete one.
	assert.equal((await runOn(fakeStore(seed).store, PLAN, { domain: "dev.example", mailboxes: [{ role: "office" }, { role: "retired" }] })).code, 0);
	assert.match((await runOn(fakeStore(seed).store, PLAN, { domain: "dev.example", mailboxes: [{ role: "office", access: [] }, { role: "retired" }] })).text, /- mailbox_access\.office\.sam@dev\.example/);

	// Written sections are complete - but an account's own mailbox goes with the account, and
	// someone on another domain is not this document's to disable.
	const planned = await runOn(fakeStore(seed).store, PLAN, { domain: "dev.example", mailboxes: [{ role: "office" }], accounts: [] });
	assert.match(planned.text, /- mailbox\.retired@dev\.example\s+not in the document/);
	assert.match(planned.text, /- account\.sam\s/);
	assert.ok(!planned.text.includes("mailbox.sam@") && !planned.text.includes("someone"));
});

test("a key no document names is removed, and a domain no document names is only said - when the whole project is run", async () => {
	const seed = { domains: [{ id: "d1", hostname: "a.example" }, { id: "d9", hostname: "stray.example" }], license: TEAM, keys: [{ id: "k1", name: "kept", scopes: [...MCP_SCOPES], mailboxIds: null }, { id: "k2", name: "forgotten", scopes: [...MCP_SCOPES], mailboxIds: null }] };
	const entries = [{ name: "p/instance", spec: { license: { plan: "team" } } as Spec }, { name: "p/a.example", spec: { domain: "a.example", mcpKeys: [{ name: "kept" }] } as Spec }];
	const out: string[] = [];
	const print = { print: (text: string) => void out.push(text) };

	const whole = fakeStore(seed);
	const planned = await runDocuments(whole.store, PLAN, entries, { ...print, complete: true });
	assert.deepEqual(planned.map((result) => result.ok), [false, true]);
	assert.match(out.join("\n"), /- mcpKey\.forgotten\s+not in the document/);
	assert.match(out.join("\n"), /\? domain\.stray\.example\s+on the server, and no document declares it/);
	await runDocuments(whole.store, flags({ confirmDestroy: true }), entries, { ...quiet, complete: true });
	assert.deepEqual(whole.state.keys.map((key) => key.name), ["kept"]);
	assert.equal(whole.state.domains.length, 2, "a domain is never removed for want of a document");
	assert.deepEqual((await runDocuments(whole.store, PLAN, entries, { ...quiet, complete: true })).map((result) => result.ok), [true, true], "a stray domain is said, and does not stand in the way");

	// One document cannot speak for the others, so on its own it removes nobody's keys.
	const part = fakeStore(seed);
	await runDocuments(part.store, flags({ confirmDestroy: true }), entries, quiet);
	assert.equal(part.state.keys.length, 2);
	// And until some document writes an mcpKeys section, keys are not managed at all.
	const unmanaged = fakeStore(seed);
	await runDocuments(unmanaged.store, flags({ confirmDestroy: true }), [entries[0], { name: "p/a.example", spec: { domain: "a.example" } as Spec }], { ...quiet, complete: true });
	assert.equal(unmanaged.state.keys.length, 2);
});

test("an address Cloudflare already routes elsewhere is a problem in the plan, and is never taken over", async () => {
	const { store, calls } = fakeStore({ domains: DOMAIN, elsewhere: { "support@dev.example": "forward to me@elsewhere.example" } });
	const spec: Spec = { domain: "dev.example", mailboxes: [{ role: "office" }, { role: "support" }] };
	const planned = await runOn(store, PLAN, spec);
	assert.match(planned.text, /! mailbox\.support@dev\.example\s+Cloudflare already routes support@dev\.example elsewhere \(forward to me@elsewhere\.example\)/);
	assert.match(planned.text, /\+ mailbox\.office@dev\.example/, "the rest of the document is unaffected");
	assert.equal((await runOn(store, flags(), spec)).code, 1);
	assert.deepEqual(calls.filter((call) => call.startsWith("createMailbox")), ["createMailbox:office"]);
});

test("the owner of a mailbox needs no grant: none is steady state, and a redundant one is cleared", async () => {
	const seed = { domains: DOMAIN, accounts: [{ id: "u_owner", email: "owner@dev.example" }], mailboxes: [{ id: "m1", localPart: "owner", userId: "u_owner" }] };
	const spec: Spec = { domain: "dev.example", mailboxes: [{ role: "owner", access: [{ email: "owner@dev.example" }] }] };
	assert.equal((await runOn(fakeStore(seed).store, PLAN, spec)).code, 0, "no grant, none wanted: nothing to do");

	const redundant = fakeStore({ ...seed, access: [{ mailboxId: "m1", userId: "u_owner", permission: "full_access" }] });
	assert.equal((await runOn(redundant.store, PLAN, spec)).code, 1);
	await runOn(redundant.store, flags(), spec);
	assert.deepEqual(redundant.state.access, []);
	assert.ok(!redundant.calls.some((call) => call.startsWith("grantAccess")));
});

test("a grant to an address nobody will have is a problem, and is never attempted", async () => {
	const { store, calls } = fakeStore({ domains: DOMAIN, mailboxes: [{ id: "m1", localPart: "support" }] });
	const spec: Spec = { domain: "dev.example", mailboxes: [{ role: "support", access: [{ email: "outside@elsewhere.test" }] }] };
	assert.match((await runOn(store, PLAN, spec)).text, /no local user with that address/);
	assert.equal((await runOn(store, flags(), spec)).code, 1);
	assert.ok(!calls.some((call) => call.startsWith("grantAccess")));
});

test("a domain that is not onboarded stops the document instead of failing everything after it", async () => {
	const { store, calls } = fakeStore({ license: TEAM });
	const spec: Spec = { domain: "new.example", mailboxes: [{ role: "office" }], accounts: [{ username: "sam", password: "password-123" }] };
	assert.match((await runOn(store, PLAN, spec)).text, /! domain\.new\.example\s+not onboarded/);
	const applied = await runOn(store, flags(), spec);
	assert.equal(applied.code, 1);
	assert.match(applied.text, /stopped: nothing else in this document can work without domain/);
	assert.deepEqual(writes(calls), [], "nothing was attempted against a domain that is not there");
});

test("onboarding refuses to take mail from someone else, but Cloudflare's own MX is ours already", async () => {
	const spec: Spec = { domain: "live.example", onboard: {}, mailboxes: [{ role: "office" }] };
	const taken = fakeStore({ mx: [{ content: "mx.other.example" }] });
	const refusedRun = await runOn(taken.store, flags(), spec);
	assert.equal(refusedRun.code, 1);
	assert.match(refusedRun.text, /already receives mail through mx\.other\.example/);
	assert.equal((await runOn(taken.store, flags({ confirmMx: true }), spec)).code, 0, "--confirm-mx is the approval");

	assert.equal((await runOn(fakeStore({ mx: [{ content: "route1.mx.cloudflare.net" }] }).store, flags(), spec)).code, 0);
	assert.deepEqual(foreignMx([{ content: "route2.mx.cloudflare.net." }, { content: "aspmx.l.google.com" }], "cloudflare"), ["aspmx.l.google.com"]);
	assert.equal((await runOn(taken.store, flags(), { ...spec, domain: "quiet.example", onboard: { receivingProvider: "none" } })).code, 0, "a domain that will not receive takes nobody's mail");
});

test("an MCP key is never minted wider than the document says", async () => {
	const seed = { domains: DOMAIN, mailboxes: [{ id: "m1", localPart: "office" }, { id: "m2", localPart: "support" }] };
	// A typo'd mailbox would otherwise leave the key restricted to nothing - which the app reads as everything.
	const typo = fakeStore(seed);
	const bad: Spec = { domain: "dev.example", mcpKeys: [{ name: "agent", mailboxes: ["offcie"] }] };
	assert.match((await runOn(typo.store, PLAN, bad)).text, /! mcpKey\.agent\s+mailbox "offcie" is neither/);
	assert.equal((await runOn(typo.store, flags(), bad)).code, 1);
	assert.deepEqual(typo.state.keys, [], "no key was minted");

	// A key that exists is rewritten in place: what it reaches changes, its secret does not.
	const drift = fakeStore({ ...seed, keys: [{ id: "k1", name: "agent", scopes: ["mcp:read"], mailboxIds: ["m1"] }] });
	const wider: Spec = { domain: "dev.example", mcpKeys: [{ name: "agent", mailboxes: ["office", "support"], scopes: ["mcp:read", "mcp:draft"] }] };
	assert.equal((await runOn(drift.store, PLAN, wider)).code, 1);
	await runOn(drift.store, flags(), wider);
	assert.deepEqual(drift.state.keys, [{ id: "k1", name: "agent", scopes: ["mcp:read", "mcp:draft"], mailboxIds: ["m1", "m2"] }]);
	assert.ok(!drift.calls.some((call) => call.startsWith("createMcpKey")));
	assert.equal((await runOn(drift.store, PLAN, wider)).code, 0);
});

test("accounts: an update carries the whole body the app requires, and the primary admin is never disabled", async () => {
	const seed = { domains: DOMAIN, license: TEAM, mailboxes: [{ id: "m1", localPart: "sam" }, { id: "m2", localPart: "root" }], accounts: [{ id: "u_sam", email: "sam@dev.example", name: "sam", role: "user" }, { id: "u_root", email: "root@dev.example", role: "admin", isPrimaryAdmin: true }] };
	const { store, state, calls } = fakeStore(seed);
	const spec: Spec = { domain: "dev.example", accounts: [{ username: "sam", name: "Sam", role: "admin" }, { username: "root", role: "admin" }], teardown: { accounts: "disable" } };
	await runOn(store, flags(), spec);
	const body = JSON.parse(calls.find((call) => call.startsWith("updateAccount:u_sam"))!.split(":").slice(2).join(":"));
	assert.deepEqual(body, { name: "Sam", role: "admin", disabled: false, canManageMailboxes: false }, "the whole body, and none of the schema's null transforms");
	await runOn(store, DESTROY, spec);
	assert.deepEqual(state.accounts.map((account) => account.disabled), [true, false], "the primary admin is kept");
});

test("logins: what is written down is what was set, a rotation retires it, and nothing secret is printed", async () => {
	const { store, state } = fakeStore({ domains: DOMAIN, license: TEAM });
	const vault = memoryVault();
	const spec: Spec = { domain: "dev.example", accounts: [{ username: "sam", name: "Sam", password: "password-123" }, { username: "new" }], mcpKeys: [{ name: "agent" }] };
	const applied = await runOn(store, flags(), spec, vault);
	assert.deepEqual([vault.data.logins["sam@dev.example"].password, vault.data.logins["sam@dev.example"].login, vault.data.mcpKeys.agent.key], ["password-123", "https://instance.test/login", "ep_agent"]);
	const generated = vault.data.logins["new@dev.example"].password;
	assert.ok(generated.length >= 16 && !applied.text.includes(generated) && !applied.text.includes("password-123") && !applied.text.includes("ep_agent"));
	assert.deepEqual(vault.logins().map((login) => login.email), ["new@dev.example", "sam@dev.example"], "one document per person, to send them");

	// An account that already exists keeps its password until it is rotated; so does a key.
	assert.equal((await runOn(store, PLAN, spec, vault)).code, 0);
	const keyBefore = state.keys[0].id;
	assert.match((await runOn(store, flags({ status: true, rotatePasswords: true }), spec, vault)).text, /~ account\.new\s+set a new password/);
	await runOn(store, flags({ rotatePasswords: true }), spec, vault);
	assert.notEqual(vault.data.logins["new@dev.example"].password, generated);
	assert.deepEqual([state.keys.length, state.keys[0].id !== keyBefore], [1, true], "a new key replaced the old one");
});

// --- the instance layer -----------------------------------------------------------

test("licence: applied when asked, community is a plan like any other, destroy takes back what was given", async () => {
	const fresh = fakeStore();
	assert.equal((await runOn(fresh.store, PLAN, { license: { plan: "team" } })).code, 1);
	assert.deepEqual(writes(fresh.calls), []);
	await runOn(fresh.store, flags(), { license: "team" });
	assert.deepEqual(fresh.state.license, TEAM);
	assert.ok(!fresh.calls.includes("listDomains"), "an instance document reaches for no domain");

	const down = fakeStore({ license: TEAM });
	await runOn(down.store, flags(), { license: { plan: "community" } });
	assert.equal(down.state.license?.plan, "community", "an explicit community is applied, not ignored");

	const undo = fakeStore({ license: TEAM });
	await runOn(undo.store, DESTROY, { license: { plan: "team" } });
	assert.ok(undo.calls.includes("setLicense:community"));
	assert.ok(!undo.calls.includes("listDomains"), "destroying an instance document reaches for no domain either");
});

test("settings: a secret comes from the environment, is written, and is never printed", async () => {
	process.env.STATE_TEST_RESEND = "re_secret";
	const { store, state, calls } = fakeStore({ settings: { app_settings: { app_name: "Mailflare", outbound_attachment_max_mb: 25 }, backup_settings: { enabled: 0, schedule_type: "daily", retention_enabled: 0, retention_days: 30, excluded_table_groups: "[]" } } });
	const spec: Spec = {
		settings: { outboundAttachmentMaxMb: 25, driveStorageLimitGb: 2, assistant: { provider: "compatible", preset: "openai", models: ["gpt-4o-mini"], apiKeyEnv: "STATE_TEST_RESEND" }, resendApiKeyEnv: "STATE_TEST_RESEND" },
		backups: { enabled: true, schedule: "weekly", scheduleValue: 1, retentionDays: 14, exclude: ["assistant"] },
	};
	const planned = await runOn(store, PLAN, spec);
	assert.match(planned.text, /· settings\.outboundAttachmentMaxMb/, "a field already as wanted is unchanged");
	assert.match(planned.text, /~ backups\.schedule\s+daily → weekly on day 1/);
	const applied = await runOn(store, flags(), spec);
	assert.equal(applied.code, 0, applied.text);
	assert.ok(!planned.text.includes("re_secret") && !applied.text.includes("re_secret"), "a secret is never printed");
	assert.ok(!calls.some((call) => call.includes("outbound_attachment_max_mb")), "the unchanged field was not written");
	const [app] = state.tables.app_settings;
	const [backup] = state.tables.backup_settings;
	assert.deepEqual([app.drive_storage_limit_bytes, app.agent_base_url, app.agent_api_key, app.resend_api_key], [2 * 1024 ** 3, "https://api.openai.com/v1", "re_secret", "re_secret"]);
	assert.deepEqual([backup.enabled, backup.schedule_type, backup.schedule_value, backup.retention_enabled, backup.retention_days, backup.excluded_table_groups], [1, "weekly", 1, 1, 14, '["assistant"]']);
	assert.equal((await runOn(store, PLAN, spec)).code, 0);

	delete process.env.STATE_TEST_RESEND;
	assert.match((await runOn(store, PLAN, { settings: { resendApiKeyEnv: "STATE_TEST_RESEND" } })).text, /! settings\.resendApiKey\s+\$STATE_TEST_RESEND is not set/);
});

test("backups are provisioned, not just switched on: the first is taken at once, and one that cannot be made is a failure", async () => {
	const seed = { settings: { backup_settings: { enabled: 0, schedule_type: "daily", retention_enabled: 0, retention_days: 30, excluded_table_groups: "[]" } } };
	const spec: Spec = { backups: { enabled: true, schedule: "daily", retentionDays: 30 } };
	const { store, state, calls } = fakeStore(seed);
	assert.match((await runOn(store, PLAN, spec)).text, /\+ backups\.first\s+none has completed yet, so one is taken now/);
	const applied = await runOn(store, flags(), spec);
	assert.equal(applied.code, 0, applied.text);
	assert.match(applied.text, /\+ backups\.first\s+taken \(bak_/);
	assert.deepEqual([state.tables.backups.length, state.objects.size], [1, 1], "a real backup is in the bucket, with its record");
	assert.equal((await runOn(store, PLAN, spec)).code, 0, "and one is enough: the schedule takes the rest");
	assert.equal(calls.filter((call) => call === "takeBackup").length, 1);
	assert.equal((await runOn(store, DESTROY, spec)).code, 0);
	assert.equal(state.objects.size, 1, "destroy never deletes a backup");

	// Off, nothing is taken. On and failing, the run says why and fails: this is how a server whose backups cannot work is found.
	const off = fakeStore(seed);
	assert.equal((await runOn(off.store, flags(), { backups: { enabled: false } })).code, 0);
	assert.ok(!off.calls.includes("takeBackup"));
	const broken = fakeStore(seed);
	broken.store.takeBackup = async () => {
		throw new Error("the backup failed: Backup aborted: drive_items not listed in BACKUP_TABLES");
	};
	const failed = await runOn(broken.store, flags(), spec);
	assert.equal(failed.code, 1);
	assert.match(failed.text, /✗ backups\.first\s+the backup failed: Backup aborted/);

	// The app's own list of what a backup holds must name every table, or every backup aborts.
	const backedUp = BACKUP_TABLE_GROUPS.flatMap((group) => group.tables as string[]);
	const tables = Object.values(schema).filter((value) => is(value, SQLiteTable)).map((table) => getTableConfig(table as SQLiteTable).name);
	assert.deepEqual(tables.filter((table) => !backedUp.includes(table) && table !== "jmap_mailbox_revisions"), [], "a table the app does not back up — add it to BACKUP_TABLES and a group in src/lib/backups/");
});

const PEOPLE = {
	domains: DOMAIN,
	license: TEAM,
	accounts: [{ id: "u_sam", email: "sam@dev.example" }, { id: "u_kim", email: "kim@dev.example" }],
	mailboxes: [{ id: "mbx_sam", localPart: "sam", userId: "u_sam" }, { id: "mbx_kim", localPart: "kim", userId: "u_kim" }, { id: "mbx_office", localPart: "office" }],
	access: [{ mailboxId: "mbx_office", userId: "u_sam", permission: "read_only" }, { mailboxId: "mbx_office", userId: "u_kim", permission: "read_only" }],
};

test("leaving a document disables a person and keeps their data; declaring them erased deletes it, backups included", async () => {
	const { store, state, calls } = fakeStore(PEOPLE);
	const vault = memoryVault();
	vault.recordLogin("sam@dev.example", { name: "Sam", role: "user", password: "pw" });
	vault.recordSecret("apiKeys", "sam@dev.example/laptop", "ep_secret");
	vault.recordSecret("apiKeys", "kim@dev.example/laptop", "ep_other");
	await store.takeBackup();
	const [backupKey] = state.objects.keys();
	const copy = state.objects.get(backupKey)!;
	assert.deepEqual(holds(parseBackup(copy)!, [digestOf("Sam@Dev.Example")]), [digestOf("sam@dev.example")], "the backup holds them, however the address is written");

	// Out of the document: disabled, and the plan says that nothing of theirs is deleted.
	const left: Spec = { domain: "dev.example", accounts: [{ username: "kim" }] };
	assert.match((await runOn(store, PLAN, left)).text, /- account\.sam\s+not in the document: it is disabled, and its mail and files are kept — `erased` is what deletes a person/);
	await runOn(store, flags({ confirmDestroy: true }), left);
	assert.deepEqual([state.accounts.find((account) => account.id === "u_sam")?.disabled, state.mailboxes.some((box) => box.id === "mbx_sam")], [true, true], "disabled, with their mailbox still there");

	// Declared erased: the plan says what goes, an apply waits for approval, and then it is all gone.
	const erased: Spec = { ...left, erased: ["sam"] };
	const planned = await runOn(store, PLAN, erased);
	assert.equal(planned.code, 1);
	assert.match(planned.text, /- erased\.sam@dev\.example\s+declared erased: an account, 1 mailbox, 2 rows, 0 objects — and they are taken out of every backup/);
	const unapproved = await runOn(store, flags(), erased, vault);
	assert.equal(unapproved.code, 1);
	assert.match(unapproved.text, /- erased\.sam@dev\.example\s+declared erased — left in place \(--confirm-destroy removes it\)/);
	assert.ok(state.accounts.some((account) => account.id === "u_sam") && !calls.some((call) => call.startsWith("eraseSubject")));

	const applied = await runOn(store, flags({ confirmDestroy: true }), erased, vault);
	assert.equal(applied.code, 0, applied.text);
	assert.match(applied.text, /- erased\.sam@dev\.example\s+erased: 2 rows, 0 objects, 1 backup rewritten without them — declared erased/);
	assert.deepEqual([state.accounts.map((account) => account.email), state.mailboxes.map((box) => box.id), state.access.map((grant) => grant.userId)], [["kim@dev.example"], ["mbx_kim", "mbx_office"], ["u_kim"]]);
	const rewritten = parseBackup(state.objects.get(backupKey)!)!;
	assert.deepEqual([holds(rewritten, [digestOf("sam@dev.example")]), rewritten.tables.users.map((row) => row.email), rewritten.tables.mailbox_access.map((row) => row.user_id), dangling(rewritten)], [[], ["kim@dev.example", "admin@instance.test"], ["u_kim"], []], "the backup is everyone else's, and still whole");
	assert.deepEqual([vault.password("sam@dev.example"), vault.secret("apiKeys", "sam@dev.example/laptop"), vault.secret("apiKeys", "kim@dev.example/laptop")], [null, null, "ep_other"], "their login and keys leave the credentials folder; nobody else's do");
	assert.equal((await runOn(store, PLAN, erased)).code, 0, "and the tombstone finds nothing more to do");

	// A rewritten backup restores without them. A copy nobody rewrote brings them back - and the
	// tombstone, kept as nothing but a digest, says so in the next plan.
	await store.restoreBackup(state.objects.get(backupKey)!);
	assert.equal((await runOn(store, PLAN, erased)).code, 0);
	await store.restoreBackup(copy);
	const digest: Spec = { ...left, erased: [digestOf("sam@dev.example")] };
	const back = await runOn(store, PLAN, digest);
	assert.match(back.text, /- erased\.sha256:[0-9a-f]{12}…\s+declared erased: an account/);
	assert.ok(!back.text.includes("sam@"), "a tombstone that keeps no address prints none");
	assert.equal((await runOn(store, flags({ confirmDestroy: true }), digest, vault)).code, 0);
	assert.ok(!state.accounts.some((account) => account.email === "sam@dev.example"));
});

test("every backup in the bucket is cleaned: one with no record is found, and one that cannot be rewritten is deleted", async () => {
	const { store, state } = fakeStore(PEOPLE);
	await store.takeBackup();
	// A restore replaces the app's records with older ones, so a backup can have none at all.
	const orphan = "backups/database/bak_lost/mailflare.json";
	state.objects.set(orphan, [...state.objects.values()][0]);
	state.objects.set("backups/database/bak_bad/mailflare.json", "not a backup");
	(state.tables.backups ??= []).push({ id: "bak_bad", status: "completed", r2_key: "backups/database/bak_bad/mailflare.json", size: 12, created_at: 9 });
	state.objects.set("inbound/1.eml", "somebody's mail");

	const done = await scrubBackups(store, { digests: [digestOf("sam@dev.example")] });
	assert.deepEqual(done, { rewritten: 2, deleted: 1, clean: 0 });
	assert.ok(holds(parseBackup(state.objects.get(orphan)!)!, [digestOf("sam@dev.example")]).length === 0, "the backup with no record was rewritten too");
	assert.deepEqual([state.objects.has("backups/database/bak_bad/mailflare.json"), state.tables.backups.some((row) => row.id === "bak_bad")], [false, false], "what cannot be checked is deleted, with its record");
	assert.ok(state.objects.has("inbound/1.eml"), "nothing but backups is touched");
	assert.deepEqual(await scrubBackups(store, { digests: [digestOf("sam@dev.example")] }), { rewritten: 0, deleted: 0, clean: 2 }, "and a second pass finds them clean");
});

test("a backup is rewritten by the erasure scope, then by what the database itself would have done", () => {
	const document = (): BackupDocument => ({
		format: "mailflare-database-backup",
		version: 1,
		tables: {
			users: [{ id: "u_admin", email: "root@a.test", created_by_user_id: null }, { id: "u_sam", email: "Sam@A.test", created_by_user_id: "u_admin" }, { id: "u_kim", email: "kim@a.test", created_by_user_id: "u_sam" }],
			domains: [{ id: "d1", hostname: "a.test", user_id: "u_admin" }],
			mailboxes: [{ id: "m_sam", user_id: "u_sam", domain_id: "d1" }, { id: "m_kim", user_id: "u_kim", domain_id: "d1" }, { id: "m_shared", user_id: "u_admin", domain_id: "d1" }],
			mailbox_access: [{ id: "a1", mailbox_id: "m_shared", user_id: "u_sam", created_by_user_id: "u_admin" }, { id: "a2", mailbox_id: "m_shared", user_id: "u_kim", created_by_user_id: "u_sam" }],
			messages: [{ id: "msg_sam", user_id: "u_sam", mailbox_id: "m_sam" }, { id: "msg_kim", user_id: "u_kim", mailbox_id: "m_kim" }],
			message_attachments: [{ id: "att_sam", message_id: "msg_sam" }, { id: "att_kim", message_id: "msg_kim" }],
			shared_attachment_links: [{ id: "l_sam", attachment_id: "att_sam" }, { id: "l_kim", attachment_id: "att_kim" }],
			sessions: [{ id: "s_sam", user_id: "u_sam" }, { id: "s_kim", user_id: "u_kim" }],
			push_subscriptions: [{ id: "p_sam", user_id: "u_sam", session_id: "s_sam" }, { id: "p_kim", user_id: "u_kim", session_id: "s_kim" }],
			audit_logs: [{ id: "log1", actor_user_id: "u_admin", target_user_id: "u_sam", mailbox_id: null }, { id: "log2", actor_user_id: "u_admin", target_user_id: "u_kim", mailbox_id: null }],
			backups: [{ id: "bak1", created_by_user_id: "u_sam" }],
			drive_items: [{ id: "f_sam", owner_id: "u_sam" }, { id: "f_kim", owner_id: "u_kim" }],
			drive_upload_parts: [{ item_id: "f_sam", part_number: 1 }, { item_id: "f_kim", part_number: 1 }],
		},
	});
	const ids = (doc: BackupDocument, table: string) => doc.tables[table].map((row) => row.id ?? row.item_id);

	const scrubbed = document();
	assert.deepEqual(dangling(scrubbed), [], "the fixture is a consistent database");
	const result = scrub(scrubbed, { digests: [digestOf("sam@a.test")] });
	assert.equal(result.unsafe, undefined);
	assert.equal(result.removed, 11);
	for (const table of ["messages", "message_attachments", "shared_attachment_links", "sessions", "push_subscriptions", "drive_items", "drive_upload_parts"]) assert.equal(scrubbed.tables[table].length, 1, `${table}: theirs is gone and kim's is kept`);
	assert.deepEqual([ids(scrubbed, "users"), ids(scrubbed, "mailboxes"), ids(scrubbed, "mailbox_access"), ids(scrubbed, "audit_logs")], [["u_admin", "u_kim"], ["m_kim", "m_shared"], ["a2"], ["log2"]]);
	// What only mentioned them is kept, with the mention blanked - as the database does it.
	assert.deepEqual([scrubbed.tables.users[1].created_by_user_id, scrubbed.tables.mailbox_access[0].created_by_user_id, scrubbed.tables.backups[0].created_by_user_id], [null, null, null]);
	assert.deepEqual(dangling(scrubbed), [], "nothing left points at a row that is gone, so it restores");

	// By ids known from the database, when the backup holds no account to find them by.
	const byId = document();
	byId.tables.users = byId.tables.users.filter((row) => row.id !== "u_sam");
	assert.equal(scrub(byId, { digests: [digestOf("sam@a.test")] }).removed, 0, "an address finds nobody without the account");
	assert.ok(scrub(byId, { userIds: ["u_sam"], mailboxIds: ["m_sam"] }).removed > 0);
	assert.ok(!byId.tables.messages.some((row) => row.user_id === "u_sam"));

	// Someone the backup shows owning a domain is not cut out of it: every mailbox on it would go.
	assert.match(scrub(document(), { digests: [digestOf("root@a.test")] }).unsafe ?? "", /the owner of a\.test/);
	assert.equal(scrub(document(), { digests: [digestOf("nobody@a.test")] }).removed, 0);
	assert.equal(parseBackup('{"format":"something-else","version":1,"tables":{}}'), null);
});

test("a tombstone is an address or its digest, and nobody is both declared and erased", () => {
	const digest = digestOf("sam@a.test");
	assert.match(digest, /^sha256:[0-9a-f]{64}$/);
	assert.deepEqual(tombstones({ domain: "A.test", erased: ["Sam", "sam@a.test", digest, "kim"] }).map((stone) => [stone.email, stone.label]), [["sam@a.test", "sam@a.test"], ["kim@a.test", "kim@a.test"]], "one person, however they are written");
	assert.deepEqual(tombstones({ erased: [digest] }), [{ digest, email: null, label: `${digest.slice(0, 19)}…` }]);

	assert.deepEqual(validateSpec({ domain: "a.test", erased: ["sam", "kim@a.test", digest] }), []);
	assert.deepEqual(validateInstanceDocument({ erased: ["sam@elsewhere.test", digest] }), [], "the instance document takes any address");
	for (const [spec, expected] of [
		[{ domain: "a.test", erased: "sam" }, /erased: must be an array/],
		[{ domain: "a.test", erased: ["sam@b.test"] }, /"sam@b.test" is not on a.test/],
		[{ domain: "a.test", erased: ["sha256:abc"] }, /a digest is sha256: and 64 hex characters/],
		[{ domain: "a.test", erased: ["not an address"] }, /is not a name on a.test/],
		[{ erased: ["sam"] }, /"sam" needs its domain/],
		[{ domain: "a.test", accounts: [{ username: "sam" }], erased: ["sam"] }, /sam@a.test is declared and erased — a person is one or the other/],
		[{ domain: "a.test", accounts: [{ username: "Sam" }], erased: [digest] }, /sam@a.test is declared and erased/],
	] as Array<[Spec, RegExp]>) assert.match(validateSpec(spec).join("\n"), expected);
	// One document can erase whom another declares: a project checks them together.
	assert.match(erasedAndDeclared([{ erased: [digest] }, { domain: "a.test", accounts: [{ username: "sam" }] }]).join("\n"), /sam@a.test is declared and erased/);
	assert.match(erasedAndDeclared([{ fresh: { admin: { email: "root@a.test" } } }, { domain: "a.test", erased: ["root"] }]).join("\n"), /root@a.test is declared and erased/);
	assert.deepEqual(erasedAndDeclared([{ domain: "a.test", accounts: [{ username: "kim" }], erased: ["sam"] }]), []);
});

test("a tenant leaving for good erases its people on destroy; otherwise they are disabled, or kept", async () => {
	const tenant = (accounts?: "disable" | "erase" | "keep"): Spec => ({ domain: "dev.example", accounts: [{ username: "sam" }, { username: "kim" }], teardown: { ...(accounts ? { accounts } : {}), domain: "keep" } });
	const kept = fakeStore(PEOPLE);
	assert.match((await runOn(kept.store, DESTROY, tenant())).text, /· account\.sam\s+kept — teardown\.accounts is not "disable" or "erase"/);
	const disabled = fakeStore(PEOPLE);
	await runOn(disabled.store, DESTROY, tenant("disable"));
	assert.deepEqual(disabled.state.accounts.map((account) => account.disabled), [true, true]);
	assert.equal(disabled.state.mailboxes.length, 3, "disabled people keep their mailboxes");

	const { store, state, calls } = fakeStore(PEOPLE);
	await store.takeBackup();
	assert.match((await runOn(store, flags({ cleanup: true, status: true }), tenant("erase"))).text, /- account\.kim\n\s+- account\.sam|- account\.sam\n\s+- account\.kim/);
	const gone = await runOn(store, DESTROY, tenant("erase"));
	assert.equal(gone.code, 0, gone.text);
	assert.match(gone.text, /- account\.sam\s+erased: 2 rows, 0 objects, 1 backup rewritten without them/);
	assert.deepEqual([state.accounts.length, state.mailboxes.map((box) => box.id)], [0, ["mbx_office"]]);
	assert.deepEqual(calls.filter((call) => call.startsWith("eraseSubject")).sort(), ["eraseSubject:kim@dev.example", "eraseSubject:sam@dev.example"]);
	assert.deepEqual(parseBackup([...state.objects.values()][0])!.tables.users.map((row) => row.email), ["admin@instance.test"], "and they are out of the backup");
	assert.match(validateSpec({ domain: "a.test", teardown: { accounts: "delete" } }).join("\n"), /"delete" is not one of disable, erase, keep/);
});

test("the primary admin and a domain's owner cannot be erased: it is a problem in the plan, never attempted", async () => {
	const { store, state, calls } = fakeStore({ ...PEOPLE, accounts: [...PEOPLE.accounts, { id: "u_admin", email: "admin@instance.test", role: "admin", isPrimaryAdmin: true }] });
	const spec: Spec = { erased: ["admin@instance.test"] };
	assert.match((await runOn(store, PLAN, spec)).text, /! erased\.admin@instance\.test\s+cannot be erased: is the primary admin/);
	assert.equal((await runOn(store, flags({ confirmDestroy: true }), spec)).code, 1);
	assert.ok(state.accounts.some((account) => account.id === "u_admin") && !calls.some((call) => call.startsWith("eraseSubject")));
});

test("push is a round trip rather than a state: declaring it runs the test, destroy clears the subscriptions", async () => {
	const sent = fakeStore({ pushSubscriptions: 3 });
	assert.equal((await runOn(sent.store, PLAN, { push: {} })).code, 1, "there is always a test to run");
	assert.equal((await runOn(sent.store, flags(), { push: { to: "you@example.com" } })).code, 0);
	assert.equal(sent.calls.filter((call) => call === "sendViaCloudflare").length, 1);
	await runOn(sent.store, DESTROY, { push: {} });
	assert.equal(sent.state.pushSubscriptions, 0);
});

// --- one server's documents ----------------------------------------------------------

const quiet = { print: () => {} };
const INSTANCE = { name: "p/instance", spec: { license: { plan: "team" }, fresh: { admin: { email: "root@new.example", password: "password-123" } } } as Spec };
const TENANT = (domain: string): { name: string; spec: Spec } => ({ name: `p/${domain}`, spec: { domain, onboard: { receivingProvider: "none" }, mailboxes: [{ role: "support", shared: true }], accounts: [{ username: "sam", password: "password-123" }], teardown: { accounts: "disable", domain: "remove" } } });

test("an empty instance gets its admin on a plain apply - with no wipe - and one with users never does", async () => {
	const empty = fakeStore();
	empty.state.admin = null;
	const vault = memoryVault();
	const planned = await runDocuments(empty.store, PLAN, [INSTANCE, TENANT("a.example")], { ...quiet, vault });
	assert.ok(planned.every((result) => result.pending), "nothing can be read until it has an admin");
	const results = await runDocuments(empty.store, flags(), [INSTANCE, TENANT("a.example")], { ...quiet, vault });
	assert.ok(results.every((result) => result.ok));
	assert.ok(empty.calls.includes("insertAdmin:root@new.example") && !empty.calls.includes("wipeData"));
	assert.equal(vault.data.logins["root@new.example"].role, "primary admin");

	const live = fakeStore({ license: TEAM });
	await runDocuments(live.store, flags(), [INSTANCE], quiet);
	assert.ok(!live.calls.some((call) => call.startsWith("insertAdmin")), "an instance with an admin is left alone");
});

test("a reset reports a schema that will not come up", async () => {
	const { store } = fakeStore({ schema: false });
	const [result] = await runDocuments(store, flags({ fresh: true, confirmDestroy: true }), [INSTANCE], quiet);
	assert.equal(result.ok, false);
});

test("a bad document fails by itself, and the rest of the run carries on", async () => {
	const { store, state } = fakeStore({ license: TEAM });
	const results = await runDocuments(store, flags(), [{ name: "bad", spec: { mailboxes: [{ role: "x" }] } }, TENANT("a.example")], quiet);
	assert.deepEqual(results.map((result) => result.ok), [false, true]);
	assert.equal(state.domains.length, 1);
});

test("the limiter never runs more than its limit, and runs everything", async () => {
	const limit = limiter(3);
	let active = 0;
	let peak = 0;
	const done = await Promise.all(Array.from({ length: 20 }, (_, index) => limit(async () => {
		peak = Math.max(peak, ++active);
		await new Promise((resolve) => setTimeout(resolve, 1));
		active -= 1;
		return index;
	})));
	assert.equal(done.length, 20);
	assert.equal(peak, 3);
});

// --- the fleet ---------------------------------------------------------------------

const CONFIG: WranglerConfig = {
	name: "mailflare",
	services: [{ binding: "WORKER_SELF_REFERENCE", service: "mailflare" }],
	d1_databases: [{ binding: "DB", database_name: "mailflare", database_id: "id-default" }],
	r2_buckets: [{ binding: "BUCKET", bucket_name: "mailflare-raw" }],
	queues: { producers: [{ queue: "mailflare-inbound" }, { queue: "mailflare-outbound" }], consumers: [{ queue: "mailflare-inbound" }, { queue: "mailflare-outbound" }] },
};
const RUN = (over: Partial<Flags> = {}, concurrency = 1) => ({ flags: flags(over), concurrency, explicit: { url: false, db: false } });
const project = (name: string, server: Record<string, unknown> | null, domain: string) => ({ name, dir: "projects", server: server ? { name, ...server } : null, entries: [{ name: `${name}/instance`, spec: { license: { plan: "team" } } as Spec }, TENANT(domain)].map((entry) => ({ ...entry, name: entry.name.replace("p/", `${name}/`) })) });

/** A fleet in memory: one fake store per database. */
function fleet() {
	const stores = new Map<string, ReturnType<typeof fakeStore>>();
	const opened: Instance[] = [];
	const events: string[] = [];
	const out: string[] = [];
	const drift: string[] = [];
	const deps: FleetDeps = {
		serverDrift: async () => drift,
		openStore: async (instance, fn) => {
			opened.push(instance);
			if (!stores.has(instance.db)) stores.set(instance.db, fakeStore());
			return fn(stores.get(instance.db)!.store);
		},
		template: () => CONFIG,
		writeConfig: (_template, deployment) => void (deployment.generated && events.push(`config:${deployment.config}`)),
		vault: () => memoryVault(),
		warmUp: async () => void events.push("warm-up"),
		deploy: async (server, _deployment, options) => {
			events.push(`${options.dryRun ? "would-deploy" : "deploy"}:${server.name}`);
			return options.dryRun ? null : { ...server, url: `https://${server.name}.example.workers.dev`, databaseId: "id-new" };
		},
		undeploy: async (server, _deployment, options) => {
			events.push(`${options.dryRun ? "would-undeploy" : "undeploy"}:${server.name}`);
			return true;
		},
		print: (text) => out.push(text),
	};
	return { deps, stores, opened, events, out, drift };
}

test("every project runs against its own server, in parallel, and one failure does not stop the others", async () => {
	const { deps, stores, opened, events, out } = fleet();
	const projects = [
		project("mailflare", { url: "https://mail.example" }, "a.example"),
		project("mailflare-eu", { url: "https://eu.example", databaseId: "id-eu", jurisdiction: "eu" }, "b.example"),
		{ ...project("broken", { url: "https://broken.example", databaseId: "id-x" }, "c.example"), entries: [{ name: "broken/bad", spec: { mailboxes: [{ role: "x" }] } as Spec }] },
	];
	assert.equal(await runFleet(projects, RUN({}, 4), deps), 1, "the fleet is not all well");
	assert.deepEqual(opened.map((instance) => `${instance.db}|${instance.config}|${instance.url}|${instance.jurisdiction ?? "-"}`).sort(), ["broken|wrangler.broken.json|https://broken.example|-", "mailflare-eu|wrangler.mailflare-eu.json|https://eu.example|eu", "mailflare|wrangler.jsonc|https://mail.example|-"]);
	assert.deepEqual(stores.get("mailflare")!.state.domains.map((domain) => domain.hostname), ["a.example"], "each tenant landed on its own server");
	assert.deepEqual(stores.get("mailflare-eu")!.state.domains.map((domain) => domain.hostname), ["b.example"]);
	assert.ok(events.includes("config:wrangler.mailflare-eu.json") && !events.some((event) => event.includes("wrangler.jsonc")), "every server but the default is reached through a config generated for it");
	assert.equal(events[0], "warm-up", "the shared login is refreshed once, before anything runs in parallel");
	assert.match(out.join("\n"), /4\/5 document\(s\) ok/);
});

test("a server is the template with its own name, database, bucket, queues and jurisdiction", () => {
	const eu = deploymentFor(CONFIG, { name: "mailflare-eu", databaseId: "id-eu", jurisdiction: "eu" });
	assert.deepEqual(eu, { config: "wrangler.mailflare-eu.json", generated: true, worker: "mailflare-eu", database: "mailflare-eu", databaseId: "id-eu", bucket: "mailflare-eu-raw", queues: ["mailflare-eu-inbound", "mailflare-eu-outbound"], jurisdiction: "eu", placement: undefined });
	const config = serverConfig(CONFIG, eu);
	assert.deepEqual([config.name, config.services?.[0].service], ["mailflare-eu", "mailflare-eu"], "the Worker calls itself, so it names itself");
	assert.deepEqual(config.d1_databases?.[0], { binding: "DB", database_name: "mailflare-eu", database_id: "id-eu" });
	assert.deepEqual(config.r2_buckets?.[0], { binding: "BUCKET", bucket_name: "mailflare-eu-raw", jurisdiction: "eu" }, "the bucket is bound in its jurisdiction");
	assert.deepEqual(config.queues?.consumers?.map((consumer) => consumer.queue), ["mailflare-eu-inbound", "mailflare-eu-outbound"]);
	// What src/ reads to deliver mail to THIS Worker, and to pin its Durable Objects.
	assert.deepEqual(config.vars, { MAILFLARE_WORKER_NAME: "mailflare-eu", MAILFLARE_JURISDICTION: "eu" });
	assert.equal(CONFIG.name, "mailflare", "the template itself is untouched");

	const home = deploymentFor(CONFIG, { name: "mailflare" });
	assert.deepEqual([home.config, home.generated, home.databaseId], ["wrangler.jsonc", false, "id-default"], "wrangler.jsonc is the default server");
	// The Vite plugin picks the config when it BUILDS; `wrangler deploy --env` does not apply.
	assert.ok(deploySteps({ name: "mailflare-eu", jurisdiction: "eu" }, eu).includes("MAILFLARE_WRANGLER_CONFIG=wrangler.mailflare-eu.json npm run build"));
	assert.match(deploySteps({ name: "mailflare-eu", jurisdiction: "eu" }, eu)[0], /create the database mailflare-eu in jurisdiction eu/);
	assert.deepEqual(deploySteps({ name: "mailflare" }, home)[0], "npm run deploy");
	// A server that names its country runs there: its Worker is placed beside a cloud region in it.
	assert.deepEqual(serverConfig(CONFIG, deploymentFor(CONFIG, { name: "mailflare-de", country: "de" })).placement, { region: "aws:eu-central-1" });
	assert.deepEqual(serverConfig(CONFIG, deploymentFor(CONFIG, { name: "mailflare-x", country: "de", placement: "gcp:europe-west3" })).placement, { region: "gcp:europe-west3" }, "an exact region wins");
	assert.equal(serverConfig(CONFIG, eu).placement, undefined, "and one that does not say runs wherever a request arrives");
	// A server that does not manage DNS is never given a Cloudflare token, so it can touch no zone.
	assert.ok(secretsFor({ name: "x" }).includes("CF_TOKEN") && !secretsFor({ name: "x", managesDns: false }).includes("CF_TOKEN"));
});

test("a server with no recorded origin is deployed by apply, previewed by plan, and skipped by destroy", async () => {
	const undeployed = () => [project("mailflare-eu", { jurisdiction: "eu" }, "b.example")];
	const planned = fleet();
	assert.equal(await runFleet(undeployed(), RUN({ status: true }), planned.deps), 1);
	assert.deepEqual([planned.events, planned.opened.length], [["would-deploy:mailflare-eu"], 0], "there is no instance to plan against yet");
	assert.match(planned.out.join("\n"), /~ mailflare-eu\/instance {2}\(changes to make\)/, "not deployed yet is work to do, not a failure");

	const applied = fleet();
	assert.equal(await runFleet(undeployed(), RUN(), applied.deps), 0);
	assert.deepEqual([applied.events, applied.opened[0].url], [["deploy:mailflare-eu", "config:wrangler.mailflare-eu.json"], "https://mailflare-eu.example.workers.dev"]);

	const gone = fleet();
	assert.equal(await runFleet(undeployed(), RUN({ cleanup: true, confirmDestroy: true }), gone.deps), 0);
	assert.deepEqual([gone.events, gone.opened.length], [[], 0]);

	const template = fleet();
	assert.equal(await runFleet([project("example", { template: true }, "b.example")], RUN(), template.deps), 1);
	assert.match(template.out.join("\n"), /"example" is a template/);
	assert.deepEqual(template.events, [], "a template is never built");
});

test("a server's own document is reconciled: a plan says it differs, an apply deploys it again", async () => {
	const live = () => [project("mailflare-de", { url: "https://de.example", databaseId: "id-de", country: "de" }, "a.example")];
	const moved = fleet();
	moved.drift.push("it runs wherever a request arrives, not beside aws:eu-central-1");
	assert.equal(await runFleet(live(), RUN({ status: true }), moved.deps), 1, "a server that differs is not reconciled");
	assert.match(moved.out.join("\n"), /~ server mailflare-de: it runs wherever a request arrives, not beside aws:eu-central-1 — apply deploys it again/);
	assert.deepEqual(moved.events.filter((event) => event.includes("deploy")), [], "a plan deploys nothing");
	assert.equal(await runFleet(live(), RUN(), moved.deps), 0);
	assert.ok(moved.events.includes("deploy:mailflare-de"));
});

test("destroy takes the Worker last and only when confirmed; a local server is never deployed or removed", async () => {
	const live = () => [project("mailflare", { url: "https://mail.example" }, "a.example")];
	const preview = fleet();
	await runFleet(live(), RUN(), preview.deps);
	assert.equal(await runFleet(live(), RUN({ cleanup: true, status: true }), preview.deps), 1);
	assert.deepEqual(preview.events, ["would-undeploy:mailflare"]);
	assert.equal(preview.stores.get("mailflare")!.state.domains.length, 1, "unconfirmed, nothing is removed");
	assert.match(preview.out.join("\n"), /Re-run with --confirm-destroy to destroy/);

	assert.equal(await runFleet(live(), RUN({ cleanup: true, confirmDestroy: true }), preview.deps), 0);
	assert.deepEqual(preview.events, ["would-undeploy:mailflare", "undeploy:mailflare"]);
	assert.equal(preview.stores.get("mailflare")!.state.domains.length, 0);

	const local = fleet();
	const sandbox = [project("_sandbox", { local: true }, "small.test")];
	assert.equal(await runFleet(sandbox, RUN(), local.deps), 0);
	assert.equal(await runFleet(sandbox, RUN({ cleanup: true, confirmDestroy: true }), local.deps), 0);
	assert.deepEqual(local.events, [], "no deploy, no undeploy, no generated config");
	assert.deepEqual([local.opened[0].local, local.opened[0].url, local.opened[0].db], [true, process.env.MAILFLARE_URL ?? "http://localhost:3000", "mailflare"]);
});

test("a typed flag wins over the server document, and --local never reaches a deployed origin", () => {
	const mailflare = project("mailflare", { url: "https://mail.example" }, "a.example");
	const typed = resolveInstance(mailflare, { flags: flags({ url: "https://other.example", db: "other" }), concurrency: 1, explicit: { url: true, db: true } }, CONFIG);
	assert.deepEqual([typed.instance.url, typed.instance.db], ["https://other.example", "other"]);
	const local = resolveInstance(mailflare, { flags: flags({ local: true, url: "http://localhost:3000" }), concurrency: 1, explicit: { url: false, db: false } }, CONFIG);
	assert.deepEqual([local.instance.local, local.instance.url, local.instance.db, local.deployment], [true, process.env.MAILFLARE_URL ?? "http://localhost:3000", "mailflare", null]);
});

test("the router sends every domain to the server its documents are on, and to no other", () => {
	const map = fleetMap([
		project("mailflare", { url: "https://mail.example/" }, "a.example"),
		project("mailflare-eu", { url: "https://eu.example", jurisdiction: "eu" }, "b.example"),
		project("pending", { jurisdiction: "eu" }, "c.example"),
		project("_sandbox", { local: true, url: "http://localhost:3000" }, "small.test"),
	]);
	assert.deepEqual(map, { domains: { "a.example": "mailflare", "b.example": "mailflare-eu" }, servers: { mailflare: { url: "https://mail.example" }, "mailflare-eu": { url: "https://eu.example", jurisdiction: "eu" } }, countries: {} }, "a server with no origin, or a local one, is not routed to");
	// Where someone NEW would be at home, by country: what each server says it serves.
	const homes = fleetMap([project("mailflare-eu", { url: "https://eu.example", jurisdiction: "eu", country: "de", serves: ["eu"] }, "b.example"), project("mailflare-uk", { url: "https://uk.example", country: "gb" }, "c.example")]);
	assert.deepEqual([homes.countries.de, homes.countries.fr, homes.countries.gb, homes.countries.us, homes.servers["mailflare-uk"].country], ["mailflare-eu", "mailflare-eu", "mailflare-uk", undefined, "gb"]);
	assert.notEqual(fleetVersion(map), fleetVersion({ ...map, domains: { ...map.domains, "a.example": "mailflare-eu" } }), "moving a domain is a new fleet");
});

// --- conformance: the same properties the real servers are held to ---------------------

test("the data-center list says which country an answer came from, and every country a server can run in has one", () => {
	assert.deepEqual([coloOf("remote-FRA"), coloOf("local-LHR"), coloOf(null), coloOf("somewhere")], ["FRA", "LHR", null, null]);
	assert.deepEqual([countryOfColo("FRA"), countryOfColo("LHR"), countryOfColo("QQQ")], ["de", "gb", null]);
	// A country with a built-in region and no data center could be declared and never be run in.
	assert.deepEqual(Object.keys(PLACEMENTS).filter((country) => !hasColo(country)), []);

	// The list is someone else's file: only codes and countries are taken, and a broken one is refused.
	const published = Object.fromEntries(Object.entries(loadColos()).map(([code, cca2]) => [code, { cca2, city: "anything" }]));
	assert.deepEqual(parseColoList(published), loadColos());
	assert.throws(() => parseColoList({ FRA: { cca2: "DE" } }), /holds only 1 entries/);
	assert.throws(() => parseColoList({ ...published, "<script>": { cca2: "DE" } }), /not a code and a country/);
	assert.throws(() => parseColoList({ ...published, FRA: { cca2: "Germany" } }), /not a code and a country: FRA/);
	assert.throws(() => parseColoList([]), /not an object of codes/);
});

test("conformance holds: builds, converges, follows every kind of edit, leaves, and comes back", async () => {
	const { deps, stores } = fleet();
	const server = (name: string, domain: string) => ({ name, dir: "conformance", complete: true, server: { name, url: `https://${name}.example`, disposable: true }, entries: [
		{ name: `${name}/instance`, spec: { license: { plan: "team" }, settings: { appName: "Conformance" }, backups: { enabled: true, schedule: "daily", retentionDays: 14 }, fresh: { admin: { email: `root@${domain}` } } } as Spec },
		{ name: `${name}/${domain}`, spec: { domain, onboard: { receivingProvider: "none" }, mailboxes: [{ role: "office" }], teardown: { accounts: "disable", domain: "remove" } } as Spec },
	] });
	const projects = [server("one", "one.example"), server("two", "two.example")];
	const lines: string[] = [];
	const code = await conform({ concurrency: 2, quick: false, load: () => projects }, deps, reporter((line) => lines.push(line)));
	assert.equal(code, 0, lines.join("\n"));
	assert.ok(lines.filter((line) => line.startsWith("  ✓")).length >= 24, "every property was checked");
	for (const property of ["the current code is rolled out", "apply: every server exists", "plan: nothing to do", "add: the plan is the additions", "declared erased: the plan is that person", "erasing waits for approval", "erased, once approved", "destroy: everything declared"]) {
		assert.ok(lines.some((line) => line.startsWith(`  ✓ ${property}`)), `"${property}" was not checked`);
	}
	assert.deepEqual([...stores.keys()].sort(), ["one", "two"], "each server through its own store");

	// One of every kind of thing: the additions are everything a document can say.
	const add = rounds(projects[0])!.add;
	for (const kind of ["account", "mailbox", "mailbox_access", "alias", "folder", "rule", "routing", "mcpKey", "template", "contact", "bookingPage", "event", "drive", "apiKey", "webhook", "settings"]) {
		assert.ok(add.expects.some((line) => line.includes(`: + ${kind}.`) || line.includes(`: ~ ${kind}.`)), `${kind} is not among the things conformance adds`);
	}

	// It resets what it runs on, so it refuses a server that does not say it may be.
	const said: string[] = [];
	assert.equal(await conform({ concurrency: 1, quick: true, load: () => [project("mailflare", { url: "https://mail.example" }, "a.example")] }, { ...deps, print: (text) => void said.push(text) }), 1);
	assert.match(said.join("\n"), /only runs on servers that say they are disposable\. Not: mailflare/);
});

// --- the command line ----------------------------------------------------------------

test("the command line: a target and a verb, in either order, and nothing ambiguous", () => {
	const run = (...argv: string[]) => parseCli(argv);
	assert.deepEqual(run("mailflare", "plan").command, { kind: "run", verb: "plan", target: { kind: "project", name: "mailflare" } });
	assert.deepEqual(run("destroy", "mailflare").command, run("mailflare", "destroy").command, "verb first is the same command, not 'destroy everything'");
	assert.deepEqual(run("plan").command, { kind: "run", verb: "plan", target: { kind: "all" } });
	assert.deepEqual(run("a/b/x.json", "apply").command, { kind: "run", verb: "apply", target: { kind: "document", path: "a/b/x.json" } });
	assert.deepEqual(run("some/folder", "plan").command, { kind: "run", verb: "plan", target: { kind: "folder", path: "some/folder" } });

	// A destroy or a reset is a report until it is confirmed.
	assert.deepEqual([run("x", "destroy").flags.status, run("x", "destroy", "--confirm-destroy").flags.status], [true, false]);
	assert.deepEqual([run("x", "reset").flags.status, run("x", "reset").flags.fresh, run("x", "reset", "--confirm-destroy").flags.status], [true, true, false]);
	assert.equal(run("x", "apply").flags.status, false);

	assert.equal(run("x", "plan", "--local").flags.url, process.env.MAILFLARE_URL ?? "http://localhost:3000", "--local means the dev server");
	assert.equal(run("x", "plan").flags.url, undefined);
	assert.deepEqual([run("subject", "Sam@Example.com").command, run("subject", "sam@example.com", "plan").command], [{ kind: "subject", email: "sam@example.com" }, { kind: "subject", email: "sam@example.com" }]);
	assert.throws(() => run("subject", "sam@example.com", "destroy"), /erased by a document, not by a command/, "erasing is desired state: it has no command");
	assert.deepEqual(run("router", "apply").command, { kind: "router", verb: "apply" });
	assert.deepEqual([run("deploy").command, run("mailflare-eu", "deploy").command], [{ kind: "deploy", target: { kind: "all" } }, { kind: "deploy", target: { kind: "project", name: "mailflare-eu" } }]);
	assert.deepEqual([run("logins").command, run("mailflare", "logins").command], [{ kind: "logins", project: undefined }, { kind: "logins", project: "mailflare" }]);
	assert.deepEqual(run("colos").command, { kind: "colos" });
	assert.deepEqual([run("apply", "--rotate-passwords").flags.rotatePasswords, run("apply").flags.rotatePasswords, run("apply").credentials], [true, false, "scripts/state/credentials"]);

	for (const bad of [["mailflare"], ["reset"], ["mailflare", "frobnicate"], ["a", "plan", "b"], [], ["x", "plan", "--bogus"], ["x", "plan", "--concurrency", "abc"], ["subject"], ["subject", "sam@example.com", "nuke"], ["subject", "sam@example.com", "destroy", "--confirm-destroy"], ["router"], ["router", "reset"], ["colos", "plan"]]) {
		assert.throws(() => parseCli(bad), UsageError, `"${bad.join(" ")}" must be refused`);
	}
});

// --- documents ------------------------------------------------------------------------

test("a document is checked against the model before anything reads it", () => {
	assert.deepEqual(validateSpec(FULL), [], "a good document passes");
	const expects: Array<[Spec | unknown, RegExp]> = [
		[{ domain: "a.test", mailboxs: [] }, /mailboxs: unknown section/],
		[{ domain: "a.test", mailboxes: [{ displayName: "Oops" }] }, /mailboxes\[0\]: needs a role/],
		[{ domain: "a.test", mailboxes: [{ role: "office", shared: "yes" }] }, /shared: must be true or false/],
		[{ domain: "a.test", mailboxes: [{ role: "office", access: [{ email: "a@a.test", permission: "fullaccess" }] }] }, /"fullaccess" is not one of/],
		[{ domain: "a.test", mailboxes: [{ role: "office" }, { role: "Office" }] }, /mailbox "Office" is declared twice/],
		[{ mailboxes: [{ role: "office" }] }, /mailboxes: needs a domain/],
		[{ domain: "a.test", onboard: null }, /onboard: must be an object/],
		[{ domain: "a.test", accounts: [{ name: "Sam" }] }, /accounts\[0\]: needs a username/],
		[{ domain: "a.test", accounts: [{ username: "sam", role: "amdin" }] }, /"amdin" is not one of admin, user/],
		[{ domain: "a.test", routing: [{ pattern: "*", action: "forward" }] }, /a forward rule needs forwardTo/],
		[{ domain: "a.test", routing: [{ pattern: "*", action: "store" }] }, /a store rule needs a mailbox/],
		[{ domain: "a.test", mcpKeys: [{ name: "agent", scopes: ["mcp:teleport"] }] }, /"mcp:teleport" is not one of/],
		[{ license: { plan: "teem" } }, /"teem" is not one of community, pro, team/],
		[{ license: {} }, /license: needs a plan/],
		[{ settings: { outboundAttachmentMaxMb: 99 } }, /must be a whole number from 1 to 25/],
		[{ settings: { assistant: { provider: "compatible" } } }, /a compatible provider needs models/],
		[{ backups: { schedule: "weekly" } }, /a weekly schedule needs a day from 0 to 6/],
		[{ backups: { exclude: ["accounts", "mail", "automation", "assistant", "system"] } }, /cannot leave every group out/],
		[{ domain: "a.test", mailboxes: [{ role: "office", rules: [{ value: "x", action: "folder" }] }] }, /a rule that files mail needs a folder/],
		[{ domain: "a.test", mailboxes: [{ role: "office", folders: [{ name: "A" }, { name: "a" }] }] }, /a name "a" is declared twice/],
		[{ domain: "a.test", mailboxes: [{ role: "office", autoReply: { enabled: "yes" } }] }, /autoReply\.enabled: must be true or false/],
		[{ admin: { webhooks: [{ url: "https://x.example", events: ["message.read"] }] } }, /"message\.read" is not one of/],
		[{ domain: "a.test", accounts: [{ username: "sam", apiKeys: [{ name: "ci", scopes: ["domains"] }] }] }, /"domains" is not one of send, read/],
		[{ domain: "a.test", accounts: [{ username: "sam", calendar: { bookingPages: [{ name: "Call", durationMinutes: 30, weekdays: [1], startTime: "09:10", endTime: "17:00", timeZone: "UTC" }] } }] }, /startTime: must be a time on the quarter hour/],
		[{ domain: "a.test", accounts: [{ username: "sam", mailbox: { colour: "red" } }] }, /mailbox\.colour: unknown field/],
		[{ admin: { preferences: { trashRetentionDays: 0 } } }, /trashRetentionDays: must be a whole number of days/],
		[{ specs: {} }, /specs: must be an array/],
		[[], /must be a JSON object/],
	];
	for (const [doc, problem] of expects) assert.match(validateSpec(doc).join("\n"), problem);

	assert.match(validateInstanceDocument({ license: "team", mailboxes: [] }).join("\n"), /mailboxes: belongs in a <domain>\.json/);
	assert.match(validateTenantDocument({ domain: "a.test", license: "team" }, "a.test.json").join("\n"), /license: belongs in instance\.json/);
	assert.match(validateTenantDocument({ domain: "a.test" }, "b.test.json").join("\n"), /name the file after the domain/);
	assert.match(validateServer({ db: "x", port: 1 }).join("\n"), /port: unknown field/);
	assert.deepEqual(validateServer({ local: true }), []);
	assert.deepEqual(validateServer({ jurisdiction: "eu", disposable: true, managesDns: false }), []);
	assert.match(validateServer({ managesDns: "no" }).join("\n"), /managesDns: must be true or false/);
	assert.deepEqual(validateServer({ jurisdiction: "eu", region: "weur", databaseId: "x", bucket: "y", url: "https://a.example" }), []);
	assert.match(validateServer({ jurisdiction: "mars" }).join("\n"), /"mars" is not one of eu, fedramp/);

	// A home country: a server says where it runs and whom it serves, and a tenant must be at home on it.
	assert.deepEqual(validateServer({ country: "de", serves: ["eu", "ch"], jurisdiction: "eu" }), []);
	assert.match(validateServer({ country: "us", jurisdiction: "eu" }).join("\n"), /"us" is not in the European Union/);
	assert.match(validateServer({ country: "pt" }).join("\n"), /no region is known for "pt" — give `placement`/);
	assert.deepEqual(validateServer({ country: "pt", placement: "azure:somewhere" }), []);
	assert.match(validateServer({ country: "zz", placement: "azure:somewhere" }).join("\n"), /Cloudflare has no data center in "zz"/);
	const german = { name: "mailflare-de", country: "de", serves: ["de", "at"] };
	assert.deepEqual(validateTenantDocument({ domain: "a.test", country: "AT" }, "a.test.json", german), []);
	assert.match(validateTenantDocument({ domain: "a.test", country: "fr" }, "a.test.json", german).join("\n"), /"fr" is not at home on "mailflare-de", which serves de, at/);
	assert.match(validateTenantDocument({ domain: "a.test", country: "fr" }, "a.test.json", { name: "plain" }).join("\n"), /does not say which countries it serves/);
	assert.deepEqual(validateTenantDocument({ domain: "a.test" }, "a.test.json", german), [], "a tenant that names no country is not checked");
	assert.match(validateSpec({ domain: "a.test", country: "germany" }).join("\n"), /country: must be a two-letter country code/);
});

test("every checked-in project loads, in order, with a small, a medium and a large tenant", () => {
	for (const name of ["mailflare", "example", "_sandbox"]) {
		const loaded = loadProject(name);
		assert.equal(loaded.entries[0].name, `${name}/instance`, "the instance document comes first");
		// How much a tenant declares: its mailboxes, grants, accounts, rules and keys.
		const weight = (spec: Spec) => (spec.mailboxes ?? []).reduce((sum, box) => sum + 1 + (box.access?.length ?? 0), 0) + (spec.accounts?.length ?? 0) + (spec.routing?.length ?? 0) + (spec.mcpKeys?.length ?? 0);
		const sizes = loaded.entries.slice(1).map((entry) => weight(entry.spec)).sort((a, b) => a - b);
		assert.ok(sizes.length >= 3 && sizes.at(-1)! >= sizes[0] * 1.5, `${name} has a small, a medium and a large tenant (${sizes.join(", ")})`);
		assert.ok(loaded.entries.slice(1).every((entry) => entry.spec.onboard), `every ${name} tenant can be rebuilt from its document`);
	}
	assert.deepEqual(loadProjects().map((entry) => entry.name), ["mailflare", "mailflare-eu"], "templates and drafts stay out of a fleet run");
	assert.deepEqual([loadProject("mailflare-eu").server?.jurisdiction, loadProject("example").server?.template], ["eu", true]);
	assert.equal(loadProject("_sandbox").server?.local, true);
	assert.throws(() => loadProject("nope"), /no project "nope"/);
	assert.deepEqual(loadDocuments("scripts/state/fixtures/state-small.json").map((entry) => entry.name), ["dev-one.example", "dev-two.example"], "one file may hold many documents");
});

// --- held to the app: these fail when src/ moves and this system has not --------------

const tables = Object.values(schema).filter((value) => is(value, SQLiteTable)).map((table) => getTableConfig(table as SQLiteTable));

test("the erasure scope covers the real schema: every table classified, every user and mailbox column accounted for", () => {
	const direct = new Map(SUBJECT_SCOPE.map((scope) => [scope.table, scope]));
	const indirect = new Map(INDIRECT_SCOPE.map((link) => [link.table, link]));
	const names = new Set(tables.map((table) => table.name));
	for (const table of [...direct.keys(), ...indirect.keys(), ...SUBJECT_SCOPE_UNATTRIBUTABLE, ...INSTANCE_TABLES]) assert.ok(names.has(table), `${table} is in the scope but not in the schema`);
	assert.equal(new Set([...direct.keys(), ...indirect.keys()]).size, direct.size + indirect.size, "no table is listed twice");

	for (const table of tables) {
		if (table.name === "users") continue;
		const classified = direct.has(table.name) || indirect.has(table.name) || SUBJECT_SCOPE_UNATTRIBUTABLE.includes(table.name) || INSTANCE_TABLES.includes(table.name);
		assert.ok(classified, `${table.name} is a new table: say whose data it holds in subject-scope.ts`);
		const scope = direct.get(table.name);
		const columns = new Set(table.columns.map((column) => column.name));
		for (const column of [...(scope?.userColumns ?? []), ...(scope?.referenceColumns ?? []), ...(scope?.mailboxColumn ? [scope.mailboxColumn] : [])]) assert.ok(columns.has(column), `${table.name}.${column} does not exist`);
		for (const key of table.foreignKeys) {
			const reference = key.reference();
			const target = getTableConfig(reference.foreignTable).name;
			const column = reference.columns[0].name;
			if (target === "users") {
				const owning = scope?.userColumns?.includes(column);
				assert.ok(owning || scope?.referenceColumns?.includes(column), `${table.name}.${column} names a user and is not in the scope`);
				// A row the database would delete with the user is the user's; never a mere mention.
				if (key.onDelete === "cascade") assert.ok(owning, `${table.name}.${column} cascades with the user, so its rows are the subject's`);
			}
			if (target === "mailboxes") assert.equal(scope?.mailboxColumn, column, `${table.name}.${column} names a mailbox and is not in the scope`);
			if (indirect.has(table.name) && column === indirect.get(table.name)!.column) assert.equal(target, indirect.get(table.name)!.parent);
		}
	}

	// Every column that holds an object key is either a person's bytes or the instance's.
	const keys = [...SUBJECT_OBJECT_KEYS, ...INSTANCE_OBJECT_KEYS].map((ref) => `${ref.table}.${ref.column}`);
	for (const table of tables) for (const column of table.columns) if (/(^|_)r2_key$|avatar_key$|icon_key$/.test(column.name)) assert.ok(keys.includes(`${table.name}.${column.name}`), `${table.name}.${column.name} holds an object and is not listed`);
	for (const ref of SUBJECT_OBJECT_KEYS) assert.ok(isSubjectScoped(ref.table) || ref.table === "users");
});

test("the subject index: one predicate for the report and the erasure, children before parents", () => {
	const quote = (value: string) => `'${value}'`;
	assert.equal(subjectPredicate("messages", "u1", ["m1"], quote), "user_id='u1' OR mailbox_id IN ('m1')");
	assert.equal(subjectPredicate("shared_attachment_links", "u1", [], quote), `attachment_id IN (SELECT id FROM "message_attachments" WHERE message_id IN (SELECT id FROM "messages" WHERE user_id='u1'))`);
	assert.equal(subjectPredicate("backups", "u1", ["m1"], quote), null, "a row that only mentions the subject is not theirs to erase");
	assert.equal(subjectPredicate("app_settings", "u1", [], quote), null);
	assert.ok(depthOf("shared_attachment_links") > depthOf("message_attachments") && depthOf("message_attachments") > depthOf("messages"));

	const report = { email: "a@b.c", userId: "u1", mailboxIds: ["m1"], objects: 0, elsewhere: [], blockers: [], counts: [{ table: "messages", rows: 12 }, { table: "contacts", rows: 0 }, { table: "sessions", rows: 2 }, { table: "ai_usage", rows: -1 }] };
	assert.equal(subjectTotal(report), 14, "unknown rows are never summed as data");
	assert.deepEqual(subjectLines(report), ["      12  messages", "       2  sessions"]);
	assert.deepEqual(subjectUnknown(report), ["ai_usage"]);
});

test("the mirrors of things src/ does not export still match it", () => {
	const auth = readFileSync("src/lib/mcp/auth.ts", "utf8");
	const scopes = auth.match(/const MCP_SCOPES = new Set\(\[([^\]]+)\]\)/)?.[1].match(/"[^"]+"/g)?.map((scope) => scope.slice(1, -1));
	assert.deepEqual([...MCP_SCOPES].sort(), [...(scopes ?? [])].sort(), "MCP_SCOPES has moved in src/lib/mcp/auth.ts");
	assert.deepEqual([...BACKUP_GROUPS].sort(), BACKUP_TABLE_GROUPS.map((group) => group.id).sort());

	// A wipe empties every table, so it must put back exactly what the migrations seed.
	const seeded = readdirSync("drizzle/migrations").filter((file) => file.endsWith(".sql")).flatMap((file) => [...readFileSync(`drizzle/migrations/${file}`, "utf8").matchAll(/^INSERT INTO `(\w+)`/gm)].map((match) => match[1])).filter((table) => !table.endsWith("_fts"));
	assert.deepEqual(SEED_ROWS.map((row) => row.match(/INSERT INTO (\w+)/)?.[1]).sort(), [...new Set(seeded)].sort(), "a migration seeds a row that a reset does not restore");
});

test("every source change, needed or made, still matches the code it names", () => {
	assert.ok(SOURCE_CHANGES.length > 0 && SOURCE_CHANGES_MADE.length > 0);
	for (const change of [...SOURCE_CHANGES, ...SOURCE_CHANGES_MADE]) {
		assert.ok(/^(src\/|worker\.ts|vite\.config\.ts)/.test(change.where), `${change.where} must name the application`);
		assert.ok(change.why.length > 20, `${change.need}: the reason must be usable`);
		for (const anchor of change.anchors ?? []) {
			const text = readFileSync(anchor.file, "utf8");
			const where = anchor.line ? text.split("\n")[anchor.line - 1] ?? "" : text;
			assert.ok(where.includes(anchor.says), `${anchor.file}${anchor.line ? `:${anchor.line}` : ""} no longer says "${anchor.says}" — the code moved, or a change the fleet needs was reverted`);
		}
	}
});

test("wrangler.jsonc is read as JSONC", () => {
	const config = JSON.parse(stripJsonc(`{
		// the top-level server
		"name": "mailflare", /* inline */ "url": "https://example.com/a//b", // trailing
		"d1_databases": [{ "database_name": "mailflare" },],
	}`));
	assert.equal(config.url, "https://example.com/a//b", "a // inside a string is not a comment");
	assert.equal(config.d1_databases[0].database_name, "mailflare", "trailing commas are dropped");
});
