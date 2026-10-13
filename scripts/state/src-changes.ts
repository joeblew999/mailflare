// `src/` is the product, and this system drives it from outside: through its HTTP API and its
// database. Where that is not enough, the gap is recorded here - what is still NEEDED, and what
// was MADE because a fleet cannot work without it. A test holds every entry to the code.
export type SourceChange = {
	/** What cannot be done from the scripts. */
	need: string;
	/** Where the change goes. */
	where: string;
	/** Why it cannot be worked around, or what the workaround is. */
	why: string;
	/** What the claim rests on: a word the file (or that line of it) must still contain. */
	anchors?: Array<{ file: string; says: string; line?: number }>;
};

/** Changes made in the app for the fleet. Reverting one breaks every server but the default. */
export const SOURCE_CHANGES_MADE: SourceChange[] = [
	{
		need: "each server delivers mail to its own Worker",
		where: "src/lib/cloudflare-api-utils.ts (getEmailWorkerName)",
		why: 'it returned "mailflare" for everyone, so a second server\'s Email Routing rules delivered its mail to the first. It now reads MAILFLARE_WORKER_NAME, which each generated config sets.',
		anchors: [{ file: "src/lib/cloudflare-api-utils.ts", says: "MAILFLARE_WORKER_NAME" }],
	},
	{
		need: "realtime Durable Objects stay in the server's jurisdiction",
		where: "src/lib/realtime/utils.ts (realtimeNamespace), used by worker.ts",
		why: "a Durable Object lives wherever it is first reached unless its namespace is pinned. It is now pinned to MAILFLARE_JURISDICTION when a server declares one.",
		anchors: [{ file: "src/lib/realtime/utils.ts", says: "MAILFLARE_JURISDICTION" }, { file: "worker.ts", says: "realtimeNamespace(env)" }],
	},
	{
		need: "a backup can be made at all",
		where: "src/lib/backups/export.ts (BACKUP_TABLES), table-groups.ts, types.d.ts",
		why: "a backup aborts when the database has a table the list does not name, and four had been added since (drive_items, drive_shares, drive_upload_parts, push_subscriptions): every backup failed. They are listed now, so backups run, and restore them.",
		anchors: [{ file: "src/lib/backups/export.ts", says: '"drive_items", "drive_shares", "drive_upload_parts", "push_subscriptions"' }, { file: "src/lib/backups/table-groups.ts", says: '"push_subscriptions"' }],
	},
	{
		need: "a backup can be restored on a server that is being used",
		where: "src/lib/backups/export.ts (createInsertStatement)",
		why: "a restore empties every table and then inserts, in many separate statements. Any request in between re-creates the default licence row, the restore's INSERT then failed on it, and the database was left half restored. It inserts OR REPLACE now, so a row made in the meantime is overwritten rather than fatal.",
		anchors: [{ file: "src/lib/backups/export.ts", says: "INSERT OR REPLACE INTO" }],
	},
	{
		need: "mail that is stored for nobody leaves nothing behind",
		where: "src/lib/email/inbound.ts (processInboundMessage)",
		why: "the raw message is written to the bucket before it is queued, and was left there forever when no mailbox took it — so mail to someone erased, or to nobody at all, piled up with no row pointing at it. It is deleted when the message is dropped.",
		anchors: [{ file: "src/lib/email/inbound.ts", says: "discardRaw" }],
	},
];

/** Named, because the report on a person points at it. */
export const AI_USAGE_UNATTRIBUTABLE: SourceChange = {
	need: "ai_usage rows cannot be attributed to a person",
	where: "src/db/schema/index.ts:755 (aiUsage)",
	why: "the table has no user/owner column, so erasure cannot find its rows. Add the column (and populate it) to bring them into scope.",
	anchors: [{ file: "src/db/schema/index.ts", line: 755, says: "aiUsage" }],
};

export const SOURCE_CHANGES: SourceChange[] = [
	AI_USAGE_UNATTRIBUTABLE,
	{
		need: "the app cannot delete an account",
		where: "src/app/api/v1/accounts/[id]/utils.ts",
		why: "an account can be disabled and nothing more, so a person is erased in the database, by a scope this system keeps by hand and a test holds to the schema. A DELETE that cleans the bucket too would make that the app's own.",
	},
	{
		need: "a restore replaces the app's record of its backups",
		where: "src/lib/backups/export.ts (restoreDatabaseRecords)",
		why: "`backups` is itself a backed-up table, so after a restore every backup made since is in the bucket with no record: never listed, never expired. This system finds backups by listing the bucket; the app would have to keep the table out of a restore.",
		anchors: [{ file: "src/lib/backups/export.ts", says: '"backups"' }],
	},
	{
		need: "a domain's sending and receiving providers cannot be changed after it is onboarded",
		where: "src/app/api/v1/domains/[id]/route.ts",
		why: "the key-authenticated API can add and remove a domain but not update one, so `onboard` applies when the domain is first added. Switch providers on the Domains page, or add a PATCH.",
	},
	{
		need: "a mailbox cannot change between personal and shared",
		where: "src/app/api/v1/mailboxes/[id]/utils.ts (PATCH)",
		why: "updateMailboxSchema has no type, so a mailbox of the wrong kind is reported as a problem rather than converted. Delete and recreate it, or add the field.",
	},
];

/** Print one, in a shape that is easy to grep in a transcript or a report. */
export function sourceChangeNeeded(change: SourceChange): void {
	console.log(`  ⚠ SOURCE CHANGE NEEDED — ${change.need}`);
	console.log(`     where: ${change.where}`);
	console.log(`     why:   ${change.why}`);
}

export function printSourceChanges(): void {
	console.log("Still needed in src/ — this system works around each, or reports it:\n");
	for (const change of SOURCE_CHANGES) {
		sourceChangeNeeded(change);
		console.log("");
	}
	console.log("Made in src/ for the fleet — do not revert:\n");
	for (const change of SOURCE_CHANGES_MADE) console.log(`  ✓ ${change.need}\n     where: ${change.where}\n     why:   ${change.why}\n`);
}
