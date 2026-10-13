// Drives the whole reconciler through the Store seam, so a full run is exercised
// with no D1, no Workers binding and no network. Run with `npm run state:test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "../scripts/state/context";
import { run } from "../scripts/state/driver";
import { loadSpecs, runSpecs } from "../scripts/state/runner";
import { loadFleet, resolveInstance } from "../scripts/state/document";
import { SUBJECT_SCOPE, SUBJECT_SCOPE_INDIRECT, subjectLines, subjectTotal } from "../scripts/state/subject-scope";
import type { Flags } from "../scripts/state/flags";
import type { Role, Spec } from "../scripts/state/spec";
import type { Store } from "../scripts/state/store/types";

const ok = (json: unknown = {}) => ({ status: 200, text: "", json });
const created = (json: unknown = {}) => ({ status: 201, text: "", json });

type Seed = {
	domains?: Array<{ id: string; hostname: string }>;
	mailboxes?: Array<{ id: string; domainId: string; localPart: string; hostname: string; type?: string; userId?: string }>;
	accounts?: Array<{ id: string; email: string; name?: string; role?: string; disabled?: boolean; canManageMailboxes?: boolean; isPrimaryAdmin?: boolean }>;
	users?: Array<{ id: string; email: string }>;
	access?: Array<{ mailboxId: string; userId: string; permission: string }>;
	routing?: Array<Record<string, unknown>>;
	mcpKeys?: Array<{ id: string; name: string }>;
	license?: { plan: string; state: string } | null;
	workerSecrets?: string[] | null;
	pushSubscriptions?: number;
	schema?: boolean;
};

