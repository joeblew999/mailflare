// Where the secrets this system creates come OUT: every login and every key, one file per
// project, so they can be used and handed over out of band. Nothing here is ever printed.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export const CREDENTIALS_DIR = "scripts/state/credentials";

/** A password nobody chose: long, random, and safe to paste. */
export const newPassword = () => randomUUID().replace(/-/g, "").slice(0, 24);

export type Login = { name: string; role: string; password: string; login: string; updated: string };
export type Key = { key: string; url: string; updated: string };
export type Secret = { value: string; updated: string };
/** `apiKeys` are named `<email>/<key name>`, `webhooks` `<email> <url>`. */
export type Credentials = { project: string; server: string; logins: Record<string, Login>; mcpKeys: Record<string, Key>; apiKeys: Record<string, Secret>; webhooks: Record<string, Secret> };
/** What one person is sent: where to sign in, and with what. */
export type UserLogin = { email: string; name: string; role: string; password: string; login: string; server: string; updated: string };

export type Vault = {
	/** Where it is kept, for telling the operator. */
	readonly where: string;
	/** The password on record for a login, or null when this system never set one. */
	password(email: string): string | null;
	recordLogin(email: string, login: { name: string; role: string; password: string }): void;
	forgetLogin(email: string): void;
	/** Everything on record for one person: their login, their API keys, their webhooks' secrets. */
	forgetPerson(email: string): void;
	recordKey(name: string, key: string): void;
	forgetKey(name: string): void;
	/** A personal API key, or a webhook's signing secret. */
	recordSecret(kind: "apiKeys" | "webhooks", name: string, value: string): void;
	forgetSecret(kind: "apiKeys" | "webhooks", name: string): void;
	/** A key or secret on record, by where it is kept and its name. */
	secret(kind: "mcpKeys" | "apiKeys" | "webhooks", name: string): string | null;
	/** Every login on record, each as the document its person is sent. */
	logins(): UserLogin[];
	/** The instance's origin, once it is known, so each entry says where to use it. */
	at(origin: string): void;
	/** A wiped instance has none of what was recorded. */
	clear(): void;
};

function vault(where: string, data: Credentials, save: (changed?: { email: string; login: UserLogin | null }) => void): Vault {
	const origin = () => data.server.replace(/\/+$/, "");
	const forUser = (email: string): UserLogin => ({ email, name: data.logins[email].name, role: data.logins[email].role, password: data.logins[email].password, login: data.logins[email].login, server: data.project, updated: data.logins[email].updated });
	return {
		where,
		password: (email) => data.logins[email]?.password ?? null,
		recordLogin(email, login) {
			data.logins[email] = { ...login, login: `${origin()}/login`, updated: new Date().toISOString() };
			save({ email, login: forUser(email) });
		},
		forgetLogin(email) {
			if (!(email in data.logins)) return;
			delete data.logins[email];
			save({ email, login: null });
		},
		forgetPerson(email) {
			for (const name of Object.keys(data.apiKeys)) if (name.startsWith(`${email}/`)) delete data.apiKeys[name];
			for (const name of Object.keys(data.webhooks)) if (name.startsWith(`${email} `)) delete data.webhooks[name];
			delete data.logins[email];
			save({ email, login: null });
		},
		recordSecret(kind, name, value) {
			data[kind][name] = { value, updated: new Date().toISOString() };
			save();
		},
		forgetSecret(kind, name) {
			if (!(name in data[kind])) return;
			delete data[kind][name];
			save();
		},
		secret: (kind, name) => (kind === "mcpKeys" ? data.mcpKeys[name]?.key : data[kind][name]?.value) ?? null,
		logins: () => Object.keys(data.logins).sort().map(forUser),
		recordKey(name, key) {
			data.mcpKeys[name] = { key, url: `${origin()}/mcp`, updated: new Date().toISOString() };
			save();
		},
		forgetKey(name) {
			if (!(name in data.mcpKeys)) return;
			delete data.mcpKeys[name];
			save();
		},
		at(url) {
			if (url && url !== data.server) data.server = url;
		},
		clear() {
			for (const email of Object.keys(data.logins)) save({ email, login: null });
			Object.assign(data, { logins: {}, mcpKeys: {}, apiKeys: {}, webhooks: {} });
			save();
		},
	};
}

const empty = (project: string): Credentials => ({ project, server: "", logins: {}, mcpKeys: {}, apiKeys: {}, webhooks: {} });

/** Kept in memory only: for tests, and for a run that should leave nothing behind. */
export function memoryVault(): Vault & { data: Credentials } {
	const data = empty("");
	return Object.assign(vault("memory", data, () => {}), { data });
}

const safe = (name: string) => name.replace(/[^a-z0-9._@+-]+/gi, "_");

/**
 * One file per server with everything, and beside it one file per PERSON with just their own
 * login - the thing to send them. All of it readable only by its owner.
 */
export function fileVault(project: string, dir = CREDENTIALS_DIR): Vault {
	const path = join(dir, `${safe(project)}.json`);
	const people = join(dir, safe(project));
	let data = empty(project);
	if (existsSync(path)) data = { ...data, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<Credentials>) };
	const write = (file: string, value: unknown) => {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		chmodSync(file, 0o600);
	};
	const made = vault(path, data, (changed) => {
		write(path, data);
		if (changed?.login) write(join(people, `${safe(changed.email)}.json`), changed.login);
		else if (changed) rmSync(join(people, `${safe(changed.email)}.json`), { force: true });
	});
	// A login recorded before each person had a file of their own gets one now.
	for (const login of made.logins()) if (!existsSync(join(people, `${safe(login.email)}.json`))) write(join(people, `${safe(login.email)}.json`), login);
	return made;
}

/** Every login on record under a credentials folder, for one server or for all of them. */
export function recordedLogins(dir = CREDENTIALS_DIR, project?: string): UserLogin[] {
	if (!existsSync(dir)) return [];
	const files = readdirSync(dir).filter((file) => file.endsWith(".json") && (!project || file === `${safe(project)}.json`)).sort();
	return files.flatMap((file) => fileVault(file.slice(0, -5), dir).logins());
}
