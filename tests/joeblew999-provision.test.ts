// Drives the whole provisioner through the Store seam, so a full run is exercised
// with no D1, no Workers binding and no network. Run with `npm run joeblew999:test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeContext } from "../scripts/joeblew999-provision/context";
import { run } from "../scripts/joeblew999-provision/commands";
import { runBatch } from "../scripts/joeblew999-provision/batch";
import type { Flags, ProjectManifest, Role } from "../scripts/joeblew999-provision/types";
import type { Store } from "../scripts/joeblew999-provision/store-types";

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
	share: false, disableAccounts: false, removeDomain: false, db: "test", local: false, ...over,
});

const roles = (...entries: Array<Partial<Role> & { role: string }>): Role[] =>
	entries.map((entry) => ({ displayName: entry.role, share: false, access: [], ...entry }));

const projectFor = (domain: string, over: Partial<ProjectManifest> = {}): ProjectManifest => ({ domain, ...over });

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

const runOn = (store: Store, f: Flags, project: ProjectManifest, r: Role[]) =>
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

test("onboards a missing domain, then provisions into it", async () => {
	const { store, calls } = fakeStore();
	const code = await runOn(store, flags({ onboard: true }), projectFor("fresh.example"), roles({ role: "office" }));
	assert.equal(code, 0);
	assert.ok(calls.includes("onboardDomain"), "domain onboarded");
	assert.ok(calls.includes("createMailbox:office"), "provisioned after onboarding");
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
		{ name: "a.example", project: projectFor("a.example", { mailboxes: [{ role: "office" }] }) },
		{ name: "b.example", project: projectFor("b.example", { mailboxes: [{ role: "hello" }] }) },
	];
	const code = await quiet(() => runBatch(store, flags(), { roles: "" }, entries));
	assert.equal(code, 0);
	assert.ok(calls.includes("createMailbox:office") && calls.includes("createMailbox:hello"), "both projects provisioned");
});

test("mass mode keeps going and reports failure per project", async () => {
	const { store } = fakeStore({ domains: [{ id: "d1", hostname: "ok.example" }] });
	const entries = [
		{ name: "ok.example", project: projectFor("ok.example", { mailboxes: [{ role: "office" }] }) },
		{ name: "broken", project: { mailboxes: [{ role: "x" }] } },
	];
	const code = await quiet(() => runBatch(store, flags(), { roles: "" }, entries));
	assert.equal(code, 1, "one bad project fails the run");
});
