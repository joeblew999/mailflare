// CONFORMANCE: does this system still do what it says? One set of properties, run through the
// same code as every other verb - against real servers (`npm run state -- conform`), and in
// milliseconds against the in-memory store in the unit tests.
//
// A reconciler is right when five things hold, and they are checked in this order:
//   it BUILDS      a server from its folder, and a reset rebuilds it from nothing;
//   it CONVERGES   after an apply, a plan finds nothing to do, and a second apply writes nothing;
//   it FOLLOWS     an edit: add one of every kind of thing, change each, remove each - and
//                  every time the plan says EXACTLY that, no more and no less;
//   it FORGETS     a person declared erased is gone from the server, its bucket and every
//                  backup, the backups still restore, and one that brings them back is found;
//   it LEAVES      a destroy takes it all away, and an apply brings it back.
// Around those, the probes ask the running app and Cloudflare what a plan cannot know.
import { reconcile, resolveInstance, type FleetDeps, type ProjectResult } from "./fleet";
import { digestOf, tombstones } from "./subject-scope";
import { message } from "./wrangler";
import type { Project, SpecEntry } from "./document";
import type { Flags } from "./flags";
import type { Probes } from "./probes";
import type { ChangeAction } from "./resources/resource";
import type { AccountEntry, MailboxEntry, McpKeyEntry, RoutingEntry, Spec } from "./spec";

// --- saying what was found ------------------------------------------------------------

export type Report = {
	section(title: string): void;
	/** One expectation. `detail` is shown only when it does not hold. */
	check(name: string, ok: boolean, detail?: string): boolean;
	/** Something that cannot be proved here, said out loud with the reason. Never a silent pass. */
	skip(name: string, reason: string): void;
	failures(): number;
	skips(): number;
};

export function reporter(print: (line: string) => void = console.log): Report {
	let failed = 0;
	let skipped = 0;
	return {
		section: (title) => print(`\n  ${title}`),
		check(name, ok, detail = "") {
			if (!ok) failed += 1;
			print(`  ${ok ? "✓" : "✗"} ${name}`);
			if (!ok && detail) print(detail.split("\n").map((line) => `      ${line}`).join("\n"));
			return ok;
		},
		skip(name, reason) {
			skipped += 1;
			print(`  – ${name}  (not checked: ${reason})`);
		},
		failures: () => failed,
		skips: () => skipped,
	};
}

// --- one of every kind of thing ---------------------------------------------------------

export const BOX = "zz-conform";
export const USER = "zz-conform-user";
const HOOK = "https://hooks.conform.invalid/zz";
const SYMBOL: Partial<Record<ChangeAction, string>> = { create: "+", update: "~", remove: "-", problem: "!" };

/**
 * The edits of a project's documents, and exactly what a plan must say of each. `erase` writes
 * the person's address under `erased`; `again` keeps only the digest of it, which is what must
 * find them when a backup brings them back.
 */
export type Rounds = Record<"add" | "change" | "empty" | "remove" | "erase" | "again", { entries: SpecEntry[]; expects: string[] }>;

