import { onboardBody } from "./document";
import { requireDomain } from "./context";
import { removeMcpKey } from "./resources/mcp-keys";
import { disableAccount } from "./resources/accounts";
import type { ApiDomain, Context, Role } from "./types";

export const findDomain = (list: ApiDomain[], name: string) =>
	list.find((entry) => String(entry.hostname).toLowerCase() === name);

// Resolve the domain, then act on the flags when it is missing: teardown-only,
// report, or onboard (MX-guarded). Returns null to continue, or an exit code to stop.
export async function ensureDomain(ctx: Context, roles: Role[]): Promise<number | null> {
	ctx.domain = findDomain(await ctx.store.listDomains(), ctx.domainName) ?? null;
	if (ctx.domain) return null;

	// Re-runnable teardown: with the domain gone there is nothing domain-scoped left
	// (mailboxes/routing cascade with it), but the keys and accounts still need it.
	if (ctx.flags.cleanup) {
		console.log(`${ctx.domainName} is not in Mailflare — finishing account/key teardown only.`);
		let failures = 0;
		for (const entry of ctx.project?.mcpKeys ?? []) failures += removeMcpKey(ctx, entry);
		if (ctx.flags.disableAccounts) {
			for (const account of ctx.project?.accounts ?? []) failures += await disableAccount(ctx, account);
		}
		return failures === 0 ? 0 : 1;
	}

	if (ctx.flags.status) {
		console.log(`✗ ${ctx.domainName} is not onboarded in Mailflare.`);
		return 1;
	}

	const onboard = ctx.flags.onboard || Boolean(ctx.project?.onboard);
	if (!onboard) {
		console.error(`"${ctx.domainName}" is not onboarded in Mailflare.`);
		console.error("Add it under Admin → Domains, or pass --onboard to add it now (this publishes MX).");
		return 1;
	}

	const mx = await ctx.store.currentMx(ctx.domainName);
	if (mx?.length) {
		console.log(`  ⚠ ${ctx.domainName} already has MX records — onboarding changes where its mail goes:`);
		for (const record of mx) console.log(`      ${record.priority ?? ""} ${record.content}`);
	}
	if (ctx.flags.dryRun) {
		const extras = `${ctx.project?.accounts?.length ? ` + ${ctx.project.accounts.length} account(s)` : ""}${ctx.project?.routing?.length ? ` + ${ctx.project.routing.length} routing rule(s)` : ""}`;
		console.log(`  → would onboard ${ctx.domainName}, then create ${roles.map(({ role }) => `${role}@${ctx.domainName}`).join(", ")}${extras}`);
		return 0;
	}
	if (mx?.length && !ctx.flags.confirmMx) {
		console.error(`\nRefusing to onboard ${ctx.domainName}: it already receives mail.`);
		console.error("Re-run with --confirm-mx to knowingly take over its MX, or pick a domain with no mail.");
		return 1;
	}

	console.log(`Onboarding ${ctx.domainName} into Mailflare…`);
	const added = await ctx.store.onboardDomain(onboardBody(ctx.project, ctx.flags, ctx.domainName));
	if (added.status !== 200 && added.status !== 201) {
		console.error(`Could not onboard ${ctx.domainName}: HTTP ${added.status} ${added.json?.error ?? ""}`);
		return 1;
	}
	ctx.domain = findDomain(await ctx.store.listDomains(), ctx.domainName) ?? null;
	if (!ctx.domain) {
		console.error(`Onboarded ${ctx.domainName} but it is not listed afterwards.`);
		return 1;
	}
	return null;
}

// Removing the domain (app API) also drops its Email Routing/DNS config.
export async function removeDomain(ctx: Context): Promise<number> {
	if (ctx.flags.dryRun) {
		console.log(`  → would remove domain ${ctx.domainName} from Mailflare (drops its DNS/MX)`);
		return 0;
	}
	const res = await ctx.store.removeDomain(requireDomain(ctx).id);
	console.log(`  ${res.status === 200 ? "✓ removed" : `✗ remove failed (HTTP ${res.status})`} domain ${ctx.domainName}`);
	return res.status === 200 ? 0 : 1;
}
