/* eslint-disable @typescript-eslint/no-explicit-any -- CLI values are untyped option bags. */
// Mass mode: load the whole input once, use ONE admin key for the run, and work
// through the projects in this process. The previous runner spawned a `tsx` child
// per manifest and re-resolved the instance and re-minted a key each time - fine for
// five domains, thousands of processes and key round-trips for thousands of domains.
// A project that throws is recorded and the run continues.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeContext } from "./context";
import { run } from "./commands";
import { loadProject, loadRoles } from "./manifest";
import type { Flags, ProjectManifest } from "./types";
import type { Store } from "./store-types";

export type ProjectEntry = { name: string; project: ProjectManifest };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// `--file` is either one project manifest or `{ "projects": [ ... ] }`. `--dir` scans
// for per-domain manifests, which is how the checked-in ones are stored.
export function loadProjects({ file, dir }: { file?: string; dir: string }): ProjectEntry[] {
	if (file) {
		let parsed: any;
		try {
			parsed = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			throw new Error(`Could not read project file ${file}: ${message(error)}`);
		}
		const list: ProjectManifest[] = Array.isArray(parsed?.projects) ? parsed.projects : [parsed];
		if (list.length === 0) throw new Error(`${file} lists no projects`);
		return list.map((project, index) => ({ name: String(project?.domain ?? `${file}#${index + 1}`), project }));
	}
	const files = readdirSync(dir)
		.filter((name) => name.endsWith(".json") && !name.startsWith("_") && name !== "example.json")
		.sort();
	if (files.length === 0) throw new Error(`No project manifests in ${dir} (expected *.json; example.json and _*.json are skipped).`);
	return files.map((name) => ({ name: join(dir, name), project: loadProject(join(dir, name)) }));
}

export async function runBatch(store: Store, flags: Flags, values: any, entries: ProjectEntry[]): Promise<number> {
	console.log(`Applying ${entries.length} project(s)\n`);
	const results: Array<{ name: string; ok: boolean }> = [];
	for (const { name, project } of entries) {
		console.log(`\n──────── ${name}`);
		const domainName = String(project.domain ?? "").trim().toLowerCase();
		const roles = loadRoles(values, project, flags);
		if (!domainName) {
			console.log("  ✗ project has no domain");
			results.push({ name, ok: false });
			continue;
		}
		if (roles.length === 0) {
			console.log("  ✗ project has no mailboxes");
			results.push({ name, ok: false });
			continue;
		}
		try {
			results.push({ name, ok: (await run(makeContext(store, flags, project, domainName), roles)) === 0 });
		} catch (error) {
			console.log(`  ✗ ${message(error)}`);
			results.push({ name, ok: false });
		}
	}

	const failed = results.filter((result) => !result.ok);
	console.log("\n──────── summary");
	for (const result of results) console.log(`  ${result.ok ? "✓" : "✗"} ${result.name}`);
	console.log(`\n${results.length - failed.length}/${results.length} project(s) ok`);
	return failed.length === 0 ? 0 : 1;
}
