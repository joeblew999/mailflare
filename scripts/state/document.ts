/* eslint-disable @typescript-eslint/no-explicit-any -- a Spec is user-authored JSON. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { assertValidSpec } from "./validate";
import { join } from "node:path";
import { validateBody } from "./app";
import type { Role, Spec } from "./spec";

export function loadSpec(path: string): Spec {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Could not read spec file ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	// Validated before anything reads it, so a typo fails here with the field path rather than
	// silently doing nothing.
	return assertValidSpec(parsed, path);
}

/** The mailboxes a document declares, normalised. Roles come from the document: there is no
 *  ad-hoc mode, because a state driver's input IS the state. */
export function rolesFor(spec: Spec | null): Role[] {
	return (spec?.mailboxes ?? [])
		.map((entry: any) => {
			const role = String(entry.role ?? entry.localPart ?? "").trim().toLowerCase();
			if (!role) return null;
			const share = Boolean(entry.shared);
			const access = Array.isArray(entry.access) ? entry.access : [];
			return { role, displayName: entry.displayName?.trim() || role, share, access } as Role;
		})
		.filter((role): role is Role => role !== null);
}

// Onboard body: the document's options, with the flag value winning for MX replacement.
export function onboardBody(spec: Spec | null, hostname: string) {
	const o = spec?.onboard ?? {};
	const replaceMx = Boolean(o.replaceMxRecords);
	const body: any = { hostname, enableRouting: o.enableRouting ?? true, replaceMxRecords: replaceMx };
	if (typeof o.enableSending === "boolean") body.enableSending = o.enableSending;
	if (o.sendingProvider) body.sendingProvider = o.sendingProvider;
	if (o.receivingProvider) body.receivingProvider = o.receivingProvider;
	return validateBody("domain", body);
}

// --- the fleet: which servers exist, and where -----------------------------------

/** Every project lives in its own folder: a server, an instance document, and its tenants. */
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
			.filter((file) => file.endsWith(".json") && file !== "instance.json" && file !== "server.json" && !file.startsWith("_") && file !== "example.json")
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

/**
 * A SERVER, declared by projects/<name>/server.json - not by a separate registry. One place,
 * so the fleet cannot drift from the folders that make it up. No personal data.
 */
export type InstanceDecl = {
	name: string;
	url?: string;
	db?: string;
	/** Where this server is meant to live. Declaring it is INTENT; enforcing it needs the
	 *  source changes `--source-changes` lists. Absent means "not pinned". */
	jurisdiction?: string;
	region?: string;
};

export const serverDocPath = (name: string, base = PROJECTS_DIR) => `${projectDir(name, base)}/server.json`;

/** The server declared by a project folder. The FOLDER names it; the file describes it. */
export function loadServer(name: string, base = PROJECTS_DIR): InstanceDecl {
	const path = serverDocPath(name, base);
	if (!existsSync(path)) throw new Error(`no server "${name}" — expected ${path}`);
	const declared = JSON.parse(readFileSync(path, "utf8")) as Omit<InstanceDecl, "name">;
	return { ...declared, name };
}

/** Write back what we learned (an origin, a database) without disturbing the rest. */
export function saveServer(name: string, patch: Partial<Omit<InstanceDecl, "name">>, base = PROJECTS_DIR): InstanceDecl {
	const merged: Record<string, unknown> = { ...loadServer(name, base), ...patch };
	for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key];
	delete merged.name; // the folder already says it
	writeFileSync(serverDocPath(name, base), `${JSON.stringify(merged, null, 2)}\n`);
	return loadServer(name, base);
}
