import { onboardBody } from "../document";
import { requireDomain } from "../context";
import type { Context } from "../context";
import type { ApiDomain } from "../spec";
import type { Resource } from "./resource";

export const findDomain = (list: ApiDomain[], name: string) =>
	list.find((entry) => String(entry.hostname).toLowerCase() === name);

/** Resolve the document's domain. Never onboards: a plan must not change the world. */
export async function resolveDomain(ctx: Context): Promise<ApiDomain | null> {
	ctx.domain = findDomain(await ctx.store.listDomains(), ctx.domainName) ?? null;
	return ctx.domain;
}

async function onboard(ctx: Context): Promise<number> {
	const mx = await ctx.store.currentMx(ctx.domainName);
	if (mx?.length && !ctx.flags.confirmMx) {
		console.error(`\nRefusing to onboard ${ctx.domainName}: it already receives mail.`);
		console.error("Re-run with --confirm-mx to knowingly take over its MX, or pick a domain with no mail.");
		return 1;
	}
	console.log(`Onboarding ${ctx.domainName} into Mailflare…`);
	const added = await ctx.store.onboardDomain(onboardBody(ctx.spec, ctx.domainName));
	if (added.status !== 200 && added.status !== 201) {
		console.error(`Could not onboard ${ctx.domainName}: HTTP ${added.status} ${added.json?.error ?? ""}`);
		return 1;
	}
	return (await resolveDomain(ctx)) ? 0 : 1;
}

export const domainResource: Resource = {
	section: "domain",
	needsDomain: false,
	prerequisite: true,
	// The registry includes it whenever anything scoped is declared, so `declared` is not used.
	declared: () => false,
	async items(ctx) {
		await resolveDomain(ctx);
		const wantsOnboard = Boolean(ctx.spec?.onboard);
		return [{
			address: `domain.${ctx.domainName}`,
			wants: wantsOnboard ? "onboard (publishes MX)" : undefined,
			problem: ctx.domain || wantsOnboard ? undefined : "not onboarded — add an onboard section, or add it in the app",
			actual: async () => ctx.domain,
			create: () => onboard(ctx),
			remove: async () => {
				if (ctx.spec?.teardown?.domain !== "remove" || !ctx.domain) return 0;
				const res = await ctx.store.removeDomain(requireDomain(ctx).id);
				console.log(`${res.status === 200 ? "✓ removed" : `✗ remove failed (HTTP ${res.status})`} domain ${ctx.domainName}`);
				return res.status === 200 ? 0 : 1;
			},
		}];
	},
};