/** What the tenant holds in round `v`: everything a document can say, once. */
function additions(domain: string, v: 1 | 2) {
	const email = `${USER}@${domain}`;
	const mailbox: MailboxEntry = {
		role: BOX, displayName: v === 1 ? "Conform" : "Conform 2", signature: `v${v}`,
		autoReply: { enabled: true, subject: `v${v}`, body: "v1" },
		aliases: ["zz-conform-alias"],
		folders: [{ name: "ZZ", color: v === 1 ? "#2563eb" : "#16a34a" }],
		rules: [{ field: "title", value: "zz-conform", folder: "ZZ", priority: v === 1 ? 0 : 5 }],
		assistant: { enabled: true, instructions: `v${v}`, dailyLimit: 5, reviewer: email },
		access: [{ email, permission: v === 1 ? "read_only" : "full_access" }],
	};
	const account: AccountEntry = {
		username: USER, name: v === 1 ? "Conform User" : "Conform User 2", resetEmail: "zz@conform.example",
		preferences: { timeZone: v === 1 ? "UTC" : "Europe/Berlin", keyboardShortcuts: false },
		mailbox: { signature: "v1", folders: [{ name: "ZZ" }], rules: [{ field: "title", value: "zz-own", folder: "ZZ" }] },
		templates: [{ name: "ZZ", body: `v${v}` }],
		contacts: [{ email: "zz@conform.example", name: `v${v}` }],
		calendar: {
			bookingUsername: "zz-conform",
			bookingPages: [{ name: "ZZ call", slug: "zz-conform", durationMinutes: v === 1 ? 30 : 45, weekdays: [1], startTime: "09:00", endTime: "10:00", timeZone: "UTC" }],
			events: [{ title: "ZZ", startsAt: "2030-01-07T09:00:00Z", endsAt: "2030-01-07T09:30:00Z", location: `v${v}` }],
		},
		drive: { folders: ["ZZ"] },
		apiKeys: [{ name: "zz-conform", scopes: v === 1 ? ["read"] : ["read", "send"] }],
	};
	// The reject rule names an address of its own: a rule matches any recipient that CONTAINS
	// its pattern, so one for "zz-conform" would turn away every mailbox this suite makes.
	const routing: RoutingEntry[] = [{ pattern: "zz-blocked", action: "reject", rejectReason: `v${v}` }, { pattern: "zz-kept", action: "store", mailbox: BOX }];
	const key: McpKeyEntry = { name: "zz-conform", scopes: v === 1 ? ["mcp:read"] : ["mcp:read", "mcp:draft"], mailboxes: [BOX] };
	return { mailbox, account, routing, key };
}

/**
 * Add, change and remove one of every kind of thing, on a project's first tenant and on its
 * instance document. The entries are this suite's own (`zz-conform…`), so it works on any
 * project's documents and disturbs nothing they declare. Null when there is no tenant to use.
 */
