/* eslint-disable @typescript-eslint/no-explicit-any -- manifest shape is user-authored JSON. */
import { readFileSync } from "node:fs";
import { validateBody } from "./app";
import type { Flags } from "./flags";
import type { Role, Spec } from "./spec";

export function loadSpec(path: string): Spec {
	try {
		const spec = JSON.parse(readFileSync(path, "utf8"));
		if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("must be a JSON object");
		return spec as Spec;
	} catch (error) {
		throw new Error(`Could not read spec file ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// A roles file is a JSON array or one role per line ("#" comments allowed).
export function readRolesFile(path: string): any[] {
	const text = readFileSync(path, "utf8");
	if (path.toLowerCase().endsWith(".json")) {
		const parsed = JSON.parse(text);
		if (!Array.isArray(parsed)) throw new Error("roles file must be a JSON array");
		return parsed.map((entry: any) => (typeof entry === "string" ? { role: entry } : entry));
	}
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"))
		.map((role) => ({ role }));
}

// Precedence: the document → roles file → ad-hoc --roles.
export function rolesFor(values: any, spec: Spec | null, flags: Flags): Role[] {
	const entries = spec?.mailboxes?.length
		? spec.mailboxes
		: values["roles-file"]
			? readRolesFile(values["roles-file"])
			: String(values.roles).split(",").filter(Boolean).map((role: string) => ({ role }));

	return entries
		.map((entry: any) => {
			const role = String(entry.role ?? entry.localPart ?? "").trim().toLowerCase();
			if (!role) return null;
			const share = typeof entry.share === "boolean" ? entry.share : typeof entry.shared === "boolean" ? entry.shared : flags.share;
			const access = Array.isArray(entry.access) ? entry.access : [];
			return { role, displayName: entry.displayName?.trim() || role, share, access } as Role;
		})
		.filter((role): role is Role => role !== null);
}

// Onboard body: manifest options with the flag value winning for MX replacement.
export function onboardBody(spec: Spec | null, flags: Flags, hostname: string) {
	const o = spec?.onboard ?? {};
	const replaceMx = flags.replaceMx || Boolean(o.replaceMxRecords);
	const body: any = { hostname, enableRouting: o.enableRouting ?? true, replaceMxRecords: replaceMx };
	if (typeof o.enableSending === "boolean") body.enableSending = o.enableSending;
	if (o.sendingProvider) body.sendingProvider = o.sendingProvider;
	if (o.receivingProvider) body.receivingProvider = o.receivingProvider;
	return validateBody("domain", body);
}
