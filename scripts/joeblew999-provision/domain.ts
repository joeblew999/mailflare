import { cfApi, keychain } from "../joeblew999-lib";
import { onboardBody } from "./manifest";
import { requireDomain } from "./context";
import { removeMcpKey } from "./mcp-keys";
import { disableAccount } from "./accounts";
import type { ApiDomain, Context, Role } from "./types";

export const findDomain = (list: ApiDomain[] | undefined, name: string) => (list ?? []).find((entry) => String(entry.hostname).toLowerCase() === name);

// The domain's current MX records, from the Cloudflare API (null when unavailable).
// Used to refuse taking over a domain that already receives mail.
export async function currentMx(hostname: string) {
	const token = process.env.CLOUDFLARE_API_TOKEN?.trim() || keychain("CLOUDFLARE_API_TOKEN");
	if (!token) return null;
	const zone = await cfApi<Array<{ id: string }>>(`/zones?name=${encodeURIComponent(hostname)}`, token);
	const zoneId = zone?.result?.[0]?.id;
	if (!zoneId) return null;
	const records = await cfApi<Array<{ priority?: number; content?: string }>>(`/zones/${zoneId}/dns_records?type=MX&per_page=100`, token);
	return records?.result ?? null;
}

// Resolve the domain, then act on the flags when it is missing: teardown-only,
// report, or onboard (MX-guarded). Returns null to continue, or an exit code to stop.
export async function ensureDomain(ctx: Context, roles: Role[]): Promise<number | null> {
	const listed = await ctx.api("/api/v1/domains");
	ctx.domain = findDomain(listed.json?.domains, ctx.domainName) ?? null;
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

	const mx = await currentMx(ctx.domainName);
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
	const added = await ctx.api("/api/v1/domains", { method: "POST", body: onboardBody(ctx.project, ctx.flags, ctx.domainName) });
	if (added.status !== 200 && added.status !== 201) {
		console.error(`Could not onboard ${ctx.domainName}: HTTP ${added.status} ${added.json?.error ?? ""}`);
		return 1;
	}
	const refreshed = await ctx.api("/api/v1/domains");
	ctx.domain = findDomain(refreshed.json?.domains, ctx.domainName) ?? null;
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
	const res = await ctx.api(`/api/v1/domains/${requireDomain(ctx).id}`, { method: "DELETE" });
	console.log(`  ${res.status === 200 ? "✓ removed" : `✗ remove failed (HTTP ${res.status})`} domain ${ctx.domainName}`);
	return res.status === 200 ? 0 : 1;
}