export function rounds(project: Project): Rounds | null {
	const tenant = project.entries.find((entry) => entry.spec.domain);
	const instance = project.entries.find((entry) => !entry.spec.domain);
	if (!tenant) return null;
	const spec = tenant.spec;
	const domain = String(spec.domain).trim().toLowerCase();
	const box = `${BOX}@${domain}`;
	const user = `${USER}@${domain}`;
	const admin = instance?.spec.fresh?.admin?.email?.trim().toLowerCase();

	const holding = (v: 1 | 2, edit: (made: ReturnType<typeof additions>) => void = () => {}): Spec => {
		const made = additions(domain, v);
		edit(made);
		return { ...spec, mailboxes: [...(spec.mailboxes ?? []), made.mailbox], accounts: [...(spec.accounts ?? []), made.account], routing: [...(spec.routing ?? []), ...made.routing], mcpKeys: [...(spec.mcpKeys ?? []), made.key] };
	};
	const tenants: Record<keyof Rounds, Spec> = {
		add: holding(1),
		change: holding(2),
		// The entries stay and their lists are emptied: a list that is written is complete.
		empty: holding(2, (made) => {
			Object.assign(made.mailbox, { aliases: [], folders: [], rules: [], access: [] });
			Object.assign(made.account, { mailbox: { signature: "v1", folders: [], rules: [] }, templates: [], apiKeys: [], calendar: { ...made.account.calendar, bookingPages: [] } });
		}),
		// The entries go, and the sections stay written - so what they held is no longer declared.
		remove: { ...spec, mailboxes: spec.mailboxes ?? [], accounts: spec.accounts ?? [], routing: spec.routing ?? [], mcpKeys: spec.mcpKeys ?? [] },
		// Leaving a document only disables an account. Erasing is said: by address, or by its digest.
		erase: { ...spec, erased: [...(spec.erased ?? []), user] },
		again: { ...spec, erased: [...(spec.erased ?? []), digestOf(user)] },
	};
	const named = (entry: SpecEntry, lines: string[]) => lines.map((line) => `${entry.name}: ${line}`);
	const expects: Record<keyof Rounds, string[]> = {
		add: named(tenant, [
			`+ account.${USER}`, `+ mailbox.${box}`, `+ mailbox_access.${BOX}.${user}`,
			`~ mailbox.${box}.signature`, `~ mailbox.${box}.autoReply.enabled`, `~ mailbox.${box}.autoReply.subject`, `~ mailbox.${box}.autoReply.body`,
			`+ alias.${box}.zz-conform-alias`, `+ folder.${box}.ZZ`, `+ rule.${box}.zz-conform`,
			`~ mailbox.${box}.assistant.enabled`, `~ mailbox.${box}.assistant.instructions`, `~ mailbox.${box}.assistant.dailyLimit`, `~ mailbox.${box}.assistant.reviewer`,
			`~ mailbox.${user}.signature`, `+ folder.${user}.ZZ`, `+ rule.${user}.zz-own`,
			"+ routing.zz-blocked.reject", "+ routing.zz-kept.store", "+ mcpKey.zz-conform",
			`~ account.${USER}.resetEmail`, `~ account.${USER}.preferences.timeZone`, `~ account.${USER}.preferences.keyboardShortcuts`, `~ account.${USER}.calendar.bookingUsername`,
			`+ template.${user}.ZZ`, `+ contact.${user}.zz@conform.example`, `+ bookingPage.${user}.zz-conform`, `+ event.${user}.ZZ`, `+ drive.${user}.ZZ`, `+ apiKey.${user}.zz-conform`,
		]),
		change: named(tenant, [
			`~ account.${USER}`, `~ mailbox.${box}`, `~ mailbox_access.${BOX}.${user}`,
			`~ mailbox.${box}.signature`, `~ mailbox.${box}.autoReply.subject`, `~ folder.${box}.ZZ`, `~ rule.${box}.zz-conform`, `~ mailbox.${box}.assistant.instructions`,
			"~ routing.zz-blocked.reject", "~ mcpKey.zz-conform",
			`~ account.${USER}.preferences.timeZone`, `~ template.${user}.ZZ`, `~ contact.${user}.zz@conform.example`, `~ bookingPage.${user}.zz-conform`, `~ event.${user}.ZZ`, `~ apiKey.${user}.zz-conform`,
		]),
		empty: named(tenant, [
			`- mailbox_access.${BOX}.${user}`, `- alias.${box}.zz-conform-alias`, `- folder.${box}.ZZ`, `- rule.${box}.zz-conform`,
			`- folder.${user}.ZZ`, `- rule.${user}.zz-own`, `- template.${user}.ZZ`, `- bookingPage.${user}.zz-conform`, `- apiKey.${user}.zz-conform`,
		]),
		// A key no document names is found by the instance document, which speaks for the whole project.
		remove: [...named(tenant, [`- mailbox.${box}`, `- account.${USER}`, "- routing.zz-blocked.reject", "- routing.zz-kept.store"]), ...(instance ? named(instance, ["- mcpKey.zz-conform"]) : [])],
		erase: named(tenant, [`- erased.${user}`]),
		again: named(tenant, [`- erased.${tombstones({ erased: [digestOf(user)] })[0].label}`]),
	};

	// The instance: a setting changed and put back, and a webhook added, changed and removed.
	// The admin's address is part of a webhook's address, so it has to be written in the document.
	const instances: Partial<Record<keyof Rounds, Spec>> = {};
	if (instance) {
		const original = instance.spec;
		const hook = (v: 1 | 2) => ({ url: HOOK, events: v === 1 ? ["message.inbound" as const] : ["message.inbound" as const, "message.failed" as const], maxAttempts: 1 });
		const holds = (v: 1 | 2): Spec => ({
			...original,
			settings: { ...original.settings, appName: `Conform ${v}` },
			...(admin ? { admin: { ...original.admin, webhooks: [...(original.admin?.webhooks ?? []), hook(v)], contacts: [...(original.admin?.contacts ?? []), { email: "zz@conform.example", name: "ZZ" }] } } : {}),
		});
		const declared = original.settings?.appName;
		Object.assign(instances, {
			add: holds(1),
			change: holds(2),
			empty: holds(2),
			remove: { ...original, settings: { ...original.settings, appName: declared ?? "Conform 2" }, ...(admin ? { admin: { ...original.admin, webhooks: original.admin?.webhooks ?? [] } } : {}) },
		});
		expects.add.push(...named(instance, ["~ settings.appName", ...(admin ? [`+ webhook.${admin}.${HOOK}`, `+ contact.${admin}.zz@conform.example`] : [])]));
		expects.change.push(...named(instance, ["~ settings.appName", ...(admin ? [`~ webhook.${admin}.${HOOK}`] : [])]));
		expects.remove.push(...named(instance, [...(declared ? ["~ settings.appName"] : []), ...(admin ? [`- webhook.${admin}.${HOOK}`] : [])]));
	}

	const round = (name: keyof Rounds) => ({
		entries: project.entries.map((entry) => (entry === tenant ? { ...entry, spec: tenants[name] } : entry === instance && instances[name] ? { ...entry, spec: instances[name]! } : entry)),
		expects: expects[name].sort(),
	});
	return { add: round("add"), change: round("change"), empty: round("empty"), remove: round("remove"), erase: round("erase"), again: round("again") };
}

