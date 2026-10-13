// What a plan cannot know: that a login written down signs in, that the app SHOWS a person
// what their document said, that mail arrives, that the data is where Cloudflare says it is.
// These ask the running app and Cloudflare directly, so they only make sense on a real server.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dangling, holds, parseBackup } from "./backup";
import { COLOS_FILE, answeredFrom } from "./colos";
import { BOX, USER, type Report } from "./conform";
import { bucketIsThere, databasePlace, setPlacement, workerSettings } from "./deploy";
import { resolveInstance, type FleetDeps } from "./fleet";
import { backupKeys } from "./resources/erased";
import { fleetMap, router, type FleetMap } from "./router";
import { digestOf, subjectTotal, tombstones } from "./subject-scope";
import { cfApi, credential, sleep, workersDevUrl, wrangler } from "./wrangler";
import type { Project } from "./document";
import type { Flags } from "./flags";
import { PLACEMENTS } from "./spec";

export type Probes = {
	/** Is the data where the server's document says, and does the server hold only what it should? */
	where(project: Project, deps: FleetDeps, report: Report): Promise<void>;
	/** Does the server answer from the country it declares - as a fact, whatever its settings say? */
	placed(project: Project, deps: FleetDeps, report: Report): Promise<void>;
	/** Put a server in another country, as Cloudflare does when it stops honouring a placement. True when it was. */
	displace(project: Project, deps: FleetDeps, report: Report): Promise<boolean>;
	/** Every login on record signs in. */
	logins(project: Project, deps: FleetDeps, report: Report): Promise<void>;
	/** With one of everything added: the app shows it, the keys open it, mail reaches it. */
	afterAdd(project: Project, deps: FleetDeps, report: Report): Promise<void>;
	/** A mailbox that was removed took its mail with it: from the database, and from the bucket. */
	afterRemove(project: Project, deps: FleetDeps, report: Report): Promise<void>;
	/** Before a takedown: leaving the documents only disabled them, and a backup taken now holds them. */
	beforeErase(project: Project, deps: FleetDeps, report: Report): Promise<void>;
	/** After it: nothing of theirs in the database, the bucket or any backup - and the backups still restore. */
	afterErase(project: Project, deps: FleetDeps, report: Report): Promise<void>;
	/** Restore the copy kept from before: what a backup this system could not reach would do. */
	restoreCopy(project: Project, deps: FleetDeps, report: Report): Promise<void>;
	/** Read-only: the server's latest backup completed, and is not old. */
	backups(project: Project, deps: FleetDeps, report: Report): Promise<void>;
	/** Read-only: nobody a document declares erased is on the server, or in any of its backups. */
	forgotten(project: Project, deps: FleetDeps, report: Report): Promise<void>;
	/** A front door for these servers alone: deployed, asked, removed. */
	fleet(projects: Project[], deps: FleetDeps, report: Report): Promise<void>;
	/** The fleet's own front door sends each domain to the server its document is on. */
	frontDoor(projects: Project[], deps: FleetDeps, report: Report): Promise<void>;
	/** A destroyed server no longer answers. */
	gone(project: Project, origin: string | undefined, report: Report): Promise<void>;
	notChecked(report: Report): void;
};

const FLAGS: Flags = { status: false, cleanup: false, fresh: false, confirmMx: false, confirmDestroy: false, rotatePasswords: false, db: "mailflare", local: false };
const RUN = { flags: FLAGS, concurrency: 1, explicit: { url: false, db: false } };

// Tried twice: a long step may have let the server drop the idle connection.
const twice = async <T>(send: () => Promise<T>): Promise<T | null> => (await send().catch(() => null)) ?? (await send().catch(() => null));
const status = (url: string, init: RequestInit = {}) => fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000), ...init }).then((response) => response.status, () => 0);
/** Ask for a status and hold it to what is expected. No answer at all is asked once more: that is the network, not the server. */
async function answers(report: Report, name: string, ask: () => Promise<number>, ...expected: number[]): Promise<boolean> {
	let got = await ask();
	if (got === 0) got = await ask();
	return report.check(name, expected.includes(got), got === 0 ? "no answer" : `HTTP ${got}`);
}

/** Sign in, and return the session cookie - or null when the app refuses. */
async function signIn(origin: string, email: string, password: string | null): Promise<string | null> {
	const response = await twice(() => fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ email, password }) }));
	if (response?.status !== 200) return null;
	return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
}
async function read(origin: string, cookie: string | null, path: string): Promise<{ status: number; text: string }> {
	const response = await twice(() => fetch(`${origin}${path}`, { headers: { Cookie: cookie ?? "" }, redirect: "manual" }));
	return { status: response?.status ?? 0, text: response ? await response.text() : "no answer" };
}

