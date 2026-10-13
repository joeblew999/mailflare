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
		need: "each server is built from its own config",
		where: "vite.config.ts (cloudflare configPath)",
		why: "the Vite plugin fixes a Worker's bindings at build time and reads one config. It now takes MAILFLARE_WRANGLER_CONFIG, so every server is the same code with its own database, bucket and queues.",
		anchors: [{ file: "vite.config.ts", says: "MAILFLARE_WRANGLER_CONFIG" }],
	},
];

export const SOURCE_CHANGES: SourceChange[] = [
	{
		need: "backup history cannot be selectively erased",
		where: "src/lib/backups/ (the writer), plus restore",
		why: "a backup document holds every subject, so rewriting one would destroy other people's data. The fix is crypto-shredding: a per-subject key whose destruction IS the erasure, which only the app can implement.",
	},
	{
		need: "ai_usage rows cannot be attributed to a person",
		where: "src/db/schema/index.ts:755 (aiUsage)",
		why: "the table has no user/owner column, so erasure cannot find its rows. Add the column (and populate it) to bring them into scope.",
		anchors: [{ file: "src/db/schema/index.ts", line: 755, says: "aiUsage" }],
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
