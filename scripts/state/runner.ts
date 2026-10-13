/* eslint-disable @typescript-eslint/no-explicit-any -- CLI values are untyped option bags. */
// Applying MANY documents. A multi-document file is loaded once, ONE admin key covers
// the whole run, and the documents are reconciled in this process. (Spawning a child
// per document would re-resolve the instance and re-mint a key each time - fine for
// five domains, thousands of processes for thousands of domains.) A document that
// throws is recorded and the run continues.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeContext } from "./context";
import { run } from "./driver";
import { loadSpec, rolesFor } from "./document";
import type { Flags } from "./flags";
import type { Spec } from "./spec";
import type { Store } from "./store/types";

export type SpecEntry = { name: string; spec: Spec };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// `spec` is one document, or one file holding `{ "specs": [ ...document ] }`. `dir`
// scans for per-domain documents, which is how the checked-in ones are stored.
export function loadSpecs({ spec, dir }: { spec?: string; dir: string }): SpecEntry[] {
	if (spec) {
		let parsed: any;
		try {
			parsed = JSON.parse(readFileSync(spec, "utf8"));
		} catch (error) {
			throw new Error(`Could not read spec file ${spec}: ${message(error)}`);
		}
		const list: Spec[] = Array.isArray(parsed?.specs) ? parsed.specs : [parsed];
		if (list.length === 0) throw new Error(`${spec} lists no specs`);
		return list.map((document, index) => ({ name: String(document?.domain ?? `${spec}#${index + 1}`), spec: document }));
	}

	const files = readdirSync(dir)
		.filter((name) => name.endsWith(".json") && !name.startsWith("_") && name !== "example.json")
		.sort();
	if (files.length === 0) throw new Error(`No documents in ${dir} (expected *.json; example.json and _*.json are skipped).`);
	return files.map((name) => ({ name: join(dir, name), spec: loadSpec(join(dir, name)) }));
}

export async function runSpecs(store: Store, flags: Flags, values: any, entries: SpecEntry[]): Promise<number> {
	// Opt-in: one at a time by default, so the output stays readable and D1 is not hammered.
	// Thousands of documents want a few in flight, not one.
	const limit = Math.max(1, Number(values.concurrency ?? 1) || 1);
	console.log(`Applying ${entries.length} document(s)${limit > 1 ? `, ${limit} at a time` : ""}\n`);

	const applyOne = async ({ name, spec }: SpecEntry): Promise<{ name: string; ok: boolean }> => {
		console.log(`\n──────── ${name}`);
		const domainName = String(spec.domain ?? "").trim().toLowerCase();
		const roles = rolesFor(values, spec, flags);
		const global = flags.fresh || flags.plan !== undefined || flags.push || Boolean(spec.fresh) || Boolean(spec.license) || Boolean(spec.push);
		if (!domainName && !global) {
			console.log("  ✗ no domain, and the document asks for nothing global");
			return { name, ok: false };
		}
		if (domainName && roles.length === 0 && !global) {
			console.log("  ✗ no mailboxes in the document");
			return { name, ok: false };
		}
		try {
			return { name, ok: (await run(makeContext(store, flags, spec, domainName), roles)) === 0 };
		} catch (error) {
			console.log(`  ✗ ${message(error)}`);
			return { name, ok: false };
		}
	};

	const results: Array<{ name: string; ok: boolean }> = [];
	for (let index = 0; index < entries.length; index += limit) {
		results.push(...(await Promise.all(entries.slice(index, index + limit).map(applyOne))));
	}

	const failed = results.filter((result) => !result.ok);
	console.log("\n──────── summary");
	for (const result of results) console.log(`  ${result.ok ? "✓" : "✗"} ${result.name}`);
	console.log(`\n${results.length - failed.length}/${results.length} document(s) ok`);
	return failed.length === 0 ? 0 : 1;
}