// --- the properties ---------------------------------------------------------------------

export type ConformOptions = {
	concurrency: number;
	/** Skip the destroy and the rebuild: every server is left standing, as the documents say. */
	quick: boolean;
	/** The projects, read again: a deploy writes an origin into a server's document, a destroy takes it out. */
	load(): Project[];
	/** What to ask the running app and Cloudflare. Absent, only the plans are checked. */
	probes?: Probes;
};

const BASE: Flags = { status: false, cleanup: false, fresh: false, confirmMx: false, confirmDestroy: false, rotatePasswords: false, db: "mailflare", local: false };
const isWork = (action: ChangeAction) => action === "create" || action === "update" || action === "remove" || action === "problem";

export async function conform(options: ConformOptions, deps: FleetDeps, report: Report = reporter(deps.print)): Promise<number> {
	let projects = options.load();
	// It wipes what it runs on. A server says it may be wiped; nothing else is touched.
	const precious = projects.filter((project) => !project.server?.disposable && !project.server?.local);
	if (precious.length > 0 || projects.length === 0) {
		deps.print(projects.length === 0 ? "No servers to conform." : `Conformance resets what it runs on, so it only runs on servers that say they are disposable. Not: ${precious.map((project) => project.name).join(", ")}.`);
		return 1;
	}

	// Each step runs quietly; what it printed is shown only when a check on it fails.
	const transcript: string[] = [];
	const quiet: FleetDeps = { ...deps, print: (text) => void transcript.push(text) };
	const go = async (flags: Partial<Flags>, target: Project[] = projects): Promise<ProjectResult[]> => {
		transcript.length = 0;
		return reconcile(target, { flags: { ...BASE, ...flags }, concurrency: options.concurrency, explicit: { url: false, db: false } }, quiet).catch((error) => [{ name: "the run", documents: [], error: message(error) }]);
	};
	const said = () => transcript.join("\n").split("\n").slice(-30).join("\n");
	const documents = (results: ProjectResult[]) => results.flatMap((result) => result.documents);
	const allOk = (results: ProjectResult[]) => results.every((result) => !result.error && !result.server) && documents(results).every((document) => document.ok);
	/** What a run saw to do (a plan) or did (an apply): `document: + address`, sorted. */
	const work = (results: ProjectResult[]) => [...results.filter((result) => result.error).map((result) => `${result.name}: ! ${result.error}`), ...results.filter((result) => result.server).map((result) => `${result.name}: ~ server (${result.server})`), ...documents(results).flatMap((document) => (document.changes ?? []).filter((change) => isWork(change.action)).map((change) => `${document.name}: ${SYMBOL[change.action]} ${change.address}`))].sort();
	const exactly = (name: string, results: ProjectResult[], expected: string[]) => {
		const found = work(results);
		const missing = expected.filter((line) => !found.includes(line));
		const extra = found.filter((line) => !expected.includes(line));
		return report.check(name, missing.length === 0 && extra.length === 0, [...missing.map((line) => `missing     ${line}`), ...extra.map((line) => `unexpected  ${line}`)].join("\n") || said());
	};
	const finish = () => {
		deps.print(report.failures() === 0 ? `\nconformance OK${report.skips() > 0 ? ` — ${report.skips()} thing(s) not checked, each named above` : ""}.` : `\n${report.failures()} check(s) failed.`);
		return report.failures() === 0 ? 0 : 1;
	};
	const edited = (name: keyof Rounds) => {
		const made = projects.map((project) => ({ project, round: rounds(project)?.[name] }));
		return { target: made.map(({ project, round }) => (round ? { ...project, entries: round.entries } : project)), expects: made.flatMap(({ round }) => round?.expects ?? []).sort() };
	};

	report.section(`build (${projects.map((project) => project.name).join(", ")})`);
	// A server that is already there runs whatever was last rolled out to it, and an apply does
	// not change that. Conformance is of THIS code, so it goes out first.
	const standing = projects.filter((project) => project.server?.url && !project.server.local);
	transcript.length = 0;
	let rolled = 0;
	for (const project of standing) {
		const { deployment } = resolveInstance(project, { flags: BASE, concurrency: 1, explicit: { url: false, db: false } }, deps.template());
		if (deployment && (await deps.deploy(project.server!, deployment, { base: project.dir, dryRun: false, print: quiet.print, template: deps.template() }).catch(() => null))) rolled += 1;
	}
	if (standing.length > 0 && !report.check(`the current code is rolled out to the servers already standing (${standing.length})`, rolled === standing.length, said())) return finish();
	if (!report.check("apply: every server exists, with its documents applied", allOk(await go({})), said())) return finish();
	projects = options.load();
	const preview = await go({ fresh: true, status: true });
	report.check("unconfirmed, a reset is a preview and wipes nothing", !allOk(preview) && documents(preview).every((document) => document.pending), said());
	if (!report.check("reset: wiped, given its admin, and rebuilt from the documents", allOk(await go({ fresh: true, confirmDestroy: true })), said())) return finish();
	if (options.probes) for (const project of projects) await options.probes.where(project, deps, report);

	report.section("converge");
	exactly("plan: nothing to do", await go({ status: true }), []);
	const again = await go({});
	report.check("apply again: nothing is written", allOk(again) && work(again).length === 0, work(again).join("\n") || said());

	report.section("add, change, remove (one of every kind of thing; the plan must say exactly that)");
	const add = edited("add");
	exactly("add: the plan is the additions, and nothing else", await go({ status: true }, add.target), add.expects);
	report.check("add: applied", allOk(await go({}, add.target)), said());
	if (options.probes) for (const project of projects) await options.probes.afterAdd(project, deps, report);

	const change = edited("change");
	exactly("change: the plan is the changes, and nothing else", await go({ status: true }, change.target), change.expects);
	report.check("change: applied in place", allOk(await go({}, change.target)), said());

	const empty = edited("empty");
	exactly("remove from a list: the plan is the removals, and nothing else", await go({ status: true }, empty.target), empty.expects);
	const held = await go({}, empty.target);
	report.check("removing waits for approval: an apply leaves it all in place", !allOk(held) && documents(held).some((document) => document.pending) && !work(held).some((line) => line.includes(": - ")), said());
	exactly("so the plan is unchanged", await go({ status: true }, empty.target), empty.expects);
	report.check("remove from a list: applied, once approved", allOk(await go({ confirmDestroy: true }, empty.target)), said());

	const remove = edited("remove");
	exactly("remove an entry: the plan is the removals, and nothing else", await go({ status: true }, remove.target), remove.expects);
	report.check("remove an entry: applied", allOk(await go({ confirmDestroy: true }, remove.target)), said());
	if (options.probes) for (const project of projects) await options.probes.afterRemove(project, deps, report);
	exactly("and the original documents find nothing to do", await go({ status: true }), []);

	// Leaving the documents disabled the person and kept everything of theirs. A takedown is said.
	if (options.probes) for (const project of projects) await options.probes.beforeErase(project, deps, report);
	report.section("takedown (a person is declared erased; the plan must say exactly that)");
	const erase = edited("erase");
	exactly("declared erased: the plan is that person, and nothing else", await go({ status: true }, erase.target), erase.expects);
	const waits = await go({}, erase.target);
	report.check("erasing waits for approval: an apply leaves them in place", !allOk(waits) && documents(waits).some((document) => document.pending) && !work(waits).some((line) => line.includes(": - ")), said());
	report.check("erased, once approved", allOk(await go({ confirmDestroy: true }, erase.target)), said());
	exactly("and the plan finds nothing more to do", await go({ status: true }, erase.target), []);
	if (options.probes) {
		for (const project of projects) await options.probes.afterErase(project, deps, report);
		exactly("the restored server is as its documents say, without them", await go({ status: true }, erase.target), []);
		// A backup this system never reached - a copy on someone's laptop - would bring them back.
		// The tombstone is what catches it, and it needs no more than the digest of their address.
		for (const project of projects) await options.probes.restoreCopy(project, deps, report);
		const again = edited("again");
		exactly("the plan says they are back, from the digest alone", await go({ status: true }, again.target), again.expects);
		report.check("and they are erased again", allOk(await go({ confirmDestroy: true }, again.target)), said());
		exactly("after which there is nothing to do", await go({ status: true }, again.target), []);
		for (const project of projects) await options.probes.logins(project, deps, report);
		await options.probes.fleet(projects, deps, report);
		// Asked last: a server that was just redeployed is not placed in its country at once.
		report.section("where each server answers from");
		for (const project of projects) await options.probes.placed(project, deps, report);
	}

	if (options.quick) report.skip("destroy, and building again", "--quick leaves every server standing");
	else {
		report.section("destroy, and back from nothing");
		const dry = await go({ cleanup: true, status: true });
		report.check("unconfirmed, a destroy is a preview", !allOk(dry) && documents(dry).some((document) => (document.changes ?? []).some((made) => made.action === "remove")), said());
		exactly("and removes nothing", await go({ status: true }), []);
		const origins = projects.map((project) => project.server?.url);
		report.check("destroy: everything declared, then the server itself", allOk(await go({ cleanup: true, confirmDestroy: true })), said());
		if (options.probes) for (const [index, project] of projects.entries()) await options.probes.gone(project, origins[index], report);
		projects = options.load();
		report.check("plan: it is all to do again", !allOk(await go({ status: true })), said());
		report.check("apply: built again from its folder", allOk(await go({})), said());
		projects = options.load();
		exactly("plan: nothing to do", await go({ status: true }), []);
	}
	options.probes?.notChecked(report);
	return finish();
}

