/* eslint-disable @typescript-eslint/no-explicit-any -- CLI values are untyped option bags. */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../joeblew999-lib";

// Mass mode: apply every project manifest in the directory, each in its own process
// so one project's failure cannot disturb another's run.
export async function runAll(values: any): Promise<number> {
	const dir = values.dir;
	let files: string[];
	try {
		files = readdirSync(dir)
			.filter((name) => /^joeblew999-project\..*\.json$/.test(name))
			.sort()
			.map((name) => join(dir, name));
	} catch (error) {
		console.error(`Could not read ${dir}: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	if (files.length === 0) {
		console.error(`No joeblew999-project.*.json manifests in ${dir}.`);
		return 1;
	}

	const passthrough: string[] = [];
	for (const flag of ["dry-run", "status", "cleanup", "onboard", "replace-mx", "confirm-mx", "share", "disable-accounts", "remove-domain"]) {
		if (values[flag]) passthrough.push(`--${flag}`);
	}
	if (values.url) passthrough.push("--url", values.url);
	if (values.db) passthrough.push("--db", values.db);
	if (values.local) passthrough.push("--local");

	const entry = fileURLToPath(new URL("../joeblew999-provision.ts", import.meta.url));
	console.log(`Applying ${files.length} project(s) from ${dir}${passthrough.length > 0 ? ` (${passthrough.join(" ")})` : ""}\n`);

	const results: Array<{ file: string; ok: boolean }> = [];
	for (const file of files) {
		console.log(`\n──────── ${file}`);
		const result = run("npx", ["tsx", entry, "--project", file, ...passthrough]);
		process.stdout.write(result.stdout ?? "");
		process.stderr.write(result.stderr ?? "");
		results.push({ file, ok: result.status === 0 });
	}

	const failed = results.filter((r) => !r.ok);
	console.log("\n──────── summary");
	for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.file}`);
	console.log(`\n${results.length - failed.length}/${results.length} project(s) ok`);
	return failed.length === 0 ? 0 : 1;
}