function fakeStore(seed: Seed = {}) {
	const state = {
		domains: seed.domains ?? [],
		mailboxes: seed.mailboxes ?? [],
		accounts: seed.accounts ?? [],
		users: seed.users ?? [],
		access: seed.access ?? [],
		routing: seed.routing ?? [],
		mcpKeys: seed.mcpKeys ?? [],
		license: seed.license ?? null,
		workerSecrets: seed.workerSecrets ?? ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"],
		pushSubscriptions: seed.pushSubscriptions ?? 0,
		sent: [] as string[],
		schema: seed.schema ?? true,
		subjectUserId: "u1" as string | null,
		subjectMailboxIds: ["m1"],
		subjectCounts: [{ table: "messages", rows: 12 }, { table: "contacts", rows: 0 }, { table: "sessions", rows: 2 }],
		lastAccountUpdate: {} as Record<string, unknown>,
	};
	const calls: string[] = [];
	let seq = 0;
	const store: Store = {
		base: "https://instance.test",
		admin: { id: "u_admin", email: "admin@instance.test" },
		async currentMx() {
			calls.push("currentMx");
			return [];
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
			return ok();
		},
		async listMailboxes() {
			calls.push("listMailboxes");
			return state.mailboxes as never;
		},
		async createMailbox(body) {
			const b = body as { domainId: string; localPart: string; type?: string; ownerUserId?: string };
			calls.push(`createMailbox:${b.localPart}`);
			const id = `mbx_${++seq}`;
			state.mailboxes.push({
				id,
				domainId: b.domainId,
				localPart: b.localPart,
				hostname: state.domains.find((d) => d.id === b.domainId)?.hostname ?? "",
				type: b.type,
				userId: b.ownerUserId ?? "u_admin",
			});
			return created({ id });
		},
		async deleteMailbox(id) {
			calls.push(`deleteMailbox:${id}`);
			state.mailboxes = state.mailboxes.filter((m) => m.id !== id);
			return ok();
		},
		mailboxOwnerId(id) {
			return state.mailboxes.find((m) => m.id === id)?.userId ?? null;
		},
		async listAccounts() {
			calls.push("listAccounts");
			return state.accounts as never;
		},
		async createAccount(body) {
			const b = body as { username: string; role?: string };
			calls.push(`createAccount:${b.username}`);
			state.accounts.push({ id: `u_${++seq}`, email: `${b.username}@dev.example`, name: b.username, role: b.role, disabled: false, canManageMailboxes: false });
			return created();
		},
		async updateAccount(id, body) {
			const b = body as { disabled: boolean };
			state.lastAccountUpdate = body as Record<string, unknown>;
			calls.push(`updateAccount:${id}:disabled=${b.disabled}`);
			const account = state.accounts.find((a) => a.id === id);
			if (account) account.disabled = b.disabled;
			return ok();
		},
		userIdByEmail(email) {
			return state.users.find((u) => u.email.toLowerCase() === email.toLowerCase())?.id ?? null;
		},
		accessPermission(mailboxId, userId) {
			return state.access.find((a) => a.mailboxId === mailboxId && a.userId === userId)?.permission ?? null;
		},
		grantAccess(mailboxId, userId, permission) {
			calls.push(`grantAccess:${userId}:${permission}`);
			const existing = state.access.find((a) => a.mailboxId === mailboxId && a.userId === userId);
			if (existing) existing.permission = permission;
			else state.access.push({ mailboxId, userId, permission });
		},
		revokeAccess(mailboxId, userId) {
			calls.push(`revokeAccess:${userId}`);
			state.access = state.access.filter((a) => !(a.mailboxId === mailboxId && a.userId === userId));
		},
		routingRule(domainId, pattern, action) {
			return (state.routing.find((r) => r.domainId === domainId && r.pattern === pattern && r.action === action) as never) ?? null;
		},
		insertRoutingRule(values) {
			calls.push(`insertRoutingRule:${values.pattern}:${values.action}`);
			state.routing.push({ id: `rr_${++seq}`, ...values });
		},
		updateRoutingRule(id, patch) {
			calls.push(`updateRoutingRule:${id}`);
			const rule = state.routing.find((r) => r.id === id);
			if (rule) Object.assign(rule, patch);
		},
		deleteRoutingRule(domainId, pattern, action) {
			calls.push(`deleteRoutingRule:${pattern}:${action}`);
			state.routing = state.routing.filter((r) => !(r.domainId === domainId && r.pattern === pattern && r.action === action));
		},
		licenseRow() {
			return state.license;
		},
		setLicense(plan) {
			calls.push(`setLicense:${plan ?? "community"}`);
			state.license = plan === null ? { plan: "community", state: "inactive" } : { plan, state: "active" };
		},
		workerSecrets() {
			return state.workerSecrets;
		},
		pushSubscriptionCount() {
			return state.pushSubscriptions;
		},
		firstAdminEmail() {
			return state.users[0]?.email ?? "admin@instance.test";
		},
		async sendViaCloudflare({ subject }) {
			calls.push(`sendViaCloudflare:${subject}`);
			state.sent.push(subject);
			return { messageId: "cf_1" };
		},
		async messageStatusBySubject(subject) {
			return state.sent.includes(subject) ? { status: "received" } : null;
		},
		async subjectReport(email) {
			calls.push(`subjectReport:${email}`);
			return { email, userId: state.subjectUserId, mailboxIds: state.subjectMailboxIds, counts: state.subjectCounts };
		},
		applyMigrations() {
			calls.push("applyMigrations");
		},
		schemaPresent() {
			return state.schema;
		},
		wipeData() {
			calls.push("wipeData");
			state.domains = [];
			state.mailboxes = [];
			state.accounts = [];
			state.users = [];
			state.access = [];
			state.routing = [];
			state.mcpKeys = [];
			state.license = null;
			state.schema = true;
		},
		insertAdmin({ email }) {
			calls.push(`insertAdmin:${email}`);
			state.users.push({ id: "u_root", email });
		},
		dispose() {},
		clearPushSubscriptions() {
			calls.push("clearPushSubscriptions");
			state.pushSubscriptions = 0;
		},
		async wait() {},

		mcpKey(userId, name) {
			return state.mcpKeys.some((k) => k.name === name) ? { id: "k" } : null;
		},
		createMcpKey({ name, scopes, mailboxIds }) {
			calls.push(`createMcpKey:${name}:${scopes.length}:${mailboxIds.length}`);
			state.mcpKeys.push({ id: `key_${++seq}`, name });
			return { fullKey: `ep_${name}` };
		},
		deleteMcpKey(userId, name) {
			calls.push(`deleteMcpKey:${name}`);
			state.mcpKeys = state.mcpKeys.filter((k) => k.name !== name);
		},
	};
	return { store, state, calls };
}

