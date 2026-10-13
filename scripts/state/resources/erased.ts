import { parseBackup, scrub, type Who } from "../backup";
import { digestOf, subjectTotal, tombstones } from "../subject-scope";
import type { Context } from "../context";
import type { Item, Resource } from "./resource";
import type { SettingsRow, Store, SubjectReport } from "../store/types";

/** Where the app keeps its backups in the bucket. */
export const BACKUP_PREFIX = "backups/database/";

/** Every backup the server holds: what is in the bucket, and what the app has a record of. */
export async function backupKeys(store: Store): Promise<Map<string, SettingsRow | undefined>> {
	const recorded = new Map((await store.rows("backups", {})).filter((row) => row.r2_key).map((row) => [String(row.r2_key), row]));
	// The bucket is the truth. A restore replaces the app's records with older ones, so a
	// backup can be sitting there with no record of it at all.
	const keys = new Set([...(await store.listObjects(BACKUP_PREFIX)), ...recorded.keys()]);
	return new Map([...keys].sort().map((key) => [key, recorded.get(key)]));
}

/**
 * Take people out of every backup the server holds. A backup that held them is rewritten
 * without them; one that cannot be rewritten safely - or cannot be read at all - is deleted,
 * since a backup nobody can check is one that may hold them. `seen` is skipped and added to.
 */
export async function scrubBackups(store: Store, who: Who, seen = new Set<string>()): Promise<{ rewritten: number; deleted: number; clean: number }> {
	const done = { rewritten: 0, deleted: 0, clean: 0 };
	for (const [key, record] of await backupKeys(store)) {
		if (seen.has(key)) continue;
		seen.add(key);
		const content = await store.readObject(key);
		const document = content === null ? null : parseBackup(content);
		const result = document ? scrub(document, who) : null;
		if (document && result && !result.unsafe) {
			if (result.removed === 0) done.clean += 1;
			else {
				const rewritten = JSON.stringify(document);
				await store.writeObject(key, rewritten, "application/json");
				if (record) await store.updateRows("backups", { id: record.id }, { size: Buffer.byteLength(rewritten) });
				done.rewritten += 1;
			}
			continue;
		}
		// The record goes with the object, or the app would list a backup it cannot download.
		if (content !== null) await store.deleteObjects([key]);
		if (record) await store.deleteRows("backups", { id: record.id });
		done.deleted += 1;
	}
	return done;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const holding = (report: SubjectReport) => `an account, ${plural(report.mailboxIds.length, "mailbox", "mailboxes")}, ${plural(subjectTotal(report), "row")}, ${plural(report.objects, "object")} — and they are taken out of every backup`;

/** Everything of one person's, everywhere this server keeps it. The account row goes last. */
export async function erasePerson(ctx: Context, report: SubjectReport): Promise<string> {
	const who: Who = { digests: [digestOf(report.email)], userIds: [report.userId!], mailboxIds: report.mailboxIds };
	// Backups first, the account last: while the account is there, a run that stops is taken up
	// again, so nothing is left half done behind a plan that says there is nothing to do.
	const seen = new Set<string>();
	const before = await scrubBackups(ctx.store, who, seen);
	const erased = await ctx.store.eraseSubject(report.email);
	// A backup taken while this ran holds them too.
	const during = await scrubBackups(ctx.store, who, seen);
	ctx.vault.forgetPerson(report.email);
	const rewritten = before.rewritten + during.rewritten;
	const deleted = before.deleted + during.deleted;
	return `erased: ${plural(subjectTotal(report), "row")}, ${plural(erased.objectsDeleted, "object")}${rewritten > 0 ? `, ${plural(rewritten, "backup")} rewritten without them` : ""}${deleted > 0 ? `, ${plural(deleted, "backup")} deleted (could not be rewritten)` : ""}`;
}

// A tombstone: someone who must not exist here. It is checked on every run, so a restore that
// brings them back is a line in the next plan - which is what makes an erasure last.
export const erasedResource: Resource = {
	section: "erased",
	declared: (ctx) => ctx.spec.erased !== undefined,
	async items(ctx) {
		const stones = tombstones(ctx.spec);
		if (stones.length === 0) return [];
		// Who is on the server, by the digest of their address: a tombstone may keep no address.
		const present = new Map((await ctx.store.rows("users", {})).map((row) => [digestOf(String(row.email ?? "")), String(row.email ?? "").toLowerCase()]));
		const items: Item[] = [];
		for (const stone of stones) {
			const email = present.get(stone.digest);
			const report = email ? await ctx.store.subjectReport(email) : null;
			const found = report?.userId ? report : null;
			items.push({
				address: `erased.${stone.label}`,
				undeclared: true,
				removal: "declared erased",
				wants: found ? holding(found) : undefined,
				problem: found && found.blockers.length > 0 ? `cannot be erased: ${found.blockers.join("; ")}` : undefined,
				actual: async () => found,
				remove: async (here) => erasePerson(ctx, here as SubjectReport),
			});
		}
		return items;
	},
};

/** The digests a document declares erased, for whoever must leave those people alone. */
export const erasedDigests = (ctx: Context): Set<string> => new Set(tombstones(ctx.spec).map((stone) => stone.digest));