// What a takedown is checked against afterwards: taken while the person was still there.
type Before = { password: string | null; objectKeys: string[]; backupKey: string | null; copy: string | null };
const before = new Map<string, Before>();
/** The mail delivered to the mailbox conformance later removes: what must be gone once it has. */
const delivered = new Map<string, { subjects: string[]; keys: string[] }>();
const failed = (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) });
/** How old a backup may be before it says the schedule has stopped, in days. */
const STALE: Record<string, number> = { daily: 2, weekly: 8, monthly: 32 };

/**
 * Do something to a server while it is being used: requests keep arriving until it is done.
 * A restore is many statements, and one that only works on an idle server is not a restore.
 */
async function whileUsed<T>(origin: string, work: () => Promise<T>): Promise<T> {
	let busy = true;
	const traffic = (async () => {
		while (busy) {
			await status(`${origin}/login`);
			await sleep(150);
		}
	})();
	try {
		return await work();
	} finally {
		busy = false;
		await traffic;
	}
}

const tenantOf = (project: Project) => String(project.entries.find((entry) => entry.spec.domain)?.spec.domain ?? "").trim().toLowerCase();
const adminOf = (project: Project) => project.entries.find((entry) => !entry.spec.domain)?.spec.fresh?.admin?.email?.trim().toLowerCase() ?? null;

/** Where a server answers from, asked for up to a minute until it is its home. */
async function settlesIn(url: string, home: string): Promise<{ colo: string | null; country: string | null }> {
	let seen = await answeredFrom(url);
	for (let attempt = 1; attempt < 15 && seen.country !== home; attempt += 1) {
		await sleep(4000);
		seen = await answeredFrom(url);
	}
	return seen;
}

/** For someone new, the router suggests the server their country is at home on - one country per server is asked. */
async function homes(url: string | null, map: FleetMap, report: Report): Promise<void> {
	const asked = new Set<string>();
	for (const [country, server] of Object.entries(map.countries)) {
		if (asked.has(server)) continue;
		asked.add(server);
		const home = await fetch(`${url}/.well-known/mailflare-home?country=${country}`).then((response) => response.json() as Promise<{ server?: string; suggested?: boolean }>, () => ({} as { server?: string; suggested?: boolean }));
		report.check(`someone new from ${country.toUpperCase()} is suggested ${server}`, home.server === server && home.suggested === true, JSON.stringify(home));
	}
}

