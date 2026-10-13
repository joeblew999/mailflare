// Documents are data, and data with no schema is how a typo becomes a silent no-op. Every
// problem is reported with its field path, all at once.
import { ACCOUNT_ROLES, AGENT_PRESETS, AGENT_PROVIDERS, API_KEY_SCOPES, BACKUP_GROUPS, BACKUP_SCHEDULES, CALENDAR_REPEATS, INSTANCE_SECTIONS, SHARED_SECTIONS, RULE_ACTIONS, RULE_FIELDS, RULE_OPERATORS, WEBHOOK_EVENTS, EU_COUNTRIES, JURISDICTIONS, MCP_SCOPES, PERMISSIONS, PLACEMENTS, PLANS, PROVIDERS, REGIONS, ROUTING_ACTIONS, SERVER_FIELDS, SERVER_FLAGS, TENANT_SECTIONS, servedBy } from "./spec";
import { hasColo } from "./colos";
import { isDigest, tombstones } from "./subject-scope";
import type { Server, Spec } from "./spec";

const SECTIONS = ["domain", "country", ...TENANT_SECTIONS, ...INSTANCE_SECTIONS, ...SHARED_SECTIONS] as const;
const COUNTRY = /^[a-z]{2}$/i;
// The two teardown keys have DIFFERENT vocabularies: one disables or erases, the other removes.
const TEARDOWN: Record<string, readonly string[]> = { accounts: ["disable", "erase", "keep"], domain: ["remove", "keep"] };

const MAILBOX_SETTINGS = ["signature", "autoReply", "aliases", "folders", "rules", "assistant"];
const PERSON_SETTINGS = ["preferences", "resetEmail", "templates", "contacts", "calendar", "drive", "webhooks", "apiKeys"];

const FIELDS: Record<string, readonly string[]> = {
	onboard: ["enableRouting", "enableSending", "replaceMxRecords", "sendingProvider", "receivingProvider"],
	mailboxes: ["role", "localPart", "displayName", "shared", "access", ...MAILBOX_SETTINGS],
	access: ["email", "permission"],
	accounts: ["username", "name", "role", "password", "passwordEnv", "forwardingEmail", "canManageMailboxes", "canManageDomains", "canManageUsers", "mailbox", ...PERSON_SETTINGS],
	// (webhooks are refused on an account with a reason of their own, below)
	mailbox: MAILBOX_SETTINGS,
	admin: PERSON_SETTINGS,
	autoReply: ["enabled", "subject", "body"],
	folders: ["name", "color"],
	rules: ["field", "operator", "value", "action", "folder", "priority"],
	mailboxAssistant: ["enabled", "autoDraft", "instructions", "dailyLimit", "model", "reviewer"],
	preferences: ["timeZone", "keyboardShortcuts", "spamProtection", "trashRetentionDays", "showFullRecipientAddresses"],
	templates: ["name", "body", "html"],
	contacts: ["email", "name", "blocked"],
	calendar: ["bookingUsername", "bookingPages", "events"],
	bookingPages: ["name", "slug", "description", "durationMinutes", "location", "weekdays", "startTime", "endTime", "timeZone", "enabled", "color"],
	events: ["title", "startsAt", "endsAt", "description", "location", "repeat", "repeatDays", "timeZone", "color"],
	drive: ["folders"],
	webhooks: ["url", "events", "description", "enabled", "maxAttempts"],
	apiKeys: ["name", "scopes", "mailboxes"],
	routing: ["name", "pattern", "action", "forwardTo", "keepCopy", "rejectReason", "priority", "matchValue", "mailboxId", "mailbox"],
	mcpKeys: ["name", "mailboxes", "scopes"],
	license: ["plan"],
	settings: ["appName", "outboundAttachmentMaxMb", "driveStorageLimitGb", "assistant", "resendApiKeyEnv", "aws"],
	assistant: ["enabled", "provider", "preset", "baseUrl", "models", "apiKeyEnv"],
	aws: ["accessKeyIdEnv", "secretAccessKeyEnv", "region"],
	backups: ["enabled", "schedule", "scheduleValue", "retentionDays", "exclude"],
	push: ["to", "from", "subject", "timeout"],
	teardown: ["accounts", "domain"],
	fresh: ["admin"],
	freshAdmin: ["email", "password"],
};

// What the app accepts as the local part of an address (createUserAccountSchema).
const LOCAL_PART = /^[a-z0-9._%+-]+$/i;
const HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Bag = Record<string, unknown>;
const isObject = (value: unknown): value is Bag => !!value && typeof value === "object" && !Array.isArray(value);
const oneOf = (list: readonly string[]) => list.join(", ");