const flags = (over: Partial<Flags> = {}): Flags => ({
	dryRun: false, status: false, cleanup: false, onboard: false, confirmMx: false, replaceMx: false,
	share: false, disableAccounts: false, removeDomain: false, licenseStatus: false, push: false,
	steps: false, fresh: false, timeout: "40", db: "test", local: false, ...over,
});

const roles = (...entries: Array<Partial<Role> & { role: string }>): Role[] =>
	entries.map((entry) => ({ displayName: entry.role, share: false, access: [], ...entry }));

const projectFor = (domain: string, over: Partial<Spec> = {}): Spec => ({ domain, ...over });

// The logic prints as it goes; keep the test output clean.
async function quiet<T>(fn: () => Promise<T> | T): Promise<T> {
	const original = { log: console.log, error: console.error, warn: console.warn };
	console.log = () => {};
	console.error = () => {};
	console.warn = () => {};
	try {
		return await fn();
	} finally {
		Object.assign(console, original);
	}
}

const runOn = (store: Store, f: Flags, project: Spec, r: Role[]) =>
	quiet(() => run(makeContext(store, f, project, String(project.domain)), r));

test("creates missing mailboxes and grants access to other users", async () => {
	const { store, calls, state } = fakeStore({
		domains: [{ id: "d1", hostname: "dev.example" }],
		users: [{ id: "u_helper", email: "helper@dev.example" }],
	});
	const code = await runOn(store, flags(), projectFor("dev.example"), roles({ role: "office", access: [{ email: "helper@dev.example", permission: "full_access" }] }));
	assert.equal(code, 0);
	assert.ok(calls.includes("createMailbox:office"), "office mailbox created");
	assert.deepEqual(state.access, [{ mailboxId: "mbx_1", userId: "u_helper", permission: "full_access" }]);
});

test("is idempotent: an existing mailbox is left alone", async () => {
	const { store, calls } = fakeStore({
		domains: [{ id: "d1", hostname: "dev.example" }],
		mailboxes: [{ id: "mbx_1", domainId: "d1", localPart: "office", hostname: "dev.example" }],
	});
	const code = await runOn(store, flags(), projectFor("dev.example"), roles({ role: "office" }));
	assert.equal(code, 0);
	assert.ok(!calls.some((c) => c.startsWith("createMailbox")), "no mailbox created");
});

test("skips the owner's own access grant and clears a redundant one", async () => {
	const { store, state, calls } = fakeStore({
		domains: [{ id: "d1", hostname: "dev.example" }],
		mailboxes: [{ id: "mbx_1", domainId: "d1", localPart: "office", hostname: "dev.example", userId: "u_owner" }],
		users: [{ id: "u_owner", email: "owner@dev.example" }],
		access: [{ mailboxId: "mbx_1", userId: "u_owner", permission: "full_access" }],
	});
	await runOn(store, flags(), projectFor("dev.example"), roles({ role: "office", access: [{ email: "owner@dev.example" }] }));
	assert.ok(!calls.some((c) => c.startsWith("grantAccess")), "owner grant not inserted");
	assert.ok(calls.includes("revokeAccess:u_owner"), "redundant owner grant removed");
	assert.deepEqual(state.access, []);
});

test("dry-run changes nothing", async () => {
	const { store, calls } = fakeStore({ domains: [{ id: "d1", hostname: "dev.example" }], users: [{ id: "u_helper", email: "helper@dev.example" }] });
	const code = await runOn(
		store,
		flags({ dryRun: true }),
		projectFor("dev.example", { routing: [{ pattern: "*", action: "forward", forwardTo: "ops@example.com" }], mcpKeys: [{ name: "agent" }], accounts: [{ username: "sam" }] }),
		roles({ role: "office", access: [{ email: "helper@dev.example" }] }),
	);
	assert.equal(code, 0);
	assert.deepEqual(
		calls.filter((c) => /^(createMailbox|grantAccess|insertRoutingRule|updateRoutingRule|deleteMailbox|createMcpKey|createAccount|onboardDomain|removeDomain)/.test(c)),
		[],
		"no writes during a dry run",
	);
});

