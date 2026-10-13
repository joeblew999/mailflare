// Running the documents of ONE server: the instance document, then its tenants.
import { makeContext, type ProjectScope } from "./context";
import { declaredResources, run } from "./driver";
import { validateSpec } from "./validate";
import { message } from "./wrangler";
import type { SpecEntry } from "./document";
import type { Flags } from "./flags";
import type { Change } from "./resources/resource";
import type { Store } from "./store/types";
import type { Vault } from "./vault";

/** `pending` is a preview with work left to do: not as wanted yet, but nothing went wrong. */
export type DocResult = { name: string; ok: boolean; pending?: boolean; /** What the run saw or did. */ changes?: Change[] };

/** Run at most `max` things at once. One limiter is shared by every server in a run. */
export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;
export function limiter(max: number): Limiter {
	let active = 0;
	const waiting: Array<() => void> = [];
	return async (fn) => {
		// A freed slot is handed straight to the next in line, so the count never overshoots.
		if (active < max) active += 1;
		else await new Promise<void>((go) => waiting.push(go));
		try {
			return await fn();
		} finally {
			const next = waiting.shift();
			if (next) next();
			else active -= 1;
		}
	};
}

export type RunOptions = {
	limit?: Limiter;
	print?: (text: string) => void;
	/** Print each document whole when it finishes, so parallel output stays readable. */
	buffered?: boolean;
	/** Where the logins and keys this run creates are written. */
	vault?: Vault;
	/** These are ALL of the server's documents, so what none of them declares is undeclared. */
	complete?: boolean;
};

export async function runDocuments(store: Store, flags: Flags, entries: SpecEntry[], { limit = limiter(1), print = console.log, buffered = false, vault, complete = false }: RunOptions = {}): Promise<DocResult[]> {
	// The instance document carries what the tenants depend on (the licence gates accounts and
	// shared mailboxes), so it goes first and alone - and last when everything is coming down.
	const instance = entries.filter((entry) => !entry.spec.domain);
	const tenants = entries.filter((entry) => entry.spec.domain);
	const ordered = flags.cleanup ? [...tenants, ...instance] : [...instance, ...tenants];
	// An instance with no users cannot be driven at all: its first document gives it an admin.
	// Only a count of exactly zero says so - a database that cannot be read is not an empty one.
	const empty = !flags.cleanup && !flags.fresh && ((await store.userCount()) ?? 0) === 0;
	// A reset wipes ONCE, before anything: in the first document, which configures the admin.
	const resets = flags.fresh || empty ? ordered[0] : undefined;

	const scope: ProjectScope | null = complete
		? {
			domains: new Set(tenants.map((entry) => String(entry.spec.domain).trim().toLowerCase())),
			keys: entries.some((entry) => entry.spec.mcpKeys !== undefined) ? new Set(entries.flatMap((entry) => (entry.spec.mcpKeys ?? []).map((key) => String(key.name ?? "agent").trim()))) : null,
		}
		: null;

	const one = async (entry: SpecEntry): Promise<DocResult> => {
		const lines: string[] = [];
		const log = buffered ? (line: string) => void lines.push(line) : print;
		log(`\n──────── ${entry.name}`);
		let ok = false;
		let pending = false;
		let changes: Change[] = [];
		try {
			const problems = validateSpec(entry.spec);
			if (problems.length > 0) log(`  ✗ not a valid document:\n${problems.map((problem) => `      ${problem}`).join("\n")}`);
			else if (resets && flags.status && entry !== resets) {
				log("  + everything declared  applied from nothing, once the instance has its admin");
				pending = true;
			} else {
				const ctx = makeContext(store, { ...flags, fresh: flags.fresh && entry === resets }, entry.spec, { log, vault, bootstrap: empty && entry === resets, project: entry === instance[0] ? scope : null });
				if (declaredResources(ctx).length === 0) log("  · nothing declared for this verb");
				ok = (await run(ctx)) === 0;
				pending = !ok && (flags.status || ctx.unapproved) && !ctx.failed;
				changes = ctx.changes;
			}
		} catch (error) {
			log(`  ✗ ${message(error)}`);
		}
		if (buffered) print(lines.join("\n"));
		return { name: entry.name, ok, pending, changes };
	};

	const results = new Map<SpecEntry, DocResult>();
	const serial = async (list: SpecEntry[]) => {
		for (const entry of list) results.set(entry, await limit(() => one(entry)));
	};
	const parallel = async (list: SpecEntry[]) => {
		await Promise.all(list.map(async (entry) => results.set(entry, await limit(() => one(entry)))));
	};
	if (flags.cleanup) {
		await parallel(tenants);
		await serial(instance);
	} else {
		// Whatever resets goes alone and first, then the rest of the instance layer, then the tenants.
		const alone = [...new Set([...(resets ? [resets] : []), ...instance])];
		await serial(alone);
		await parallel(tenants.filter((entry) => !alone.includes(entry)));
	}
	return ordered.map((entry) => results.get(entry)!);
}
