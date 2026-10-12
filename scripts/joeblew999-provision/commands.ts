/* eslint-disable @typescript-eslint/no-explicit-any -- external HTTP JSON. */
import { sqlEscape } from "../joeblew999-lib";
import { ensureDomain, removeDomain } from "./domain";
import { syncMailboxes } from "./mailboxes";
import { ensureAccount, disableAccount } from "./accounts";
import { ensureRouting, removeRouting } from "./routing";
import { ensureMcpKey, removeMcpKey } from "./mcp-keys";
import type { Context, Role } from "./types";

// Read-only drift report: what the manifest wants vs what exists.
async function reportStatus(ctx: Context, roles: Role[]): Promise<number> {
	const boxes = await ctx.api("/api/v1/mailboxes");
	const present = new Map<string, any>(
		(boxes.json?.mailboxes ?? [])
			.filter((entry: any) => String(entry.hostname).toLowerCase() === ctx.domainName)
			.map((entry: any) => [String(entry.localPart).toLowerCase(), entry]),
	);
	console.log(`Status for ${ctx.domainName} — ${roles.length} mailbox(es) wanted:\n`);
	let missing = 0;
	for (const { role, share, access } of roles) {
		const box = present.get(role);
		if (!box) missing += 1;
		console.log(`  ${box ? "✓" : "✗"} ${role}@${ctx.domainName}${share ? " (shared)" : ""}${box ? ` — ${box.type}` : " — missing"}`);
		for (const grant of access) {
			const email = String(grant.email ?? "").toLowerCase();
			const permission = String(grant.permission ?? "full_access");
			const [user] = ctx.d1(`SELECT id FROM users WHERE lower(email)='${sqlEscape(email)}' LIMIT 1;`);
			const [row] = user && box ? ctx.d1(`SELECT permission FROM mailbox_access WHERE mailbox_id='${sqlEscape(box.id)}' AND user_id='${sqlEscape(user.id)}';`) : [];
			const ok = row?.permission === permission;
			if (!ok) missing += 1;
			console.log(`      ${ok ? "✓" : "✗"} ${email} → ${permission}${row ? ` (is ${row.permission})` : ""}`);
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

	if (!ctx.flags.dryRun) console.log(`\nMailboxes: ${ctx.base}/mailboxes`);
	return failures === 0 ? 0 : 1;
}