test("onboards a missing domain, then applies into it", async () => {
	const { store, calls } = fakeStore();
	const code = await runOn(store, flags({ onboard: true }), projectFor("fresh.example"), roles({ role: "office" }));
	assert.equal(code, 0);
	assert.ok(calls.includes("onboardDomain"), "domain onboarded");
	assert.ok(calls.includes("createMailbox:office"), "applied after onboarding");
});

test("refuses to onboard a domain that already has MX unless --confirm-mx", async () => {
	const { store } = fakeStore();
	const conflicted: Store = { ...store, currentMx: async () => [{ content: "mx.other.example" }] };
	assert.equal(await runOn(conflicted, flags({ onboard: true }), projectFor("live.example"), roles({ role: "office" })), 1);
	assert.equal(await runOn(conflicted, flags({ onboard: true, confirmMx: true }), projectFor("live.example"), roles({ role: "office" })), 0);
});

test("status reports missing items without writing", async () => {
	const { store, calls } = fakeStore({ domains: [{ id: "d1", hostname: "dev.example" }] });
	const code = await runOn(store, flags({ status: true }), projectFor("dev.example"), roles({ role: "office" }, { role: "support" }));
	assert.equal(code, 1, "missing mailboxes make status fail");
	assert.ok(!calls.some((c) => c.startsWith("createMailbox")), "status never writes");
});

test("routing: inserts, then leaves an identical rule alone, then reconciles drift", async () => {
	const project = projectFor("dev.example", { routing: [{ pattern: "*", action: "forward", forwardTo: "ops@example.com" }] });

	const fresh = fakeStore({ domains: [{ id: "d1", hostname: "dev.example" }] });
	await runOn(fresh.store, flags(), project, roles({ role: "office" }));
	assert.ok(fresh.calls.includes("insertRoutingRule:*:forward"));

	const identical = fakeStore({
		domains: [{ id: "d1", hostname: "dev.example" }],
		routing: [{ id: "rr_1", domainId: "d1", pattern: "*", action: "forward", match_value: "*", forward_to: "ops@example.com", keep_copy: 0, mailbox_id: null, reject_reason: null, priority: 0, enabled: 1 }],
	});
	await runOn(identical.store, flags(), project, roles({ role: "office" }));
	assert.ok(!identical.calls.some((c) => c.startsWith("insertRoutingRule") || c.startsWith("updateRoutingRule")), "identical rule untouched");

	const drifted = fakeStore({
		domains: [{ id: "d1", hostname: "dev.example" }],
		routing: [{ id: "rr_1", domainId: "d1", pattern: "*", action: "forward", match_value: "*", forward_to: "old@example.com", keep_copy: 0, mailbox_id: null, reject_reason: null, priority: 0, enabled: 1 }],
	});
	await runOn(drifted.store, flags(), project, roles({ role: "office" }));
	assert.ok(drifted.calls.includes("updateRoutingRule:rr_1"), "drifted rule updated");
});

test("mcp keys: rejects an unknown scope, else creates once and is idempotent", async () => {
	const bad = fakeStore({ domains: [{ id: "d1", hostname: "dev.example" }] });
	assert.equal(await runOn(bad.store, flags(), projectFor("dev.example", { mcpKeys: [{ name: "agent", scopes: ["mcp:teleport"] }] }), roles({ role: "office" })), 1, "unknown scope fails");
	assert.ok(!bad.calls.some((c) => c.startsWith("createMcpKey")));

	const good = fakeStore({ domains: [{ id: "d1", hostname: "dev.example" }] });
	assert.equal(await runOn(good.store, flags(), projectFor("dev.example", { mcpKeys: [{ name: "agent", mailboxes: ["office"] }] }), roles({ role: "office" })), 0);
	assert.ok(good.calls.includes("createMcpKey:agent:6:1"), "six default scopes, one mailbox");

	const again = fakeStore({ domains: [{ id: "d1", hostname: "dev.example" }], mcpKeys: [{ id: "key_1", name: "agent" }] });
	await runOn(again.store, flags(), projectFor("dev.example", { mcpKeys: [{ name: "agent" }] }), roles({ role: "office" }));
	assert.ok(!again.calls.some((c) => c.startsWith("createMcpKey")), "existing key not recreated");
});