export const liveProbes: Probes = {
	async where(project, deps, report) {
		const server = project.server;
		const { instance, deployment } = resolveInstance(project, RUN, deps.template());
		report.section(`where its data is (${project.name})`);
		if (!server || !deployment || instance.local) return report.skip("jurisdiction", "a local server keeps its data on this machine");
		const database = await databasePlace(deployment).catch(failed);
		report.check(`the database is ${server.jurisdiction ? `in jurisdiction ${server.jurisdiction}` : "not pinned, as declared"}`, !("error" in database) && database.jurisdiction === (server.jurisdiction ?? null), "error" in database ? database.error : `Cloudflare says: ${database.jurisdiction ?? "not pinned"}`);
		const bucket = await bucketIsThere(deployment).catch(failed);
		report.check(`the bucket is ${server.jurisdiction ? `in jurisdiction ${server.jurisdiction}` : "there"}`, bucket === true, typeof bucket === "object" ? bucket.error : `no ${deployment.bucket}${server.jurisdiction ? ` in jurisdiction ${server.jurisdiction}` : ""}`);

		const settings = await workerSettings(deployment.worker);
		if (!settings) return report.skip("what the Worker is told and holds", "needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID");
		const { vars: said2, secrets } = settings;
		// The default server is wrangler.jsonc as it stands; every other is told who and where it is.
		if (deployment.generated) report.check("the Worker is told its own name and jurisdiction", said2.MAILFLARE_WORKER_NAME === deployment.worker && (said2.MAILFLARE_JURISDICTION ?? null) === (server.jurisdiction ?? null), JSON.stringify(said2));
		if (deployment.placements.length > 0) report.check(`the Worker is placed beside ${settings.placement ?? "nothing"}${server.country ? `, one of the names for ${server.country.toUpperCase()}` : ""}`, !!settings.placement && deployment.placements.includes(settings.placement), `its document allows: ${deployment.placements.join(", ")}`);
		if (server.managesDns === false) {
			report.check("it holds no Cloudflare token, so it can touch no zone", !secrets.includes("CF_TOKEN"), secrets.join(", "));
			const domains = await deps.openStore(instance, (store) => store.listDomains()).catch(() => []);
			report.check("its domains are recorded by hand, not provisioned", domains.every((domain) => domain.zoneId === "manual"), domains.map((domain) => `${domain.hostname}: ${domain.zoneId}`).join(", "));
		}
	},

	async placed(project, deps, report) {
		const server = project.server;
		const { instance, deployment } = resolveInstance(project, RUN, deps.template());
		if (!server?.country || !deployment?.placement || !instance.url || instance.local) return;
		const home = server.country.toLowerCase();
		const name = `${project.name}: it answers from ${home.toUpperCase()}`;
		const { colo, country } = await settlesIn(instance.url, home);
		if (country === home) return void report.check(`${name} (the data center ${colo})`, true);
		// A setting is not a fact: a placement is a hint, and this is what Cloudflare did with it.
		report.check(name, false, !colo ? "the answer named no data center (no cf-placement header): Cloudflare is not placing this Worker, so it runs wherever a request arrives" : country ? `it answered from ${colo}, which is in ${country.toUpperCase()}` : `it answered from ${colo}, which ${COLOS_FILE} does not list — \`npm run state -- colos\` pulls the list again`);
	},

	async displace(project, deps, report) {
		const server = project.server;
		const { instance, deployment } = resolveInstance(project, RUN, deps.template());
		if (!server?.country || !deployment || deployment.placements.length < 2 || !instance.url || instance.local) return false;
		const home = server.country.toLowerCase();
		// Somewhere that is certainly not home: another country's first name.
		const abroad = Object.entries(PLACEMENTS).find(([country]) => country !== home && (home === "de" ? country === "gb" : country === "de"))?.[1][0];
		if (!abroad) return false;
		const moved = await setPlacement(deployment.worker, abroad).then(() => true, failed);
		// It goes on answering from home for a few seconds; it is away once it stops.
		let seen = await answeredFrom(instance.url);
		for (let attempt = 0; moved === true && attempt < 30 && seen.country === home; attempt += 1) {
			await sleep(1000);
			seen = await answeredFrom(instance.url);
		}
		return report.check(`${project.name}: put beside ${abroad}, and it no longer answers from ${home.toUpperCase()}`, moved === true && seen.country !== home, typeof moved === "object" ? moved.error : `it still answers from ${seen.colo}`);
	},

	async logins(project, deps, report) {
		const { instance } = resolveInstance(project, RUN, deps.template());
		const logins = deps.vault(project.server?.name ?? "documents").logins();
		const origin = instance.url;
		if (!origin) return report.skip(`${project.name}: logins`, "the server has no origin");
		let signedIn = 0;
		for (const login of logins) if (await signIn(origin, login.email, login.password)) signedIn += 1;
		report.check(`${project.name}: every login on record signs in (${logins.length})`, logins.length > 0 && signedIn === logins.length, `${signedIn} of ${logins.length} signed in`);
	},

	async afterAdd(project, deps, report) {
		const { instance, deployment } = resolveInstance(project, RUN, deps.template());
		const origin = instance.url;
		const domain = tenantOf(project);
		if (!origin || !domain) return;
		const vault = deps.vault(project.server?.name ?? "documents");
		const email = `${USER}@${domain}`;
		const admin = adminOf(project);
		const cookie = await signIn(origin, email, vault.password(email));
		const boss = admin ? await signIn(origin, admin, vault.password(admin)) : null;
		const shows = async (name: string, who: string | null, path: string, has: string[]) => {
			const answer = await read(origin, who, path);
			report.check(name, answer.status === 200 && has.every((text) => answer.text.includes(text)), `HTTP ${answer.status}${has.filter((text) => !answer.text.includes(text)).map((text) => `; missing "${text}"`).join("")}\n${answer.text.slice(0, 300)}`);
		};

		report.section(`the app, asked as the people in it (${project.name})`);
		report.check("an account's generated login signs in", !!cookie, `no session for ${email}`);
		if (admin) report.check("the primary admin's login signs in", !!boss, `no session for ${admin}`);
		const boxes = await deps.openStore(instance, (store) => store.listMailboxes());
		const idOf = (role: string) => boxes.find((box) => box.localPart === role && String(box.hostname).toLowerCase() === domain)?.id;
		const [own, shared] = [idOf(USER), idOf(BOX)];
		await shows("mailboxes, with a signature", cookie, "/api/mailboxes", [USER, '"v1"']);
		await shows("mail folders", cookie, `/api/folders?mailboxId=${own}`, ["ZZ"]);
		await shows("inbox rules", cookie, `/api/routing-rules?mailboxId=${own}`, ["zz-own"]);
		await shows("templates", cookie, "/api/templates", ["ZZ"]);
		await shows("contacts", cookie, `/api/contacts?mailboxId=${own}&address=${encodeURIComponent("zz@conform.example")}`, ['"v1"']);
		await shows("booking pages, under the booking username", cookie, "/api/booking", ["zz-conform", "ZZ call"]);
		await answers(report, "the public booking page is served", () => status(`${origin}/book/zz-conform/zz-conform`), 200);
		await shows("calendar events", cookie, "/api/calendar/events?start=2030-01-01T00:00:00Z&end=2030-01-31T00:00:00Z", ['"ZZ"']);
		await shows("drive folders", cookie, "/api/drive/items", ['"ZZ"']);
		await shows("API keys", cookie, "/api/api-keys", ["zz-conform"]);
		if (boss) {
			await shows("the assistant, for a mailbox", boss, `/api/agent/settings?mailboxId=${shared}`, ["v1"]);
			await shows("webhooks, which are the primary admin's", boss, "/api/webhooks", ["hooks.conform.invalid"]);
		}

		report.section(`keys and realtime (${project.name})`);
		const withKey = (path: string, key: string | null, init: RequestInit = {}) => status(`${origin}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${key}` } });
		await answers(report, "a personal API key reads mail", () => withKey("/api/v1/messages", vault.secret("apiKeys", `${email}/zz-conform`)), 200);
		await answers(report, "a made-up key is refused", () => withKey("/api/v1/messages", "ep_not_a_key"), 401);
		const initialize = { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "conformance", version: "1" } } }) };
		await answers(report, "an MCP key opens the MCP endpoint", () => withKey("/mcp", vault.secret("mcpKeys", "zz-conform"), initialize), 200);
		await answers(report, "the MCP endpoint refuses a made-up key", () => withKey("/mcp", "ep_not_a_key", initialize), 401, 403);
		const opened = await new Promise<string>((done) => {
			// Node's WebSocket takes headers as a second argument; the type it is given does not say so.
			const socket = new (WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket)(`${origin.replace(/^http/, "ws")}/api/realtime`, { headers: { Cookie: cookie ?? "", Origin: origin } });
			const timer = setTimeout(() => done("timed out"), 20_000);
			socket.addEventListener("open", () => (clearTimeout(timer), socket.close(), done("open")));
			socket.addEventListener("error", () => (clearTimeout(timer), done("refused")));
		});
		report.check(`a signed-in person's realtime connection opens${instance.jurisdiction ? `, on Durable Objects pinned to ${instance.jurisdiction}` : ""}`, opened === "open", opened);

		// Mail is put where Email Routing would put it - the raw message in the bucket, a job on
		// the inbound queue - so everything after that hop runs for real: address resolution,
		// aliases, domain rules, parsing, inbox rules and webhooks.
		report.section(`mail, through the real pipeline (${project.name})`);
		const token = credential("CLOUDFLARE_API_TOKEN");
		const account = credential("CLOUDFLARE_ACCOUNT_ID");
		const queue = deployment?.queues.find((name) => name.endsWith("-inbound"));
		if (instance.local || !deployment || !token || !account || !queue || !instance.bucket) return report.skip("delivery", instance.local ? "a local server has no queue to hand mail to" : "needs the Cloudflare API to reach the server's bucket and queue");
		const queues = (await cfApi<Array<{ queue_name: string; queue_id: string }>>(`/accounts/${account}/queues?per_page=100`, token))?.result ?? [];
		const queueId = queues.find((entry) => entry.queue_name === queue)?.queue_id;
		const run = `conform-${Date.now().toString(36)}`;
		const mail = [
			{ to: `${BOX}@${domain}`, subject: `${run} direct`, box: shared, folder: null as string | null, proves: "mail to a mailbox arrives in it" },
			{ to: `zz-conform-alias@${domain}`, subject: `${run} via alias`, box: shared, folder: null, proves: "mail to an alias arrives in the mailbox it names" },
			{ to: `${BOX}@${domain}`, subject: `${run} zz-conform filed`, box: shared, folder: "ZZ", proves: "an inbox rule files mail into its folder" },
			{ to: `zz-kept@${domain}`, subject: `${run} kept`, box: shared, folder: null, proves: "a domain rule stores mail for an address nobody has" },
			{ to: email, subject: `${run} zz-own`, box: own, folder: "ZZ", proves: "a person's own rule files their mail" },
		];
		// One more, for an address a reject rule names: it must be turned away, so it is not waited for.
		const blocked = { to: `zz-blocked@${domain}`, subject: `${run} blocked` };
		const dir = mkdtempSync(join(tmpdir(), "state-conform-"));
		let queued = 0;
		for (const [index, message] of [...mail, blocked].entries()) {
			const key = `inbound/${run}-${index}.eml`;
			const file = join(dir, `${index}.eml`);
			writeFileSync(file, ["From: Tester <tester@elsewhere.test>", `To: ${message.to}`, `Subject: ${message.subject}`, `Message-ID: <${run}-${index}@elsewhere.test>`, `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "Sent by the conformance suite.", ""].join("\r\n"));
			const put = await wrangler(["r2", "object", "put", `${instance.bucket}/${key}`, "--file", file, "--content-type", "message/rfc822", "--remote", ...(instance.jurisdiction ? ["--jurisdiction", instance.jurisdiction] : [])], { config: deployment.config });
			const pushed = await cfApi(`/accounts/${account}/queues/${queueId}/messages`, token, { method: "POST", body: JSON.stringify({ body: { from: "tester@elsewhere.test", to: message.to, rawR2Key: key, headers: { subject: message.subject } }, content_type: "json" }) });
			if (put.status === 0 && pushed) queued += 1;
		}
		rmSync(dir, { recursive: true, force: true });
		if (!report.check(`${mail.length + 1} messages are handed to the server`, queued === mail.length + 1, `${queued} queued, on ${queue} (${queueId})`)) return;
		const kept = mail.map((message, index) => ({ ...message, key: `inbound/${run}-${index}.eml` })).filter((message) => message.box === shared);
		delivered.set(project.name, { subjects: kept.map((message) => message.subject), keys: kept.map((message) => message.key) });
		const arrived = await deps.openStore(instance, async (store) => {
			let rows: Array<Record<string, unknown>> = [];
			for (let attempt = 0; attempt < 30 && rows.length < mail.length; attempt += 1) {
				await sleep(4000);
				rows = (await Promise.all(mail.map((message) => store.rows("messages", { subject: message.subject })))).flat();
			}
			const folders = [...(await store.rows("folders", { mailbox_id: String(shared) })), ...(await store.rows("folders", { mailbox_id: String(own) }))];
			let attempts = 0;
			for (let attempt = 0; attempt < 10 && attempts === 0; attempt += 1) {
				attempts = (await store.rows("webhook_deliveries", {})).length;
				if (attempts === 0) await sleep(4000);
			}
			return { rows, folders, attempts, turnedAway: (await store.rows("messages", { subject: blocked.subject })).length === 0, leftBehind: await store.readObject(`inbound/${run}-${mail.length}.eml`) };
		});
		for (const message of mail) {
			const row = arrived.rows.find((entry) => entry.subject === message.subject);
			const folder = arrived.folders.find((entry) => entry.id === row?.folder_id)?.name ?? null;
			report.check(message.proves, row?.mailbox_id === message.box && folder === message.folder, row ? `mailbox ${row.mailbox_id}, folder ${folder}` : "never arrived");
		}
		report.check("a reject rule turns mail away", arrived.turnedAway, "it was stored");
		report.check("and mail that is stored for nobody leaves nothing in the bucket", arrived.leftBehind === null, "the raw message is still there, with no row pointing at it");
		await shows("and the app shows the person their mail", cookie, `/api/messages?mailboxId=${own}`, [`${run} zz-own`]);
		if (admin) report.check("the admin's webhook was called for mail in the admin's mailbox", arrived.attempts > 0, "no delivery attempt recorded");
	},

	async afterRemove(project, deps, report) {
		const { instance } = resolveInstance(project, RUN, deps.template());
		const sent = delivered.get(project.name);
		if (!sent) return;
		const left = await deps.openStore(instance, async (store) => ({
			rows: (await Promise.all(sent.subjects.map((subject) => store.rows("messages", { subject })))).flat().length,
			objects: (await Promise.all(sent.keys.map((key) => store.readObject(key)))).filter((content) => content !== null).length,
		})).catch(failed);
		report.check(`${project.name}: a removed mailbox took its mail with it, from the database and the bucket (${sent.subjects.length} messages)`, !("error" in left) && left.rows === 0 && left.objects === 0, "error" in left ? left.error : `${left.rows} row(s) and ${left.objects} object(s) left behind`);
	},

	async beforeErase(project, deps, report) {
		const { instance } = resolveInstance(project, RUN, deps.template());
		const domain = tenantOf(project);
		if (!instance.url || !domain) return;
		const email = `${USER}@${domain}`;
		report.section(`before a takedown (${project.name})`);
		const found = await deps.openStore(instance, async (store) => {
			const person = await store.subjectReport(email);
			const admin = adminOf(project);
			const blocked = admin ? (await store.subjectReport(admin)).blockers : null;
			const objectKeys = person.userId ? (await store.rows("messages", { user_id: person.userId })).map((row) => row.raw_r2_key).filter((key) => key !== null && key !== undefined).map(String) : [];
			const [backup] = await store.rows("backups", { id: await store.takeBackup() });
			const backupKey = backup?.r2_key ? String(backup.r2_key) : null;
			return { person, blocked, objectKeys, backup, backupKey, copy: backupKey ? await store.readObject(backupKey) : null };
		}).catch(failed);
		if ("error" in found) return void report.check("a backup is taken, and completes", false, found.error);
		report.check("leaving the documents only disabled them: their account, mail and files are all still here", !!found.person.userId && subjectTotal(found.person) > 0, JSON.stringify(found.person.counts));
		if (found.blocked) report.check("the admin who owns the domains cannot be erased", found.blocked.length > 0, "nothing stands in the way of erasing the admin");
		report.check("a backup is taken, and completes", found.backup?.status === "completed" && !!found.copy, `status ${found.backup?.status}: ${found.backup?.error ?? "no object"}`);
		const document = parseBackup(found.copy ?? "");
		report.check("and it holds them, as every backup taken before a takedown does", !!document && holds(document, [digestOf(email)]).length === 1, document ? "the backup holds no account for them" : "the backup could not be read");
		before.set(project.name, { password: deps.vault(project.server?.name ?? "documents").password(email), objectKeys: found.objectKeys, backupKey: found.backupKey, copy: found.copy });
	},

	async afterErase(project, deps, report) {
		const { instance } = resolveInstance(project, RUN, deps.template());
		const domain = tenantOf(project);
		const was = before.get(project.name);
		if (!instance.url || !domain || !was) return;
		const origin = instance.url;
		const email = `${USER}@${domain}`;
		const admin = adminOf(project);
		const vault = deps.vault(project.server?.name ?? "documents");
		report.section(`after it (${project.name})`);
		const found = await deps.openStore(instance, async (store) => {
			const person = await store.subjectReport(email);
			const left = (await Promise.all(was.objectKeys.map((key) => store.readObject(key)))).filter((content) => content !== null).length;
			const contents = await Promise.all([...(await backupKeys(store)).keys()].map(async (key) => ({ key, content: await store.readObject(key) })));
			return { person, left, contents };
		}).catch(failed);
		if ("error" in found) return void report.check("nothing of theirs is left in the database", false, found.error);
		report.check("nothing of theirs is left in the database", found.person.userId === null, JSON.stringify(found.person.counts));
		if (was.objectKeys.length === 0) report.skip("their mail is gone from the bucket", "no mail was delivered to them on this server");
		else report.check(`their mail is gone from the bucket (${was.objectKeys.length} object${was.objectKeys.length === 1 ? "" : "s"})`, found.left === 0, `${found.left} of ${was.objectKeys.length} still there`);
		const documents = found.contents.map((entry) => ({ key: entry.key, document: parseBackup(entry.content ?? "") }));
		const holding = documents.filter((entry) => !entry.document || holds(entry.document, [digestOf(email)]).length > 0).map((entry) => entry.key);
		report.check(`no backup holds them (${documents.length} in the bucket)`, documents.length > 0 && holding.length === 0, holding.join("\n"));
		const broken = documents.flatMap((entry) => (entry.document ? dangling(entry.document).map((line) => `${entry.key}: ${line}`) : []));
		report.check("and each is still everyone else's backup: nothing in it points at a row that is gone", broken.length === 0 && documents.every((entry) => (entry.document?.tables.users ?? []).length > 0), broken.join("\n"));
		report.check("they cannot sign in", (await signIn(origin, email, was.password)) === null, "a session was given");
		report.check("their login is gone from the credentials folder", vault.password(email) === null);
		if (admin) report.check("everyone else still signs in", !!(await signIn(origin, admin, vault.password(admin))), `no session for ${admin}`);

		// A backup that was rewritten has to remain a backup: it is restored, over the live server.
		const rewritten = found.contents.find((entry) => entry.key === was.backupKey)?.content;
		const restored = rewritten ? await deps.openStore(instance, async (store) => {
			await whileUsed(origin, () => store.restoreBackup(rewritten));
			return { person: await store.subjectReport(email) };
		}).catch(failed) : { error: "the backup taken before the takedown is not in the bucket" };
		report.check("the backup that was rewritten restores, with the server in use throughout", !("error" in restored), "error" in restored ? restored.error : "");
		if ("error" in restored) return;
		report.check("and they are not in what it brings back", restored.person.userId === null, JSON.stringify(restored.person.counts));
		if (admin) report.check("and the restored server signs its admin in", !!(await signIn(origin, admin, vault.password(admin))), `no session for ${admin}`);
	},

	async restoreCopy(project, deps, report) {
		const { instance } = resolveInstance(project, RUN, deps.template());
		const domain = tenantOf(project);
		const was = before.get(project.name);
		if (!instance.url || !domain || !was?.copy) return;
		const copy = was.copy;
		report.section(`a copy from before the takedown, restored (${project.name})`);
		const origin = instance.url;
		const restored = await deps.openStore(instance, async (store) => {
			await whileUsed(origin, () => store.restoreBackup(copy));
			return { person: await store.subjectReport(`${USER}@${domain}`) };
		}).catch(failed);
		report.check("a copy this system never rewrote restores, and they are back", !("error" in restored) && !!restored.person.userId, "error" in restored ? restored.error : "they did not come back");
	},

	async backups(project, deps, report) {
		const { instance } = resolveInstance(project, RUN, deps.template());
		if (!instance.url && !instance.local) return;
		const found = await deps.openStore(instance, async (store) => ({ settings: (await store.rows("backup_settings", { id: "default" }))[0], rows: await store.rows("backups", {}) })).catch(failed);
		if ("error" in found) return void report.check(`${project.name}: its backups can be read`, false, found.error);
		if (!Number(found.settings?.enabled ?? 0)) return report.skip(`${project.name}: backups`, "they are off for this server");
		const finished = found.rows.filter((row) => row.status === "completed" || row.status === "failed").sort((a, b) => Number(b.created_at) - Number(a.created_at));
		const latest = finished[0];
		const days = latest ? (Date.now() / 1000 - Number(latest.created_at)) / 86_400 : 0;
		const allowed = STALE[String(found.settings?.schedule_type ?? "daily")] ?? 2;
		report.check(`${project.name}: its latest backup completed${latest?.status === "completed" ? ` (${new Date(Number(latest.created_at) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC)` : ""}`, latest?.status === "completed" && days <= allowed,
			!latest ? "none has ever been taken — apply takes the first" : latest.status !== "completed" ? `it failed: ${latest.error}` : `it is ${Math.floor(days)} days old, and the schedule is ${found.settings?.schedule_type}`);
	},

	async forgotten(project, deps, report) {
		const { instance } = resolveInstance(project, RUN, deps.template());
		const stones = project.entries.flatMap((entry) => tombstones(entry.spec));
		if (stones.length === 0 || (!instance.url && !instance.local)) return;
		const digests = stones.map((stone) => stone.digest);
		const found = await deps.openStore(instance, async (store) => {
			const here = (await store.rows("users", {})).map((row) => digestOf(String(row.email ?? ""))).filter((digest) => digests.includes(digest));
			const keys = [...(await backupKeys(store)).keys()];
			const holding: string[] = [];
			for (const key of keys) {
				const document = parseBackup((await store.readObject(key)) ?? "");
				if (!document || holds(document, digests).length > 0) holding.push(key);
			}
			return { here, keys, holding };
		}).catch(failed);
		if ("error" in found) return void report.check(`${project.name}: nobody declared erased is here`, false, found.error);
		report.check(`${project.name}: nobody declared erased is here (${stones.length} declared)`, found.here.length === 0, `${found.here.length} of them have an account — apply with --confirm-destroy`);
		report.check(`${project.name}: and no backup holds them (${found.keys.length} in the bucket)`, found.holding.length === 0, found.holding.join("\n"));
	},

	async fleet(projects, deps, report) {
		const deployed = projects.filter((project) => project.server?.url && !project.server.local);
		if (deployed.length === 0) return;
		report.section("a front door (deployed for these servers alone, asked, and removed)");
		const name = `${deployed[0].server!.name}-router`;
		const quiet = () => {};
		const map = fleetMap(deployed);
		report.check("router apply: deployed", (await router(deployed, FLAGS, name, quiet)) === 0);
		const url = await workersDevUrl(name);
		for (const [domain, server] of Object.entries(map.domains)) {
			const home = await fetch(`${url}/.well-known/mailflare-home?domain=${domain}`).then((response) => response.json() as Promise<{ server?: string; url?: string; jurisdiction?: string | null }>, () => ({} as { server?: string; url?: string; jurisdiction?: string | null }));
			report.check(`${domain} goes home to ${server}${map.servers[server].jurisdiction ? ` (${map.servers[server].jurisdiction})` : ""}`, home.server === server && home.url === map.servers[server].url && (home.jurisdiction ?? null) === (map.servers[server].jurisdiction ?? null), JSON.stringify(home));
		}
		await answers(report, "a domain nobody hosts is refused", () => status(`${url}/.well-known/mailflare-home?domain=nobody.example`), 404);
		await homes(url, map, report);
		report.check("router plan: reconciled", (await router(deployed, { ...FLAGS, status: true }, name, quiet)) === 0);
		report.check("unconfirmed, a router destroy is a preview", (await router(deployed, { ...FLAGS, cleanup: true, status: true }, name, quiet)) === 1);
		report.check("router destroy: removed", (await router(deployed, { ...FLAGS, cleanup: true, confirmDestroy: true }, name, quiet)) === 0);
		let answer = 200;
		for (let attempt = 0; attempt < 15 && answer === 200; attempt += 1) {
			answer = await status(`${url}/.well-known/mailflare-fleet`);
			if (answer === 200) await sleep(4000);
		}
		report.check("it no longer answers", answer !== 200, `HTTP ${answer}`);
	},

	async frontDoor(projects, deps, report) {
		// The fleet's router knows the fleet: a disposable server is kept out of it, and has one of its own in conformance.
		const fleet = projects.filter((project) => !project.server?.disposable);
		if (fleet.length < projects.length) report.skip("the fleet's front door, for a disposable server", "it is kept out of the fleet's router; conformance deploys a router of its own for these");
		const map = fleetMap(fleet);
		if (Object.keys(map.servers).length === 0) return;
		const url = await workersDevUrl(`${deps.template().name}-router`);
		report.section(`the front door (${url})`);
		for (const [domain, server] of Object.entries(map.domains)) {
			const home = await fetch(`${url}/.well-known/mailflare-home?domain=${domain}`).then((response) => response.json() as Promise<{ server?: string; jurisdiction?: string | null }>, () => ({} as { server?: string; jurisdiction?: string | null }));
			report.check(`${domain} goes home to ${server}${map.servers[server].jurisdiction ? ` (${map.servers[server].jurisdiction})` : ""}`, home.server === server && (home.jurisdiction ?? null) === (map.servers[server].jurisdiction ?? null), JSON.stringify(home));
		}
		await answers(report, "a domain nobody hosts is refused", () => status(`${url}/.well-known/mailflare-home?domain=nobody.example`), 404);
		await homes(url, map, report);
	},

	async gone(project, origin, report) {
		if (!origin || project.server?.local) return;
		let answer = 200;
		for (let attempt = 0; attempt < 15 && answer !== 404 && answer !== 0; attempt += 1) {
			answer = await status(`${origin}/login`);
			if (answer !== 404 && answer !== 0) await sleep(4000);
		}
		report.check(`${project.name} no longer answers`, answer === 404 || answer === 0, `HTTP ${answer}`);
	},

	notChecked(report) {
		report.section("not checked here");
		report.skip("mail arriving through Cloudflare Email Routing, and an account's forwarding address", "needs a zone whose MX points at the server; a conformance server is given no Cloudflare token so that it can touch none");
		report.skip("the fedramp jurisdiction", "needs a Cloudflare account entitled to it");
		report.skip("a guarantee that nothing is processed outside a region", "placement puts a Worker's web requests in a country, not its mail, queue and schedule handlers; the guarantee is Cloudflare's Regional Services");
		report.skip("Cloudflare Email Routing no longer delivering to an erased address", "needs a zone whose MX points at the server; the mailbox is deleted through the app, which removes the rule");
		report.skip("the database's own point-in-time recovery", "Cloudflare keeps a D1 database restorable to any minute of the last 30 days, erased rows included; it ages out, and cannot be shortened from here");
	},
};