/**
 * VERIFY: the live fleet, read-only. What a plan cannot say about servers people use - that the
 * logins written down still sign in, that the data is where the documents say, that the latest
 * backup completed, that nobody declared erased is on a server or in a backup of it, and that
 * the front door sends each domain home. It changes nothing.
 */
export async function verify(projects: Project[], concurrency: number, deps: FleetDeps, probes: Probes, report: Report = reporter(deps.print)): Promise<number> {
	const transcript: string[] = [];
	report.section("the documents");
	const results = await reconcile(projects, { flags: { ...BASE, status: true }, concurrency, explicit: { url: false, db: false } }, { ...deps, print: (text) => void transcript.push(text) });
	const reconciled = results.every((result) => !result.error && !result.server && result.documents.every((document) => document.ok));
	report.check(`plan: every document on every server is reconciled (${results.reduce((sum, result) => sum + result.documents.length, 0)} on ${results.length})`, reconciled, transcript.join("\n").split("\n").slice(-40).join("\n"));
	for (const project of projects) {
		await probes.where(project, deps, report);
		await probes.placed(project, deps, report);
		await probes.logins(project, deps, report);
		await probes.backups(project, deps, report);
		await probes.forgotten(project, deps, report);
	}
	await probes.frontDoor(projects, deps, report);
	deps.print(report.failures() === 0 ? "\nverified." : `\n${report.failures()} check(s) failed.`);
	return report.failures() === 0 ? 0 : 1;
}