test("cleanup removes mailboxes, routing, keys, disables accounts and the domain", async () => {
	const { store, calls, state } = fakeStore({
		domains: [{ id: "d1", hostname: "dev.example" }],
		mailboxes: [{ id: "mbx_1", domainId: "d1", localPart: "office", hostname: "dev.example" }],
		accounts: [{ id: "u_sam", email: "sam@dev.example", name: "sam", role: "user", disabled: false, canManageMailboxes: false }],
		mcpKeys: [{ id: "key_1", name: "agent" }],
		routing: [{ id: "rr_1", domainId: "d1", pattern: "*", action: "forward" }],
	});
	const code = await runOn(
		store,
		flags({ cleanup: true, disableAccounts: true, removeDomain: true }),
		projectFor("dev.example", { accounts: [{ username: "sam" }], mcpKeys: [{ name: "agent" }], routing: [{ pattern: "*", action: "forward" }] }),
		roles({ role: "office" }),
	);
	assert.equal(code, 0);
	assert.ok(calls.includes("deleteMailbox:mbx_1"), "mailbox deleted");
	assert.ok(calls.includes("deleteRoutingRule:*:forward"), "routing removed");
	assert.ok(calls.includes("deleteMcpKey:agent"), "key removed");
	assert.ok(calls.includes("updateAccount:u_sam:disabled=true"), "account disabled");
	assert.ok(calls.includes("removeDomain:d1"), "domain removed");
	assert.equal(state.accounts[0].disabled, true);
});

test("cleanup never disables the primary admin", async () => {
	const { store, calls } = fakeStore({
		domains: [{ id: "d1", hostname: "dev.example" }],
		accounts: [{ id: "u_root", email: "root@dev.example", name: "root", role: "admin", disabled: false, canManageMailboxes: true, isPrimaryAdmin: true }],
	});
	await runOn(store, flags({ cleanup: true, disableAccounts: true }), projectFor("dev.example", { accounts: [{ username: "root" }] }), roles({ role: "office" }));
	assert.ok(!calls.some((c) => c.includes("u_root")), "primary admin untouched");
});

test("mass mode processes every project through one store", async () => {
	const { store, calls } = fakeStore({ domains: [{ id: "d1", hostname: "a.example" }, { id: "d2", hostname: "b.example" }] });
	const entries = [
		{ name: "a.example", spec: projectFor("a.example", { mailboxes: [{ role: "office" }] }) },
		{ name: "b.example", spec: projectFor("b.example", { mailboxes: [{ role: "hello" }] }) },
	];
	const code = await quiet(() => runSpecs(store, flags(), { roles: "" }, entries));
	assert.equal(code, 0);
	assert.ok(calls.includes("createMailbox:office") && calls.includes("createMailbox:hello"), "both documents applied");
});

test("mass mode keeps going and reports failure per project", async () => {
	const { store } = fakeStore({ domains: [{ id: "d1", hostname: "ok.example" }] });
	const entries = [
		{ name: "ok.example", spec: projectFor("ok.example", { mailboxes: [{ role: "office" }] }) },
		{ name: "broken", spec: { mailboxes: [{ role: "x" }] } },
	];
	const code = await quiet(() => runSpecs(store, flags(), { roles: "" }, entries));
	assert.equal(code, 1, "one bad project fails the run");
});

