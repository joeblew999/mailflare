/* eslint-disable @typescript-eslint/no-explicit-any -- a Spec is user-authored JSON. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

// Onboard body: the document's options, with the flag value winning for MX replacement.
export function onboardBody(spec: Spec | null, flags: Flags, hostname: string) {
	const o = spec?.onboard ?? {};
	const replaceMx = flags.replaceMx || Boolean(o.replaceMxRecords);
	const body: any = { hostname, enableRouting: o.enableRouting ?? true, replaceMxRecords: replaceMx };
	if (typeof o.enableSending === "boolean") body.enableSending = o.enableSending;
	if (o.sendingProvider) body.sendingProvider = o.sendingProvider;
	if (o.receivingProvider) body.receivingProvider = o.receivingProvider;
	return validateBody("domain", body);
}

// --- the fleet: which servers exist, and where -----------------------------------

/** One server: its name, its origin, and the database it owns. No personal data. */
export type InstanceDecl = {
	name: string;
	url?: string;
	db?: string;
	/** Where this server is meant to live. Declaring it is INTENT; enforcing it needs the
	 *  source changes `--source-changes` lists. Absent means "not pinned". */
	jurisdiction?: string;
	region?: string;
};
export type Fleet = { instances?: InstanceDecl[] };

export const FLEET_PATH = "scripts/state/specs/fleet.json";
/** Every project lives in its own folder: an instance document, then its tenants. */
export const PROJECTS_DIR = "scripts/state/specs/projects";

/** One document queued for a run. */
export type SpecEntry = { name: string; spec: Spec };

export const projectDir = (name: string, base = PROJECTS_DIR) => `${base}/${name}`;
export const instanceDocPath = (name: string, base = PROJECTS_DIR) => `${projectDir(name, base)}/instance.json`;

/**
 * A PROJECT is the unit a user runs: the server's own document, then every tenant in the
 * folder, in one process and under one admin key. Templates (`example`) and drafts (`_*`)
 * are skipped, so `--project <name>` cannot accidentally apply one.
 */
export function loadProject(name: string, base = PROJECTS_DIR): SpecEntry[] {
	const dir = projectDir(name, base);
	let files: string[];
	try {
		files = readdirSync(dir)
			.filter((file) => file.endsWith(".json") && file !== "instance.json" && !file.startsWith("_") && file !== "example.json")
			.sort();
	} catch {
		throw new Error(`no project "${name}" — expected a folder at ${dir}/`);
	}
	const entries: SpecEntry[] = [];
	if (existsSync(instanceDocPath(name, base))) entries.push({ name: `instance:${name}`, spec: loadSpec(instanceDocPath(name, base)) });
	for (const file of files) entries.push({ name: `${name}/${file}`, spec: loadSpec(join(dir, file)) });
	if (entries.length === 0) throw new Error(`${dir} holds no documents`);
	return entries;
}

/** The fleet document, or [] when there is none (then --instance must be a path). */
export function loadFleet(path = FLEET_PATH): InstanceDecl[] {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Fleet;
		return Array.isArray(parsed?.instances) ? parsed.instances : [];
	} catch {
		return [];
	}
}

export type ResolvedInstance = InstanceDecl & { docPath: string };

/**
 * `--instance` is either a NAME in the fleet - which also supplies the server's origin and
 * database, so a run needs no --url/--db - or a path to a document, for a one-off.
 * Naming an instance means the fleet is authoritative for it; pass a path to override.
 */
export function resolveInstance(value: string, fleet: InstanceDecl[]): ResolvedInstance {
	if (value.endsWith(".json")) return { name: value, docPath: value };
	const decl = fleet.find((entry) => entry.name === value);
	if (!decl) throw new Error(`unknown instance "${value}": not a .json path, and not in ${FLEET_PATH}`);
	return { ...decl, docPath: instanceDocPath(decl.name) };
}
