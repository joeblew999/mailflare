// HARD CONSTRAINT: this system must never modify `src/`. It drives the application through
export type SourceChange = {
	/** What cannot be done from the scripts. */
	need: string;
	/** Exactly where the change would go. */
	where: string;
	/** Why it cannot be worked around, or what the workaround is. */
	why: string;
};

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
	},
	{
		need: "the realtime Durable Object is not jurisdiction-pinned",
		where: "worker.ts:44 and src/lib/realtime/utils.ts:61",
		why: "getByName() accepts a jurisdiction. Without it a user's realtime state may run outside their region, which is the residency guarantee we would be claiming.",
	},
];

/** Print one, in a shape that is easy to grep in a transcript or a report. */
export function sourceChangeNeeded(change: SourceChange): void {
	console.log(`  ⚠ SOURCE CHANGE NEEDED — ${change.need}`);
	console.log(`     where: ${change.where}`);
	console.log(`     why:   ${change.why}`);
}

export function printSourceChanges(): void {
	console.log("Source changes this system cannot make (it must not modify src/):\n");
	for (const change of SOURCE_CHANGES) {
		sourceChangeNeeded(change);
		console.log("");
	}
	console.log("Everything else is implemented in scripts/state/. Where a workaround exists it is used.");
}
