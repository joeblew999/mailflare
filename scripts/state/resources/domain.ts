import { requireDomain } from "../context";
import { onboardBody } from "../document";
import type { Context } from "../context";
import type { ApiDomain, Role } from "../spec";
import type { Resource } from "./resource";

export const findDomain = (list: ApiDomain[], name: string) =>
	list.find((entry) => String(entry.hostname).toLowerCase() === name);

/**
 * Resolve the document's domain, onboarding it only when this is a create run.
 * Returns 0 to continue, or an exit code to stop.
 *
 * The document-scoped resources all act on this domain, so this is a PREREQUISITE
 * (see registry.ts). It no longer doubles as a teardown path: under --cleanup every
 * other resource runs its own remove(), so there is nothing to do here when the
 * domain is already gone.
 */
export async function ensureDomain(ctx: Context, roles: Role[]): Promise<number> {
	ctx.domain = findDomain(await ctx.store.listDomains(), ctx.domainName) ?? null;
	if (ctx.domain) return 0;
	if (ctx.flags.cleanup) return 0;

	if (ctx.flags.status) {
		console.log(`✗ ${ctx.domainName} is not onboarded in Mailflare.`);
		return 1;
	}

	const onboard = Boolean(ctx.spec?.onboard);
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
		const extras = `${ctx.spec?.accounts?.length ? ` + ${ctx.spec.accounts.length} account(s)` : ""}${ctx.spec?.routing?.length ? ` + ${ctx.spec.routing.length} routing rule(s)` : ""}`;
		console.log(`  → would onboard ${ctx.domainName}, then create ${roles.map(({ role }) => `${role}@${ctx.domainName}`).join(", ")}${extras}`);
		return 0;
	}
	if (mx?.length && !ctx.flags.confirmMx) {
		console.error(`\nRefusing to onboard ${ctx.domainName}: it already receives mail.`);
		console.error("Re-run with --confirm-mx to knowingly take over its MX, or pick a domain with no mail.");
		return 1;
	}

	console.log(`Onboarding ${ctx.domainName} into Mailflare…`);
	const added = await ctx.store.onboardDomain(onboardBody(ctx.spec, ctx.flags, ctx.domainName));
	if (added.status !== 200 && added.status !== 201) {
		console.error(`Could not onboard ${ctx.domainName}: HTTP ${added.status} ${added.json?.error ?? ""}`);
		return 1;
	}
	ctx.domain = findDomain(await ctx.store.listDomains(), ctx.domainName) ?? null;
	if (!ctx.domain) {
		console.error(`Onboarded ${ctx.domainName} but it is not listed afterwards.`);
		return 1;
	}
	return 0;
}

// Removing the domain (app API) also drops its Email Routing/DNS config.
export async function removeDomain(ctx: Context): Promise<number> {
	if (ctx.flags.dryRun) {
		console.log(`  → would remove domain ${ctx.domainName} from Mailflare (drops its DNS/MX)`);
		return 0;
	}
	const res = await ctx.store.removeDomain(requireDomain(ctx).id);
	console.log(`${res.status === 200 ? "✓ removed" : `✗ remove failed (HTTP ${res.status})`} domain ${ctx.domainName}`);
	return res.status === 200 ? 0 : 1;
}

// The prerequisite resource: included whenever anything domain-scoped is declared
// (the registry decides that, so `declared` is never consulted for it).
export const domainResource: Resource = {
	section: "domain",
	needsDomain: false,
	abortOnFailure: true,
	declared: () => false,
	async plan(ctx) {
		// Resolve only: a plan must never onboard. Everything scoped reads ctx.domain from here.
		ctx.domain = findDomain(await ctx.store.listDomains(), ctx.domainName) ?? null;
		if (ctx.domain) return [{ address: `domain.${ctx.domainName}`, action: "unchanged" }];
		return [{ address: `domain.${ctx.domainName}`, action: "create", detail: "onboard (publishes MX)" }];
	},
	apply: (ctx, roles) => ensureDomain(ctx, roles),
	async remove(ctx, roles) {
		await ensureDomain(ctx, roles); // resolve only: cleanup never onboards
		return ctx.spec?.teardown?.domain === "remove" && ctx.domain ? await removeDomain(ctx) : 0;
	},
};
