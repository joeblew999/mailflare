// Documents are data, and data with no schema is how a typo becomes a silent no-op. This
// checks a document against the model in spec.ts BEFORE anything is read or written, so a
// mistake fails at `plan` with the path to the field instead of half-way through an apply.
import type { Spec } from "./spec";

const SECTIONS = ["specs", "domain", "server", "onboard", "mailboxes", "accounts", "routing", "mcpKeys", "license", "push", "fresh", "teardown"];
const PERMISSIONS = ["read_only", "send_as", "send_on_behalf", "full_access"];
const ACTIONS = ["store", "forward", "reject"];
const PROVIDERS = ["none", "cloudflare", "resend", "ses"];
// The two teardown keys have DIFFERENT vocabularies: one disables, the other removes.
const TEARDOWN: Record<string, string[]> = { accounts: ["disable", "keep"], domain: ["remove", "keep"] };

const FIELDS: Record<string, string[]> = {
	onboard: ["enableRouting", "enableSending", "replaceMxRecords", "sendingProvider", "receivingProvider"],
	mailboxes: ["role", "localPart", "displayName", "shared", "access"],
	access: ["email", "permission"],
	accounts: ["username", "name", "role", "password", "passwordEnv"],
	routing: ["name", "pattern", "action", "forwardTo", "keepCopy", "rejectReason", "priority", "matchValue", "mailboxId", "mailbox"],
	mcpKeys: ["name", "mailboxes", "scopes"],
	push: ["to", "from", "subject", "timeout"],
	teardown: ["accounts", "domain"],
	fresh: ["admin"],
	admin: ["email", "password"],
	server: ["db", "url", "jurisdiction", "region"],
};

export function validateSpec(value: unknown, where = ""): string[] {
	const problems: string[] = [];
	const at = (field: string) => (where ? `${where}.${field}` : field);

	if (!value || typeof value !== "object" || Array.isArray(value)) return [`${where || "document"}: must be a JSON object`];
	const doc = value as Record<string, unknown>;

	// A file may hold many documents: { "specs": [ ... ] }.
	if (Array.isArray(doc.specs)) {
		return (doc.specs as unknown[]).flatMap((one, index) => validateSpec(one, `specs[${index}]`));
	}

	for (const key of Object.keys(doc)) {
		if (!SECTIONS.includes(key)) problems.push(`${at(key)}: unknown section (expected one of ${SECTIONS.filter((s) => s !== "specs").join(", ")})`);
	}
	if (doc.domain !== undefined && (typeof doc.domain !== "string" || !doc.domain.trim())) {
		problems.push(`${at("domain")}: must be a non-empty string`);
	}

	const unknownFields = (name: string, value: unknown) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return;
		for (const key of Object.keys(value as Record<string, unknown>)) {
			if (!FIELDS[name].includes(key)) problems.push(`${at(name)}.${key}: unknown field (expected one of ${FIELDS[name].join(", ")})`);
		}
	};
	const asArray = (name: string): unknown[] | null => {
		const v = doc[name];
		if (v === undefined) return null;
		if (!Array.isArray(v)) {
			problems.push(`${at(name)}: must be an array`);
			return null;
		}
		return v as unknown[];
	};

	if (doc.onboard !== undefined) {
		unknownFields("onboard", doc.onboard);
		const onboard = doc.onboard as Record<string, unknown>;
		for (const provider of ["sendingProvider", "receivingProvider"]) {
			const chosen = onboard[provider];
			if (chosen !== undefined && !PROVIDERS.includes(String(chosen))) {
				problems.push(`${at(`onboard.${provider}`)}: "${String(chosen)}" is not one of ${PROVIDERS.join(", ")}`);
			}
		}
	}

	for (const [index, box] of (asArray("mailboxes") ?? []).entries()) {
		unknownFields("mailboxes", box);
		const mailbox = (box ?? {}) as Record<string, unknown>;
		if (!mailbox.role && !mailbox.localPart) problems.push(`${at(`mailboxes[${index}]`)}: needs a role`);
		if (mailbox.shared !== undefined && typeof mailbox.shared !== "boolean") {
			problems.push(`${at(`mailboxes[${index}].shared`)}: must be true or false`);
		}
		if (mailbox.access === undefined) continue;
		if (!Array.isArray(mailbox.access)) {
			problems.push(`${at(`mailboxes[${index}].access`)}: must be an array`);
			continue;
		}
		for (const [grantIndex, grant] of (mailbox.access as unknown[]).entries()) {
			const path = `mailboxes[${index}].access[${grantIndex}]`;
			unknownFields("access", grant);
			const entry = (grant ?? {}) as Record<string, unknown>;
			if (typeof entry.email !== "string" || !entry.email.includes("@")) {
				problems.push(`${at(`${path}.email`)}: must be an email address`);
			}
			if (entry.permission !== undefined && !PERMISSIONS.includes(String(entry.permission))) {
				problems.push(`${at(`${path}.permission`)}: "${String(entry.permission)}" is not one of ${PERMISSIONS.join(", ")}`);
			}
		}
	}

	for (const [index, rule] of (asArray("routing") ?? []).entries()) {
		unknownFields("routing", rule);
		const entry = (rule ?? {}) as Record<string, unknown>;
		if (!entry.pattern) problems.push(`${at(`routing[${index}]`)}: needs a pattern`);
		if (entry.action !== undefined && !ACTIONS.includes(String(entry.action))) {
			problems.push(`${at(`routing[${index}].action`)}: "${String(entry.action)}" is not one of ${ACTIONS.join(", ")}`);
		}
	}

	for (const key of asArray("mcpKeys") ?? []) unknownFields("mcpKeys", key);
	for (const [index, account] of (asArray("accounts") ?? []).entries()) {
		unknownFields("accounts", account);
		const entry = (account ?? {}) as Record<string, unknown>;
		if (!entry.username && !entry.name) problems.push(`${at(`accounts[${index}]`)}: needs a username`);
	}

	if (doc.teardown !== undefined) {
		unknownFields("teardown", doc.teardown);
		const teardown = doc.teardown as Record<string, unknown>;
		for (const key of ["accounts", "domain"]) {
			const chosen = teardown[key];
			if (chosen !== undefined && !TEARDOWN[key].includes(String(chosen))) {
				problems.push(`${at(`teardown.${key}`)}: "${String(chosen)}" is not one of ${TEARDOWN[key].join(", ")}`);
			}
		}
	}

	if (doc.fresh !== undefined) {
		unknownFields("fresh", doc.fresh);
		const fresh = doc.fresh as Record<string, unknown>;
		if (fresh.admin !== undefined) unknownFields("admin", fresh.admin);
	}

	if (doc.push !== undefined) {
		unknownFields("push", doc.push);
		const push = doc.push as Record<string, unknown>;
		if (push.timeout !== undefined && typeof push.timeout !== "number") problems.push(`${at("push.timeout")}: must be a number of seconds`);
	}

	return problems;
}

/** Throws with every problem at once, so one run tells you everything that is wrong. */
export function assertValidSpec(value: unknown, where: string): Spec {
	const problems = validateSpec(value, where);
	if (problems.length > 0) throw new Error(`${where} is not a valid document:\n    ${problems.join("\n    ")}`);
	return value as Spec;
}