test("a multi-document file loads every document", () => {
	const entries = loadSpecs({ spec: "tests/fixtures/state-small.json", dir: "" });
	assert.deepEqual(entries.map((e) => e.name), ["dev-one.example", "dev-two.example"]);
});

test("scanning the specs folder skips the placeholder and drafts", () => {
	const entries = loadSpecs({ dir: "scripts/state/specs" });
	assert.ok(entries.length > 0, "found documents");
	assert.ok(!entries.some((e) => /example\.json$/.test(e.name)), "example.json is skipped");
	assert.ok(!entries.some((e) => /\/_/.test(e.name)), "_*.json drafts are skipped");
});

// --- the global capabilities, which need no domain -----------------------------

test("license: applied only when asked, and reverted by --cleanup", async () => {
	const ctxFor = (f: Flags, project: Spec) => [f, project] as const;

	const fresh = fakeStore();
	const [f1, p1] = ctxFor(flags({ plan: "team" }), {});
	await runOn(fresh.store, f1, p1, []);
	assert.deepEqual(fresh.calls.filter((c) => c.startsWith("setLicense")), ["setLicense:team"]);
	assert.deepEqual(fresh.state.license, { plan: "team", state: "active" });

	const fromDocument = fakeStore();
	await runOn(fromDocument.store, flags(), { license: { plan: "pro" } }, []);
	assert.ok(fromDocument.calls.includes("setLicense:pro"), "a document section works without a flag");

	const dry = fakeStore();
	await runOn(dry.store, flags({ plan: "team", dryRun: true }), {}, []);
	assert.ok(!dry.calls.some((c) => c.startsWith("setLicense")), "dry run writes nothing");

	const undo = fakeStore({ license: { plan: "team", state: "active" } });
	await runOn(undo.store, flags({ cleanup: true }), { license: { plan: "team" } }, []);
	assert.ok(undo.calls.includes("setLicense:community"), "cleanup reverts to community");
});

test("license: --license-status reports the gates", async () => {
	const { store } = fakeStore({ license: { plan: "team", state: "active" } });
	assert.equal(await runOn(store, flags({ licenseStatus: true, status: true }), { license: {} }, []), 0);
});

test("a global-only run needs no domain and touches no domain resource", async () => {
	const { store, calls } = fakeStore();
	const code = await runOn(store, flags({ plan: "team" }), {}, []);
	assert.equal(code, 0);
	assert.ok(!calls.includes("listDomains"), "domain never resolved");
	assert.ok(!calls.some((c) => c.startsWith("createMailbox")), "no domain-scoped work");
});

test("push: sends a test email, waits for arrival, and cleanup clears subscriptions", async () => {
	const sent = fakeStore({ users: [{ id: "u_a", email: "admin@instance.test" }], pushSubscriptions: 1 });
	assert.equal(await runOn(sent.store, flags({ push: true }), {}, []), 0);
	assert.equal(sent.calls.filter((c) => c.startsWith("sendViaCloudflare")).length, 1, "one email sent");

	const dry = fakeStore({ pushSubscriptions: 1 });
	assert.equal(await runOn(dry.store, flags({ push: true, dryRun: true }), {}, []), 0);
	assert.ok(!dry.calls.some((c) => c.startsWith("sendViaCloudflare")), "dry run sends nothing");

	const undo = fakeStore({ pushSubscriptions: 3 });
	await runOn(undo.store, flags({ cleanup: true }), { push: {} }, []);
	assert.ok(undo.calls.includes("clearPushSubscriptions"), "cleanup clears subscriptions");
});

test("push: a document section works without the flag", async () => {
	const { store, calls } = fakeStore({ users: [{ id: "u_a", email: "admin@instance.test" }], pushSubscriptions: 1 });
	assert.equal(await runOn(store, flags(), { push: { to: "you@example.com" } }, []), 0);
	assert.equal(calls.filter((c) => c.startsWith("sendViaCloudflare")).length, 1, "the section alone triggers it");
});

