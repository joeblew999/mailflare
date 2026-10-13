// What a plan cannot know: that a login written down signs in, that the app SHOWS a person
// what their document said, that mail arrives, that the data is where Cloudflare says it is.
// These ask the running app and Cloudflare directly, so they only make sense on a real server.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLOS_FILE, coloOf, countryOfColo } from "./colos";
import { BOX, USER, type Report } from "./conform";
import { workerSettings } from "./deploy";
import { resolveInstance, type FleetDeps } from "./fleet";
import { fleetMap, router, type FleetMap } from "./router";
import { cfApi, credential, sleep, workersDevUrl, wrangler } from "./wrangler";
import type { Project } from "./document";
import type { Flags } from "./flags";

export type Probes = {
	/** Is the data where the server's document says, and does the server hold only what it should? */
	where(project: Project, deps: FleetDeps, report: Report): Promise<void>;
	/** Every login on record signs in. */
	logins(project: Project, deps: FleetDeps, report: Report): Promise<void>;
	/** With one of everything added: the app shows it, the keys open it, mail reaches it. */
	afterAdd(project: Project, deps: FleetDeps, report: Report): Promise<void>;
	/** A person is erased, with their mail in the bucket. */
	erase(project: Project, deps: FleetDeps, report: Report): Promise<void>;
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

const tenantOf = (project: Project) => String(project.entries.find((entry) => entry.spec.domain)?.spec.domain ?? "").trim().toLowerCase();
const adminOf = (project: Project) => project.entries.find((entry) => !entry.spec.domain)?.spec.fresh?.admin?.email?.trim().toLowerCase() ?? null;

/**
 * Cloudflare names the data center that answered, by airport code: evidence of where the Worker
 * ran, whatever its settings say. Asked a few times, since a placement takes a moment to hold.
 */
async function answeredFrom(url: string, home: string): Promise<{ colo: string | null; country: string | null }> {
	let seen: { colo: string | null; country: string | null } = { colo: null, country: null };
	for (let attempt = 0; attempt < 3 && seen.country !== home; attempt += 1) {
		if (attempt > 0) await sleep(2000);
		const colo = coloOf(await fetch(`${url}/login`, { redirect: "manual" }).then((response) => response.headers.get("cf-placement"), () => null));
		seen = { colo, country: colo ? countryOfColo(colo) : null };
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
		const said = /jurisdiction\s*│\s*([a-z]+)/.exec((await wrangler(["d1", "info", deployment.database], { config: deployment.config })).stdout)?.[1];
		// An unpinned database is reported as the word "null".
		const pinned = said && said !== "null" ? said : null;
		report.check(`the database is ${server.jurisdiction ? `in jurisdiction ${server.jurisdiction}` : "not pinned, as declared"}`, pinned === (server.jurisdiction ?? null), `Cloudflare says: ${pinned}`);
		const buckets = (await wrangler(["r2", "bucket", "list", ...(server.jurisdiction ? ["--jurisdiction", server.jurisdiction] : [])], { config: deployment.config })).stdout;
		report.check(`the bucket is ${server.jurisdiction ? `in jurisdiction ${server.jurisdiction}` : "there"}`, buckets.includes(deployment.bucket), `no ${deployment.bucket} listed`);

		const settings = await workerSettings(deployment.worker);
		if (!settings) return report.skip("what the Worker is told and holds", "needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID");
		const { vars: said2, secrets } = settings;
		// The default server is wrangler.jsonc as it stands; every other is told who and where it is.
		if (deployment.generated) report.check("the Worker is told its own name and jurisdiction", said2.MAILFLARE_WORKER_NAME === deployment.worker && (said2.MAILFLARE_JURISDICTION ?? null) === (server.jurisdiction ?? null), JSON.stringify(said2));
		if (deployment.placement) {
			report.check(`the Worker is placed beside ${deployment.placement}`, settings.placement === deployment.placement, `Cloudflare says it is placed: ${settings.placement ?? "wherever a request arrives"}`);
			if (server.country && instance.url) {
				const home = server.country.toLowerCase();
				const { colo, country } = await answeredFrom(instance.url, home);
				const found = !colo ? "the answer named no data center (no cf-placement header)" : country ? `it answered from ${colo}, which is in ${country.toUpperCase()}` : `it answered from ${colo}, which ${COLOS_FILE} does not list — \`npm run state -- colos\` pulls the list again`;
				report.check(`and it answers from ${home.toUpperCase()}${country === home ? ` (the data center ${colo})` : ""}`, country === home, found);
			}
		}
		if (server.managesDns === false) {
			report.check("it holds no Cloudflare token, so it can touch no zone", !secrets.includes("CF_TOKEN"), secrets.join(", "));
			const domains = await deps.openStore(instance, (store) => store.listDomains()).catch(() => []);
			report.check("its domains are recorded by hand, not provisioned", domains.every((domain) => domain.zoneId === "manual"), domains.map((domain) => `${domain.hostname}: ${domain.zoneId}`).join(", "));
		}
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
		report.check("the public booking page is served", (await status(`${origin}/book/zz-conform/zz-conform`)) === 200);
		await shows("calendar events", cookie, "/api/calendar/events?start=2030-01-01T00:00:00Z&end=2030-01-31T00:00:00Z", ['"ZZ"']);
		await shows("drive folders", cookie, "/api/drive/items", ['"ZZ"']);
		await shows("API keys", cookie, "/api/api-keys", ["zz-conform"]);
		if (boss) {
			await shows("the assistant, for a mailbox", boss, `/api/agent/settings?mailboxId=${shared}`, ["v1"]);
			await shows("webhooks, which are the primary admin's", boss, "/api/webhooks", ["hooks.conform.invalid"]);
		}

		report.section(`keys and realtime (${project.name})`);
		const withKey = (path: string, key: string | null, init: RequestInit = {}) => status(`${origin}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${key}` } });
		report.check("a personal API key reads mail", (await withKey("/api/v1/messages", vault.secret("apiKeys", `${email}/zz-conform`))) === 200);
		report.check("a made-up key is refused", (await withKey("/api/v1/messages", "ep_not_a_key")) === 401);
		const initialize = { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "conformance", version: "1" } } }) };
		report.check("an MCP key opens the MCP endpoint", (await withKey("/mcp", vault.secret("mcpKeys", "zz-conform"), initialize)) === 200);
		report.check("the MCP endpoint refuses a made-up key", [401, 403].includes(await withKey("/mcp", "ep_not_a_key", initialize)));
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
			return { rows, folders, attempts, turnedAway: (await store.rows("messages", { subject: blocked.subject })).length === 0 };
		});
		for (const message of mail) {
			const row = arrived.rows.find((entry) => entry.subject === message.subject);
			const folder = arrived.folders.find((entry) => entry.id === row?.folder_id)?.name ?? null;
			report.check(message.proves, row?.mailbox_id === message.box && folder === message.folder, row ? `mailbox ${row.mailbox_id}, folder ${folder}` : "never arrived");
		}
		report.check("a reject rule turns mail away", arrived.turnedAway, "it was stored");
		await shows("and the app shows the person their mail", cookie, `/api/messages?mailboxId=${own}`, [`${run} zz-own`]);
		if (admin) report.check("the admin's webhook was called for mail in the admin's mailbox", arrived.attempts > 0, "no delivery attempt recorded");
	},

	async erase(project, deps, report) {
		const { instance } = resolveInstance(project, RUN, deps.template());
		const domain = tenantOf(project);
		if (!instance.url || !domain) return;
		const email = `${USER}@${domain}`;
		report.section(`erasing a person (${project.name})`);
		const result = await deps.openStore(instance, async (store) => {
			const before = await store.subjectReport(email);
			const admin = adminOf(project);
			const blocked = admin ? (await store.subjectReport(admin)).blockers : null;
			const erased = before.userId ? await store.eraseSubject(email) : null;
			return { before, blocked, erased, after: await store.subjectReport(email) };
		}).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
		if ("error" in result) return void report.check("the person is erased", false, result.error);
		report.check("the person's rows are found", !!result.before.userId && result.before.counts.some((count) => count.rows > 0), JSON.stringify(result.before.counts));
		if (result.blocked) report.check("the admin who owns the domains cannot be erased", result.blocked.length > 0, "nothing stands in the way of erasing the admin");
		report.check("they are erased, and nothing of theirs is left", !!result.erased && result.after.userId === null, JSON.stringify(result.after));
		if (!instance.local) report.check("their mail is deleted from the bucket", !!result.erased && result.erased.objectKeys.length > 0 && result.erased.objectsDeleted === result.erased.objectKeys.length, `${result.erased?.objectsDeleted} of ${result.erased?.objectKeys.length} object(s)`);
		deps.vault(project.server?.name ?? "documents").forgetLogin(email);
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
		report.check("a domain nobody hosts is refused", (await status(`${url}/.well-known/mailflare-home?domain=nobody.example`)) === 404);
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
		report.check("a domain nobody hosts is refused", (await status(`${url}/.well-known/mailflare-home?domain=nobody.example`)) === 404);
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
	},
};
