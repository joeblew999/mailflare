import { ensureDomain, removeDomain } from "./domain";
import { mailboxesForDomain, syncMailboxes } from "./mailboxes";
import { ensureAccount, disableAccount } from "./accounts";
import { ensureRouting, removeRouting } from "./routing";
import { ensureMcpKey, removeMcpKey } from "./mcp-keys";
import type { Context, Role } from "./types";

// Read-only drift report: what the manifest wants vs what exists.
async function reportStatus(ctx: Context, roles: Role[]): Promise<number> {
	const present = await mailboxesForDomain(ctx);
	console.log(`Status for ${ctx.domainName} — ${roles.length} mailbox(es) wanted:\n`);
	let missing = 0;
	for (const { role, share, access } of roles) {
		const box = present.get(role);
		if (!box) missing += 1;
		console.log(`  ${box ? "✓" : "✗"} ${role}@${ctx.domainName}${share ? " (shared)" : ""}${box ? ` — ${box.type}` : " — missing"}`);
		for (const grant of access) {
			const email = String(grant.email ?? "").toLowerCase();
			const permission = String(grant.permission ?? "full_access");
			const userId = ctx.store.userIdByEmail(email);
			const actual = box && userId ? ctx.store.accessPermission(box.id, userId) : null;
			const ok = actual === permission;
			if (!ok) missing += 1;
			console.log(`      ${ok ? "✓" : "✗"} ${email} → ${permission}${actual ? ` (is ${actual})` : ""}`);
		}
	}
	console.log(missing === 0 ? "\nEverything provisioned." : `\n${missing} item(s) missing — run without --status to apply.`);
	return missing === 0 ? 0 : 1;
}

// One full run: resolve/onboard the domain, then mailboxes, then accounts/routing/mcp.
export async function run(ctx: Context, roles: Role[]): Promise<number> {
	const early = await ensureDomain(ctx, roles);
	if (early !== null) return early;
	if (ctx.flags.status) return await reportStatus(ctx, roles);

	const { failures: mailboxFailures, mailboxIdsByRole } = await syncMailboxes(ctx, roles);
	let failures = mailboxFailures;

	const accounts = ctx.project?.accounts ?? [];
	const routing = ctx.project?.routing ?? [];
	const mcpKeys = ctx.project?.mcpKeys ?? [];
	if (accounts.length || routing.length || mcpKeys.length) console.log("");

	if (ctx.flags.cleanup) {
		for (const rule of routing) failures += removeRouting(ctx, rule);
		for (const entry of mcpKeys) failures += removeMcpKey(ctx, entry);
		if (ctx.flags.disableAccounts) {
			for (const account of accounts) failures += await disableAccount(ctx, account);
		}
		if (ctx.flags.removeDomain) failures += await removeDomain(ctx);
	} else {
		for (const account of accounts) failures += await ensureAccount(ctx, account);
		for (const rule of routing) failures += ensureRouting(ctx, rule, mailboxIdsByRole);
		for (const entry of mcpKeys) failures += ensureMcpKey(ctx, entry, mailboxIdsByRole);
	}

	if (!ctx.flags.dryRun) console.log(`\nMailboxes: ${ctx.store.base}/mailboxes`);
	return failures === 0 ? 0 : 1;
}
