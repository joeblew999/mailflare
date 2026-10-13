// Loading documents, projects and servers. Everything is validated before anything reads it.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { validateBody } from "./app";
import { assertValid, erasedAndDeclared, validateInstanceDocument, validateServer, validateSpec, validateTenantDocument } from "./validate";
import type { Role, Server, Spec } from "./spec";

/** Every project lives in its own folder: a server, an instance document, and its tenants. */
export const PROJECTS_DIR = "scripts/state/specs/projects";
/** The servers conformance builds, wipes and destroys. Kept apart from the fleet's. */
export const CONFORMANCE_DIR = "scripts/state/specs/conformance";

/** One document queued for a run. */
export type SpecEntry = { name: string; spec: Spec };
/** What one run reconciles: the documents, and the server they describe (none for a bare file). */
export type Project = { name: string; dir: string; server: Server | null; entries: SpecEntry[]; /** Every document of the server is here, not a part of them. */ complete?: boolean };

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** The mailboxes a document declares, normalised. */
export function rolesFor(spec: Spec): Role[] {
	return (spec.mailboxes ?? []).map((entry) => ({
		role: String(entry.role ?? entry.localPart ?? "").trim().toLowerCase(),
		displayName: entry.displayName?.trim() || null,
		shared: Boolean(entry.shared),
		access: entry.access ?? [],
		managesAccess: entry.access !== undefined,
	})).filter((role) => role.role);
}

/** The body for onboarding a domain, checked against the app's own schema. */
export function onboardBody(spec: Spec, hostname: string) {
	const onboard = spec.onboard ?? {};
	return validateBody("domain", {
		hostname,
		enableRouting: onboard.enableRouting ?? true,
		replaceMxRecords: Boolean(onboard.replaceMxRecords),
		...(typeof onboard.enableSending === "boolean" ? { enableSending: onboard.enableSending } : {}),
		...(onboard.sendingProvider ? { sendingProvider: onboard.sendingProvider } : {}),
		...(onboard.receivingProvider ? { receivingProvider: onboard.receivingProvider } : {}),
	});
}

// --- documents ----------------------------------------------------------------------

/** One file: a document, or `{ "specs": [ ...documents ] }`. */
export function loadDocuments(path: string): SpecEntry[] {
	const parsed = readJson(path) as Spec & { specs?: Spec[] };
	assertValid(validateSpec(parsed), path);
	if (!Array.isArray(parsed.specs)) return [{ name: path, spec: parsed }];
	if (parsed.specs.length === 0) throw new Error(`${path} lists no specs`);
	return parsed.specs.map((spec, index) => ({ name: spec.domain ?? `${path}#${index + 1}`, spec }));
}

// --- servers ------------------------------------------------------------------------

export const projectDir = (name: string, base = PROJECTS_DIR) => join(base, name);
export const serverDocPath = (name: string, base = PROJECTS_DIR) => join(projectDir(name, base), "server.json");
export const instanceDocPath = (name: string, base = PROJECTS_DIR) => join(projectDir(name, base), "instance.json");

/** The server a project folder declares. The FOLDER names it; the file describes it. */
export function loadServer(name: string, base = PROJECTS_DIR): Server {
	const path = serverDocPath(name, base);
	if (!existsSync(path)) throw new Error(`no server "${name}" — expected ${path}`);
	const declared = readJson(path);
	assertValid(validateServer(declared), path);
	return { ...(declared as Omit<Server, "name">), name };
}

/** Write back what we learned (an origin) without disturbing the rest. */
export function saveServer(name: string, patch: Partial<Omit<Server, "name">>, base = PROJECTS_DIR): Server {
	const merged: Record<string, unknown> = { ...loadServer(name, base), ...patch };
	for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key];
	delete merged.name; // the folder already says it
	writeFileSync(serverDocPath(name, base), `${JSON.stringify(merged, null, 2)}\n`);
	return loadServer(name, base);
}

// --- projects -----------------------------------------------------------------------

const isTenantFile = (file: string) => file.endsWith(".json") && file !== "instance.json" && file !== "server.json" && !file.startsWith("_");

/**
 * A PROJECT is the unit a user runs: one server, its instance document, then every tenant in
 * the folder. Files starting with `_` are drafts and are skipped.
 */
export function loadProject(name: string, base = PROJECTS_DIR): Project {
	const dir = projectDir(name, base);
	if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`no project "${name}" — expected a folder at ${dir}/`);
	const server = loadServer(name, base);
	const entries: SpecEntry[] = [];
	const problems: string[] = [];
	const check = (path: string, found: string[]) => problems.push(...found.map((problem) => `${path}: ${problem}`));

	if (existsSync(instanceDocPath(name, base))) {
		const path = instanceDocPath(name, base);
		const [entry] = loadDocuments(path);
		check(path, validateInstanceDocument(entry.spec));
		entries.push({ name: `${name}/instance`, spec: entry.spec });
	}
	// MCP key names are instance-wide, so two tenants cannot both claim one.
	const keyOwners = new Map<string, string>();
	for (const file of readdirSync(dir).filter(isTenantFile).sort()) {
		const path = join(dir, file);
		const documents = loadDocuments(path);
		if (documents.length !== 1) check(path, ["a project document holds one tenant, not a list of specs"]);
		const spec = documents[0].spec;
		check(path, validateTenantDocument(spec, file, server));
		for (const key of spec.mcpKeys ?? []) {
			const keyName = String(key.name ?? "agent").trim();
			const owner = keyOwners.get(keyName);
			if (owner) check(path, [`mcpKeys: "${keyName}" is already declared by ${owner} — key names are instance-wide, so name each one`]);
			else keyOwners.set(keyName, file);
		}
		entries.push({ name: `${name}/${spec.domain ?? file}`, spec });
	}
	// One document can erase someone another declares; each apply would make them and take them away.
	problems.push(...erasedAndDeclared(entries.map((entry) => entry.spec)));
	if (problems.length > 0) throw new Error(`project "${name}" is not valid:\n    ${[...new Set(problems)].join("\n    ")}`);
	if (entries.length === 0) throw new Error(`${dir} holds no documents`);
	return { name, dir: base, server, entries, complete: true };
}

/** Every project in a folder. Templates (`example`), drafts (`_*`) and disposable servers are skipped. */
export function loadProjects(base = PROJECTS_DIR, { disposable = false }: { disposable?: boolean } = {}): Project[] {
	if (!existsSync(base) || !statSync(base).isDirectory()) throw new Error(`no projects folder at ${base}/`);
	const names = readdirSync(base).filter((name) => !name.startsWith("_") && name !== "example" && statSync(join(base, name)).isDirectory()).sort();
	// A disposable server is run by name, or by conformance: never as part of the fleet.
	const projects = names.map((name) => loadProject(name, base)).filter((project) => disposable || !project.server?.disposable);
	if (projects.length === 0) throw new Error(`no projects in ${base}/ (each project is a folder; example, _* and disposable servers are skipped)`);
	return projects;
}

/** A file inside a project folder runs against that project's server; any other file has none. */
export function loadDocumentTarget(path: string): Project {
	const entries = loadDocuments(path);
	const folder = dirname(path);
	const inProject = existsSync(join(folder, "server.json"));
	return { name: path, dir: dirname(folder), server: inProject ? loadServer(basename(folder), dirname(folder)) : null, entries };
}

/** A folder is one project when it holds a server.json, else a folder of projects. */
export function loadFolderTarget(path: string): Project[] {
	const folder = path.replace(/\/+$/, "");
	return existsSync(join(folder, "server.json")) ? [loadProject(basename(folder), dirname(folder))] : loadProjects(folder);
}