test("status resolves mailbox roles for routing rules", async () => {
	// Regression: status must publish mailbox ids, or a routing rule that names a
	// mailbox by role reports a bogus "mailbox not found" and fails the run.
	const { store } = fakeStore({
		domains: [{ id: "d1", hostname: "dev.example" }],
		mailboxes: [{ id: "mbx_1", domainId: "d1", localPart: "support", hostname: "dev.example", type: "shared" }],
		routing: [
			{ id: "rr_1", domainId: "d1", pattern: "*", action: "store", match_value: "*", forward_to: null, keep_copy: 0, mailbox_id: "mbx_1", reject_reason: null, priority: 0, enabled: 1 },
		],
	});
	const project = projectFor("dev.example", { mailboxes: [{ role: "support" }], routing: [{ pattern: "*", action: "store", mailbox: "support" }] });
	assert.equal(await runOn(store, flags({ status: true }), project, roles({ role: "support" })), 0);
});

// --- fresh: take a brand-new server from nothing ---------------------------------

test("fresh wipes the instance and creates the primary admin", async () => {
	const { store, state, calls } = fakeStore({
		domains: [{ id: "d1", hostname: "old.example" }],
		accounts: [{ id: "u_old", email: "old@old.example" }],
	});
	const code = await runOn(store, flags({ fresh: true, adminEmail: "root@new.example" }), { fresh: {} }, []);
	assert.equal(code, 0);
	assert.ok(calls.includes("wipeData"), "data wiped");
	assert.ok(calls.includes("insertAdmin:root@new.example"), "admin created");
	assert.deepEqual(state.domains, [], "previous domains gone");
	assert.deepEqual(state.accounts, [], "previous accounts gone");
});

test("fresh in a dry run writes nothing", async () => {
	const { store, calls } = fakeStore({ domains: [{ id: "d1", hostname: "old.example" }] });
	assert.equal(await runOn(store, flags({ fresh: true, dryRun: true }), { fresh: {} }, []), 0);
	assert.ok(!calls.includes("wipeData") && !calls.includes("insertAdmin:admin@localhost"), "no writes");
});

test("fresh runs before the domain work, so a new server bootstraps in one go", async () => {
	const { store, calls } = fakeStore({ domains: [{ id: "d1", hostname: "dev.example" }] });
	const project = projectFor("dev.example", { onboard: { receivingProvider: "none" }, mailboxes: [{ role: "office" }], fresh: {} });
	assert.equal(await runOn(store, flags({ fresh: true, onboard: true }), project, roles({ role: "office" })), 0);
	assert.ok(calls.indexOf("wipeData") < calls.indexOf("listDomains"), "reset precedes domain resolution");
	assert.ok(calls.includes("createMailbox:office"), "provisioned after the reset");
});

test("fresh reports a missing schema as a failure in status", async () => {
	const { store } = fakeStore({ schema: false });
	assert.equal(await runOn(store, flags({ fresh: true, status: true }), { fresh: {} }, []), 1);
});

test("teardown reverts the license last, so account management still works", async () => {
	// Regression: reverting the license first 403s the account disable (it needs a
	// Pro/Team plan), which silently left accounts enabled after a teardown.
	const { store, calls } = fakeStore({
		domains: [{ id: "d1", hostname: "dev.example" }],
		accounts: [{ id: "u_sam", email: "sam@dev.example", name: "sam", role: "user", disabled: false, canManageMailboxes: false }],
		license: { plan: "team", state: "active" },
	});
	const project = projectFor("dev.example", { accounts: [{ username: "sam" }], license: { plan: "team" } });
	await runOn(store, flags({ cleanup: true, disableAccounts: true }), project, roles({ role: "office" }));
	assert.ok(calls.includes("updateAccount:u_sam:disabled=true"), "account disabled during teardown");
	assert.ok(calls.indexOf("updateAccount:u_sam:disabled=true") < calls.indexOf("setLicense:community"), "license reverted after the accounts");
});