export function validateSpec(value: unknown, where = ""): string[] {
	if (!isObject(value)) return [`${where || "document"}: must be a JSON object`];
	const doc = value;

	// A file may hold many documents: { "specs": [ ... ] }, and then nothing else.
	if ("specs" in doc) {
		if (!Array.isArray(doc.specs)) return [`${where ? `${where}.` : ""}specs: must be an array of documents`];
		const extra = Object.keys(doc).filter((key) => key !== "specs").map((key) => `${where ? `${where}.` : ""}${key}: a file of specs holds nothing else`);
		return [...extra, ...doc.specs.flatMap((one, index) => validateSpec(one, `${where ? `${where}.` : ""}specs[${index}]`))];
	}

	const problems: string[] = [];
	const at = (field: string) => (where ? `${where}.${field}` : field);
	const fail = (field: string, message: string) => problems.push(`${at(field)}: ${message}`);

	/** A field of `bag`, when present, must satisfy `check`. */
	const field = (bag: Bag, path: string, key: string, check: (value: unknown) => boolean, message: string) => {
		if (bag[key] !== undefined && !check(bag[key])) fail(`${path}.${key}`, message);
	};
	const isString = (value: unknown) => typeof value === "string" && value.trim().length > 0;
	const isBoolean = (value: unknown) => typeof value === "boolean";
	const anEnum = (bag: Bag, path: string, key: string, list: readonly string[]) => {
		if (bag[key] !== undefined && !list.includes(String(bag[key]))) fail(`${path}.${key}`, `"${String(bag[key])}" is not one of ${oneOf(list)}`);
	};
	const knownFields = (name: string, path: string, bag: Bag) => {
		for (const key of Object.keys(bag)) if (!FIELDS[name].includes(key)) fail(`${path}.${key}`, `unknown field (expected one of ${oneOf(FIELDS[name])})`);
	};
	/** An object-valued section, or null when absent or malformed. */
	const section = (name: string): Bag | null => {
		if (doc[name] === undefined) return null;
		if (!isObject(doc[name])) {
			fail(name, "must be an object");
			return null;
		}
		knownFields(name, name, doc[name]);
		return doc[name];
	};
	/** A list-valued section's entries, each known to be an object. */
	const list = (name: string): Array<[number, Bag]> => {
		if (doc[name] === undefined) return [];
		if (!Array.isArray(doc[name])) {
			fail(name, "must be an array");
			return [];
		}
		const entries: Array<[number, Bag]> = [];
		for (const [index, entry] of (doc[name] as unknown[]).entries()) {
			if (!isObject(entry)) fail(`${name}[${index}]`, "must be an object");
			else {
				knownFields(name, `${name}[${index}]`, entry);
				entries.push([index, entry]);
			}
		}
		return entries;
	};
	const unique = (seen: Set<string>, key: string, path: string, what: string) => {
		if (seen.has(key)) fail(path, `${what} is declared twice`);
		seen.add(key);
	};

	const isEmail = (value: unknown) => typeof value === "string" && EMAIL.test(value.trim());
	const isWhole = (low: number, high: number) => (value: unknown) => Number.isInteger(value) && (value as number) >= low && (value as number) <= high;
	const isDate = (value: unknown) => typeof value === "string" && !Number.isNaN(new Date(value).getTime());
	/** An object-valued field of `bag`, or null when absent or malformed. */
	const part = (bag: Bag, path: string, key: string, fields: string): Bag | null => {
		if (bag[key] === undefined) return null;
		if (!isObject(bag[key])) {
			fail(`${path}.${key}`, "must be an object");
			return null;
		}
		knownFields(fields, `${path}.${key}`, bag[key]);
		return bag[key];
	};
	/** A list-valued field of `bag`: each entry an object with known fields and a key that is not repeated. */
	const each = (bag: Bag, path: string, key: string, identity: (entry: Bag) => unknown, what: string, check: (entry: Bag, at: string) => void) => {
		if (bag[key] === undefined) return;
		if (!Array.isArray(bag[key])) return void fail(`${path}.${key}`, "must be an array");
		const seen = new Set<string>();
		for (const [index, entry] of (bag[key] as unknown[]).entries()) {
			const at = `${path}.${key}[${index}]`;
			if (!isObject(entry)) {
				fail(at, "must be an object");
				continue;
			}
			knownFields(key, at, entry);
			const id = identity(entry);
			if (!isString(id)) fail(at, `needs ${what}`);
			else unique(seen, String(id).trim().toLowerCase(), at, `${what} "${String(id).trim()}"`);
			check(entry, at);
		}
	};
	const strings = (bag: Bag, path: string, key: string, allowed?: readonly string[]) => {
		const values = bag[key];
		if (values === undefined) return;
		if (!Array.isArray(values) || values.some((entry) => !isString(entry))) return void fail(`${path}.${key}`, "must be an array of strings");
		for (const value of allowed ? values : []) if (!allowed!.includes(String(value))) fail(`${path}.${key}`, `"${String(value)}" is not one of ${oneOf(allowed!)}`);
		if (new Set(values.map((value) => String(value).trim().toLowerCase())).size !== values.length) fail(`${path}.${key}`, "lists something twice");
	};

	/** What a mailbox can be told about itself: on a `mailboxes[]` entry, and on an account's `mailbox`. */
	const mailboxSettings = (bag: Bag, path: string) => {
		field(bag, path, "signature", (v) => v === null || typeof v === "string", "must be text, or null for none");
		const reply = part(bag, path, "autoReply", "autoReply");
		if (reply) {
			field(reply, `${path}.autoReply`, "enabled", isBoolean, "must be true or false");
			for (const key of ["subject", "body"]) field(reply, `${path}.autoReply`, key, (v) => typeof v === "string", "must be text");
		}
		strings(bag, path, "aliases");
		for (const alias of Array.isArray(bag.aliases) ? bag.aliases : []) if (typeof alias === "string" && !LOCAL_PART.test(alias.trim())) fail(`${path}.aliases`, `"${alias}" must be the local part of an address`);
		each(bag, path, "folders", (folder) => folder.name, "a name", (folder, at) => field(folder, at, "color", (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v), "must be a colour like #2563eb"));
		each(bag, path, "rules", (rule) => rule.value, "a value to match", (rule, at) => {
			anEnum(rule, at, "field", RULE_FIELDS);
			anEnum(rule, at, "operator", RULE_OPERATORS);
			anEnum(rule, at, "action", RULE_ACTIONS);
			field(rule, at, "folder", isString, "must name a folder");
			field(rule, at, "priority", isWhole(0, 1000), "must be a whole number from 0 to 1000");
			const action = rule.action ?? (rule.folder !== undefined ? "folder" : "spam");
			if (action === "folder" && rule.folder === undefined) fail(at, "a rule that files mail needs a folder");
			if (action !== "folder" && rule.folder !== undefined) fail(`${at}.folder`, `does not apply to a ${String(action)} rule`);
		});
		const assistant = part(bag, path, "assistant", "mailboxAssistant");
		if (assistant) {
			for (const key of ["enabled", "autoDraft"]) field(assistant, `${path}.assistant`, key, isBoolean, "must be true or false");
			field(assistant, `${path}.assistant`, "instructions", (v) => typeof v === "string", "must be text");
			field(assistant, `${path}.assistant`, "dailyLimit", isWhole(0, 100000), "must be a whole number");
			field(assistant, `${path}.assistant`, "model", (v) => v === null || isString(v), "must be a model id, or null for the default");
			field(assistant, `${path}.assistant`, "reviewer", (v) => v === null || isEmail(v), "must be an email address, or null");
		}
	};

	/** What a person can be told about their own mail, calendar, drive and integrations. */
	const personSettings = (bag: Bag, path: string) => {
		field(bag, path, "resetEmail", (v) => v === null || isEmail(v), "must be an email address, or null");
		const preferences = part(bag, path, "preferences", "preferences");
		if (preferences) {
			field(preferences, `${path}.preferences`, "timeZone", (v) => v === null || (typeof v === "string" && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(v)), "must be a time zone like Europe/Berlin, or null");
			for (const key of ["keyboardShortcuts", "spamProtection", "showFullRecipientAddresses"]) field(preferences, `${path}.preferences`, key, isBoolean, "must be true or false");
			field(preferences, `${path}.preferences`, "trashRetentionDays", (v) => v === null || isWhole(1, 3650)(v), "must be a whole number of days, or null");
		}
		each(bag, path, "templates", (template) => template.name, "a name", (template, at) => {
			if (typeof template.body !== "string") fail(at, "needs a body");
			field(template, at, "html", (v) => typeof v === "string", "must be text");
		});
		each(bag, path, "contacts", (contact) => contact.email, "an email", (contact, at) => {
			if (!isEmail(contact.email)) fail(`${at}.email`, "must be an email address");
			field(contact, at, "name", isString, "must be a non-empty string");
			field(contact, at, "blocked", isBoolean, "must be true or false");
		});
		const calendar = part(bag, path, "calendar", "calendar");
		if (calendar) {
			field(calendar, `${path}.calendar`, "bookingUsername", (v) => typeof v === "string" && /^[a-z0-9._+-]{1,64}$/i.test(v.trim()), "must be letters, digits, dots, plus or dashes");
			each(calendar, `${path}.calendar`, "bookingPages", (page) => page.slug ?? page.name, "a name", (page, at) => {
				if (!isString(page.name)) fail(at, "needs a name");
				field(page, at, "slug", (v) => typeof v === "string" && /^[a-z0-9-]+$/.test(v), "must be lower-case letters, digits and dashes");
				if (!isWhole(5, 480)(page.durationMinutes)) fail(`${at}.durationMinutes`, "must be a whole number of minutes from 5 to 480");
				if (!Array.isArray(page.weekdays) || page.weekdays.length === 0 || page.weekdays.some((day) => !isWhole(0, 6)(day))) fail(`${at}.weekdays`, "must list days 0 (Sunday) to 6");
				for (const key of ["startTime", "endTime"]) if (typeof page[key] !== "string" || !/^([01]\d|2[0-3]):(00|15|30|45)$/.test(page[key] as string)) fail(`${at}.${key}`, "must be a time on the quarter hour, like 09:00");
				if (!isString(page.timeZone)) fail(`${at}.timeZone`, "must be a time zone like Europe/Berlin");
				field(page, at, "enabled", isBoolean, "must be true or false");
				for (const key of ["description", "location"]) field(page, at, key, (v) => typeof v === "string", "must be text");
			});
			each(calendar, `${path}.calendar`, "events", (event) => event.title, "a title", (event, at) => {
				for (const key of ["startsAt", "endsAt"]) if (!isDate(event[key])) fail(`${at}.${key}`, "must be a date and time, like 2026-11-02T09:00:00Z");
				if (isDate(event.startsAt) && isDate(event.endsAt) && new Date(String(event.endsAt)) <= new Date(String(event.startsAt))) fail(at, "must end after it starts");
				anEnum(event, at, "repeat", CALENDAR_REPEATS);
				field(event, at, "repeatDays", (v) => Array.isArray(v) && v.length > 0 && v.every(isWhole(0, 6)), "must list days 0 (Sunday) to 6");
				for (const key of ["description", "location", "timeZone"]) field(event, at, key, (v) => typeof v === "string", "must be text");
			});
		}
		const drive = part(bag, path, "drive", "drive");
		if (drive) strings(drive, `${path}.drive`, "folders");
		each(bag, path, "webhooks", (hook) => hook.url, "a url", (hook, at) => {
			if (typeof hook.url !== "string" || !/^https?:\/\/\S+$/.test(hook.url)) fail(`${at}.url`, "must be a URL");
			if (hook.events === undefined) fail(at, `needs events (from ${oneOf(WEBHOOK_EVENTS)})`);
			strings(hook, at, "events", WEBHOOK_EVENTS);
			field(hook, at, "description", (v) => typeof v === "string", "must be text");
			field(hook, at, "enabled", isBoolean, "must be true or false");
			field(hook, at, "maxAttempts", isWhole(1, 10), "must be a whole number from 1 to 10");
		});
		each(bag, path, "apiKeys", (key) => key.name, "a name", (key, at) => {
			if (key.scopes === undefined) fail(at, `needs scopes (from ${oneOf(API_KEY_SCOPES)})`);
			strings(key, at, "scopes", API_KEY_SCOPES);
			strings(key, at, "mailboxes");
		});
	};

	for (const key of Object.keys(doc)) {
		if (!(SECTIONS as readonly string[]).includes(key)) fail(key, `unknown section (expected one of ${oneOf(SECTIONS)})`);
	}
	if (doc.domain !== undefined && (typeof doc.domain !== "string" || !HOSTNAME.test(doc.domain.trim()))) {
		fail("domain", "must be a hostname, like example.com");
	}
	if (doc.country !== undefined && (typeof doc.country !== "string" || !COUNTRY.test(doc.country))) fail("country", "must be a two-letter country code, like de");
	// A tenant section says what lives on a domain, so without one it can only be a mistake.
	if (doc.domain === undefined) {
		for (const name of ["country", ...TENANT_SECTIONS]) if (doc[name] !== undefined) fail(name, "needs a domain — the document names none");
	}

	const onboard = section("onboard");
	if (onboard) {
		for (const key of ["enableRouting", "enableSending", "replaceMxRecords"]) field(onboard, "onboard", key, isBoolean, "must be true or false");
		for (const key of ["sendingProvider", "receivingProvider"]) anEnum(onboard, "onboard", key, PROVIDERS);
	}

	const roles = new Set<string>();
	for (const [index, mailbox] of list("mailboxes")) {
		const path = `mailboxes[${index}]`;
		const role = mailbox.role ?? mailbox.localPart;
		if (role === undefined) fail(path, "needs a role");
		else if (typeof role !== "string" || !LOCAL_PART.test(role.trim())) fail(`${path}.role`, "must be the local part of an address, like office");
		else unique(roles, role.trim().toLowerCase(), `${path}.role`, `mailbox "${role}"`);
		field(mailbox, path, "displayName", isString, "must be a non-empty string");
		field(mailbox, path, "shared", isBoolean, "must be true or false");
		mailboxSettings(mailbox, path);
		if (mailbox.access === undefined) continue;
		if (!Array.isArray(mailbox.access)) {
			fail(`${path}.access`, "must be an array");
			continue;
		}
		const granted = new Set<string>();
		for (const [grantIndex, grant] of (mailbox.access as unknown[]).entries()) {
			const grantPath = `${path}.access[${grantIndex}]`;
			if (!isObject(grant)) {
				fail(grantPath, "must be an object");
				continue;
			}
			knownFields("access", grantPath, grant);
			if (typeof grant.email !== "string" || !EMAIL.test(grant.email.trim())) fail(`${grantPath}.email`, "must be an email address");
			else unique(granted, grant.email.trim().toLowerCase(), `${grantPath}.email`, `a grant to ${grant.email}`);
			anEnum(grant, grantPath, "permission", PERMISSIONS);
		}
	}

	const usernames = new Set<string>();
	for (const [index, account] of list("accounts")) {
		const path = `accounts[${index}]`;
		if (account.username === undefined) fail(path, "needs a username");
		else if (typeof account.username !== "string" || !LOCAL_PART.test(account.username.trim())) fail(`${path}.username`, "must be the local part of an address, like sam");
		else unique(usernames, account.username.trim().toLowerCase(), `${path}.username`, `account "${account.username}"`);
		field(account, path, "name", isString, "must be a non-empty string");
		anEnum(account, path, "role", ACCOUNT_ROLES);
		field(account, path, "password", (v) => typeof v === "string" && v.length >= 8, "must be at least 8 characters");
		field(account, path, "passwordEnv", isString, "must name an environment variable");
		if (account.password !== undefined && account.passwordEnv !== undefined) fail(path, "give password or passwordEnv, not both");
		field(account, path, "forwardingEmail", (v) => v === null || isEmail(v), "must be an email address, or null");
		for (const key of ["canManageMailboxes", "canManageDomains", "canManageUsers"]) field(account, path, key, isBoolean, "must be true or false");
		// The app lets only the primary admin keep webhooks, so on anyone else they would be dead rows.
		if (account.webhooks !== undefined) fail(`${path}.webhooks`, "webhooks are the primary admin's — declare them under admin in instance.json");
		personSettings(account, path);
		const own = part(account, path, "mailbox", "mailbox");
		if (own) mailboxSettings(own, `${path}.mailbox`);
	}

	const rules = new Set<string>();
	for (const [index, rule] of list("routing")) {
		const path = `routing[${index}]`;
		if (!isString(rule.pattern)) fail(path, "needs a pattern");
		anEnum(rule, path, "action", ROUTING_ACTIONS);
		const action = String(rule.action ?? "forward");
		if (isString(rule.pattern)) unique(rules, `${String(rule.pattern).trim()} ${action}`, path, `a ${action} rule for "${String(rule.pattern).trim()}"`);
		for (const key of ["name", "rejectReason", "matchValue", "mailboxId", "mailbox"]) field(rule, path, key, isString, "must be a non-empty string");
		field(rule, path, "forwardTo", (v) => typeof v === "string" && EMAIL.test(v.trim()), "must be an email address");
		field(rule, path, "keepCopy", isBoolean, "must be true or false");
		field(rule, path, "priority", (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1000, "must be a whole number from 0 to 1000");
		if (rule.mailbox !== undefined && rule.mailboxId !== undefined) fail(path, "give mailbox (a role) or mailboxId, not both");
		if (action === "forward" && rule.forwardTo === undefined) fail(path, "a forward rule needs forwardTo");
		if ((action === "store" || rule.keepCopy === true) && rule.mailbox === undefined && rule.mailboxId === undefined) {
			fail(path, `${action === "store" ? "a store rule" : "keepCopy"} needs a mailbox`);
		}
	}

	const keys = new Set<string>();
	for (const [index, key] of list("mcpKeys")) {
		const path = `mcpKeys[${index}]`;
		field(key, path, "name", isString, "must be a non-empty string");
		unique(keys, String(key.name ?? "agent").trim(), path, `key "${String(key.name ?? "agent").trim()}"`);
		for (const name of ["mailboxes", "scopes"]) {
			const values = key[name];
			if (values === undefined) continue;
			if (!Array.isArray(values) || values.some((entry) => !isString(entry))) fail(`${path}.${name}`, "must be an array of strings");
			else if (name === "scopes") {
				for (const scope of values) if (!(MCP_SCOPES as readonly string[]).includes(String(scope))) fail(`${path}.scopes`, `"${String(scope)}" is not one of ${oneOf(MCP_SCOPES)}`);
			}
		}
	}

	if (doc.license !== undefined) {
		if (typeof doc.license === "string") {
			if (!(PLANS as readonly string[]).includes(doc.license)) fail("license", `"${doc.license}" is not one of ${oneOf(PLANS)}`);
		} else {
			const license = section("license");
			if (license && license.plan === undefined) fail("license", `needs a plan (one of ${oneOf(PLANS)})`);
			if (license) anEnum(license, "license", "plan", PLANS);
		}
	}

	const settings = section("settings");
	if (settings) {
		field(settings, "settings", "appName", (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 100, "must be a name of up to 100 characters");
		field(settings, "settings", "outboundAttachmentMaxMb", (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 25, "must be a whole number from 1 to 25");
		field(settings, "settings", "driveStorageLimitGb", (v) => v === null || (typeof v === "number" && v > 0), "must be a number of GB, or null for no limit");
		field(settings, "settings", "resendApiKeyEnv", isString, "must name an environment variable");
		if (settings.assistant !== undefined) {
			if (!isObject(settings.assistant)) fail("settings.assistant", "must be an object");
			else {
				const assistant = settings.assistant;
				const path = "settings.assistant";
				knownFields("assistant", path, assistant);
				field(assistant, path, "enabled", isBoolean, "must be true or false");
				anEnum(assistant, path, "provider", AGENT_PROVIDERS);
				anEnum(assistant, path, "preset", AGENT_PRESETS);
				field(assistant, path, "baseUrl", (v) => typeof v === "string" && /^https:\/\/[^\s?#@]+$/.test(v), "must be an HTTPS base URL without credentials or a query");
				field(assistant, path, "models", (v) => Array.isArray(v) && v.length > 0 && v.length <= 20 && v.every(isString), "must be 1 to 20 model ids");
				field(assistant, path, "apiKeyEnv", isString, "must name an environment variable");
				const compatible = assistant.provider === "compatible";
				for (const key of ["preset", "baseUrl", "apiKeyEnv"]) if (assistant[key] !== undefined && !compatible) fail(`${path}.${key}`, 'only applies to the "compatible" provider');
				if (assistant.models !== undefined && assistant.provider === undefined) fail(`${path}.models`, "needs a provider");
				if (compatible) {
					if (assistant.models === undefined) fail(path, "a compatible provider needs models");
					if (assistant.apiKeyEnv === undefined) fail(path, "a compatible provider needs apiKeyEnv");
					if ((assistant.preset ?? "custom") === "custom" && assistant.baseUrl === undefined) fail(path, "the custom preset needs a baseUrl");
					if (assistant.preset !== undefined && assistant.preset !== "custom" && assistant.baseUrl !== undefined) fail(`${path}.baseUrl`, "only applies to the custom preset");
				}
			}
		}
		if (settings.aws !== undefined) {
			if (!isObject(settings.aws)) fail("settings.aws", "must be an object");
			else {
				knownFields("aws", "settings.aws", settings.aws);
				for (const key of ["accessKeyIdEnv", "secretAccessKeyEnv"]) if (!isString(settings.aws[key])) fail(`settings.aws.${key}`, "must name an environment variable");
				if (typeof settings.aws.region !== "string" || !/^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(settings.aws.region)) fail("settings.aws.region", "must be an AWS region, like eu-west-1");
			}
		}
	}

	const backups = section("backups");
	if (backups) {
		field(backups, "backups", "enabled", isBoolean, "must be true or false");
		anEnum(backups, "backups", "schedule", BACKUP_SCHEDULES);
		field(backups, "backups", "retentionDays", (v) => v === null || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 3650), "must be a whole number of days from 1 to 3650, or null to keep everything");
		const [low, high] = backups.schedule === "weekly" ? [0, 6] : [1, 28];
		if (backups.schedule === "weekly" || backups.schedule === "monthly") {
			if (!Number.isInteger(backups.scheduleValue) || (backups.scheduleValue as number) < low || (backups.scheduleValue as number) > high) {
				fail("backups.scheduleValue", `a ${backups.schedule} schedule needs a day from ${low} to ${high}`);
			}
		} else if (backups.scheduleValue !== undefined) fail("backups.scheduleValue", "only applies to a weekly or monthly schedule");
		if (backups.exclude !== undefined) {
			if (!Array.isArray(backups.exclude) || backups.exclude.some((group) => !(BACKUP_GROUPS as readonly string[]).includes(String(group)))) fail("backups.exclude", `must be a list from ${oneOf(BACKUP_GROUPS)}`);
			else if (new Set(backups.exclude).size >= BACKUP_GROUPS.length) fail("backups.exclude", "cannot leave every group out");
		}
	}

	const push = section("push");
	if (push) {
		for (const key of ["to", "from"]) field(push, "push", key, (v) => typeof v === "string" && EMAIL.test(v.trim()), "must be an email address");
		field(push, "push", "subject", isString, "must be a non-empty string");
		field(push, "push", "timeout", (v) => typeof v === "number" && v > 0, "must be a number of seconds");
	}

	const admin = section("admin");
	if (admin) personSettings(admin, "admin");

	// Tombstones. An address is checked as one; a digest says nothing more that can be.
	if (doc.erased !== undefined) {
		if (!Array.isArray(doc.erased)) fail("erased", "must be an array of addresses, or sha256: digests of them");
		else {
			const domain = typeof doc.domain === "string" ? doc.domain.trim().toLowerCase() : "";
			for (const [index, entry] of (doc.erased as unknown[]).entries()) {
				const written = typeof entry === "string" ? entry.trim().toLowerCase() : "";
				if (!written) fail(`erased[${index}]`, "must be an address, or sha256: and the digest of one");
				else if (written.startsWith("sha256:")) {
					if (!isDigest(written)) fail(`erased[${index}]`, "a digest is sha256: and 64 hex characters — `state subject <address>` prints it");
				} else if (written.includes("@")) {
					if (!EMAIL.test(written)) fail(`erased[${index}]`, `"${written}" is not an address`);
					else if (domain && !written.endsWith(`@${domain}`)) fail(`erased[${index}]`, `"${written}" is not on ${domain} — a tenant document erases people on its own domain; instance.json takes any address`);
				} else if (!domain) fail(`erased[${index}]`, `"${written}" needs its domain: write the whole address`);
				else if (!/^[a-z0-9._+-]+$/.test(written)) fail(`erased[${index}]`, `"${written}" is not a name on ${domain}`);
			}
			// Declared and erased at once is a contradiction: each apply would make them and take them away.
			if (problems.length === 0) for (const problem of erasedAndDeclared([doc as Spec])) problems.push(where ? `${where}.${problem}` : problem);
		}
	}

	const teardown = section("teardown");
	if (teardown) for (const key of Object.keys(TEARDOWN)) anEnum(teardown, "teardown", key, TEARDOWN[key]);

	const fresh = section("fresh");
	if (fresh?.admin !== undefined) {
		if (!isObject(fresh.admin)) fail("fresh.admin", "must be an object");
		else {
			knownFields("freshAdmin", "fresh.admin", fresh.admin);
			field(fresh.admin, "fresh.admin", "email", (v) => typeof v === "string" && EMAIL.test(v.trim()), "must be an email address");
			field(fresh.admin, "fresh.admin", "password", (v) => typeof v === "string" && v.length >= 8, "must be at least 8 characters");
		}
	}

	return problems;
}

/** Throws with every problem at once, so one run tells you everything that is wrong. */
export function assertValid(problems: string[], where: string): void {
	if (problems.length > 0) throw new Error(`${where} is not a valid document:\n    ${problems.join("\n    ")}`);
}

export function assertValidSpec(value: unknown, where: string): Spec {
	assertValid(validateSpec(value), where);
	return value as Spec;
}

/**
 * People who are both erased and declared, across the documents given: an account, or the admin
 * a reset makes. One document can erase whom another declares, so a project checks them together.
 */
export function erasedAndDeclared(specs: Spec[]): string[] {
	const erased = new Map(specs.flatMap((spec) => tombstones(spec)).map((stone) => [stone.digest, stone.label]));
	if (erased.size === 0) return [];
	const problems: string[] = [];
	for (const spec of specs) {
		const domain = String(spec.domain ?? "").trim().toLowerCase();
		const declared = [...(spec.accounts ?? []).map((entry) => `${String(entry.username ?? "").trim().toLowerCase()}@${domain}`), ...(spec.fresh?.admin?.email ? [spec.fresh.admin.email.trim().toLowerCase()] : [])];
		for (const email of declared) {
			const digest = tombstones({ erased: [email] })[0]?.digest;
			if (digest && erased.has(digest)) problems.push(`erased: ${email} is declared and erased — a person is one or the other`);
		}
	}
	return [...new Set(problems)];
}

/** instance.json describes the instance, and nothing that lives on a domain. */
export function validateInstanceDocument(spec: Spec): string[] {
	return Object.keys(spec)
		.filter((key) => !(INSTANCE_SECTIONS as readonly string[]).includes(key) && !(SHARED_SECTIONS as readonly string[]).includes(key))
		.map((key) => `${key}: belongs in a <domain>.json document — instance.json holds only ${oneOf(INSTANCE_SECTIONS)}`);
}

/** A tenant document describes one domain, and nothing instance-wide. Its server must be home to its country. */
export function validateTenantDocument(spec: Spec, file: string, server?: Server): string[] {
	const problems = INSTANCE_SECTIONS.filter((key) => spec[key] !== undefined).map((key) => `${key}: belongs in instance.json — it is instance-wide, not per domain`);
	if (spec.country && server && !server.local) {
		const served = servedBy(server);
		if (!served.includes(spec.country.toLowerCase())) {
			problems.push(`country: "${spec.country}" is not at home on "${server.name}", which ${served.length > 0 ? `serves ${served.join(", ")}` : "does not say which countries it serves"} — move this document to a server that serves it`);
		}
	}
	if (!spec.domain) problems.push("domain: a tenant document names its domain");
	else if (`${spec.domain.trim().toLowerCase()}.json` !== file.toLowerCase()) problems.push(`domain: the file is ${file} but it declares "${spec.domain}" — name the file after the domain`);
	return problems;
}

export function validateServer(value: unknown): string[] {
	if (!isObject(value)) return ["must be a JSON object"];
	const problems: string[] = [];
	for (const [key, entry] of Object.entries(value)) {
		if (!(SERVER_FIELDS as readonly string[]).includes(key)) problems.push(`${key}: unknown field (expected one of ${oneOf(SERVER_FIELDS)})`);
		else if (key === "serves") {
			if (!Array.isArray(entry) || entry.length === 0 || entry.some((code) => typeof code !== "string" || (code.toLowerCase() !== "eu" && !COUNTRY.test(code)))) problems.push('serves: must list two-letter country codes, or "eu"');
		} else if ((SERVER_FLAGS as readonly string[]).includes(key) ? typeof entry !== "boolean" : typeof entry !== "string" || !entry.trim()) problems.push(`${key}: must be ${(SERVER_FLAGS as readonly string[]).includes(key) ? "true or false" : "a non-empty string"}`);
	}
	if (typeof value.url === "string" && !/^https?:\/\//.test(value.url)) problems.push("url: must start with http:// or https://");
	if (value.jurisdiction !== undefined && !(JURISDICTIONS as readonly string[]).includes(String(value.jurisdiction))) problems.push(`jurisdiction: "${String(value.jurisdiction)}" is not one of ${oneOf(JURISDICTIONS)}`);
	if (value.region !== undefined && !(REGIONS as readonly string[]).includes(String(value.region))) problems.push(`region: "${String(value.region)}" is not one of ${oneOf(REGIONS)}`);
	const country = typeof value.country === "string" ? value.country.toLowerCase() : undefined;
	if (value.country !== undefined && (typeof value.country !== "string" || !COUNTRY.test(value.country))) problems.push("country: must be a two-letter country code, like de");
	if (value.placement !== undefined && (typeof value.placement !== "string" || !/^(aws|gcp|azure):[a-z0-9-]+$/.test(value.placement))) problems.push("placement: must be a cloud region, like aws:eu-central-1");
	// Running in a country needs a region to run beside, and a jurisdiction that contains it.
	if (country && COUNTRY.test(country) && !hasColo(country)) problems.push(`country: Cloudflare has no data center in "${country}", so nothing can run there`);
	else if (country && COUNTRY.test(country) && value.placement === undefined && !PLACEMENTS[country]) problems.push(`country: no region is known for "${country}" — give \`placement\` (a cloud region there, like aws:eu-central-1)`);
	if (country && value.jurisdiction === "eu" && !EU_COUNTRIES.includes(country)) problems.push(`country: "${country}" is not in the European Union, so it cannot be in the eu jurisdiction`);
	return problems;
}