test("account updates never send back the schema's null transforms", async () => {
	// Regression: updateManagedAccountSchema turns an omitted password into null, and
	// posting that back fails the app's own parse with a 400.
	const { store, state } = fakeStore({
		domains: [{ id: "d1", hostname: "dev.example" }],
		accounts: [{ id: "u_sam", email: "sam@dev.example", name: "", role: "user", disabled: false, canManageMailboxes: false }],
	});
	await runOn(store, flags({ cleanup: true, disableAccounts: true }), projectFor("dev.example", { accounts: [{ username: "sam" }] }), roles({ role: "office" }));
	const body = state.lastAccountUpdate as Record<string, unknown>;
	assert.equal(body.disabled, true);
	assert.ok(!("password" in body), "no password key");
	assert.ok(!("forwardingEmail" in body), "no forwardingEmail key");
	assert.equal(body.name, "sam", "an empty stored name falls back to the username");
});

test("a reset-only document is accepted without a domain", async () => {
	// Regression: the "needs no domain" check was hand-built in two places and both
	// forgot fresh, so a document that only reset the instance was rejected outright.
	const { store, calls } = fakeStore();
	const code = await quiet(() => runSpecs(store, flags({ fresh: true }), { roles: "" }, [{ name: "instance", spec: { fresh: {} } }]));
	assert.equal(code, 0);
	assert.ok(calls.includes("wipeData"), "the reset ran");
});

test("an instance document is applied before the tenant documents", async () => {
	// The instance layer exists so a tenant does not have to declare server-wide facts
	// (the licence) - and so it cannot silently depend on one it never declared. That
	// only works if the instance document runs FIRST.
	const { store, calls } = fakeStore({
		domains: [{ id: "d1", hostname: "dev.example" }],
		users: [],
	});
	const instance = { name: "instance", spec: { license: { plan: "team" } } };
	const tenant = { name: "dev.example", spec: projectFor("dev.example", { mailboxes: [{ role: "support", shared: true }] }) };
	assert.equal(await quiet(() => runSpecs(store, flags(), { roles: "" }, [instance, tenant])), 0);
	assert.ok(calls.includes("setLicense:team"), "licence applied");
	assert.ok(calls.includes("createMailbox:support"), "tenant provisioned");
	assert.ok(calls.indexOf("setLicense:team") < calls.indexOf("createMailbox:support"), "instance layer ran first");
});

test("--instance resolves a fleet name, and a path stays a path", () => {
	const fleet = [{ name: "mailflare", url: "https://x.workers.dev", db: "mailflare" }];
	assert.deepEqual(resolveInstance("mailflare", fleet), {
		name: "mailflare", docPath: "scripts/state/specs/instances/mailflare.json",
		url: "https://x.workers.dev", db: "mailflare",
	});
	assert.deepEqual(resolveInstance("scripts/state/specs/instances/example.json", fleet), {
		name: "scripts/state/specs/instances/example.json",
		docPath: "scripts/state/specs/instances/example.json",
	});
	assert.throws(() => resolveInstance("nope", fleet), /unknown instance/);
});

test("the checked-in fleet names the live instance so a run needs no --url", () => {
	const fleet = loadFleet();
	const live = fleet.find((entry) => entry.name === "mailflare");
	assert.ok(live, "mailflare is in specs/fleet.json");
	assert.ok(live?.url?.startsWith("https://"), "and carries its origin");
});

test("the subject index says where a person's data is, and what it cannot see", () => {
	const report = { email: "a@b.c", userId: "u1", mailboxIds: ["m1"], counts: [{ table: "messages", rows: 12 }, { table: "contacts", rows: 0 }, { table: "sessions", rows: 2 }] };
	assert.equal(subjectTotal(report), 14, "rows that still exist");
	assert.deepEqual(subjectLines(report), ["      12  messages", "       2  sessions"], "non-empty tables, biggest first");
	assert.equal(new Set(SUBJECT_SCOPE.map((scope) => scope.table)).size, SUBJECT_SCOPE.length, "no duplicate scope entries");
	assert.ok(SUBJECT_SCOPE_INDIRECT.length > 0, "the tables it cannot reach are stated, not implied");
	assert.ok(SUBJECT_SCOPE.some((scope) => scope.userColumns?.includes("target_user_id")), "audit_logs links both ways");
});
