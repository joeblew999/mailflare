import { onboardBody } from "../document";
import { expectOk, type Resource } from "./resource";
import type { Context } from "../context";
import type { ApiDomain, Provider } from "../spec";

export const findDomain = (list: ApiDomain[], name: string) => list.find((entry) => String(entry.hostname).toLowerCase() === name);

/** Resolve the document's domain. Never onboards: a plan must not change the world. */
export async function resolveDomain(ctx: Context): Promise<ApiDomain | null> {
	ctx.domain = findDomain(await ctx.store.listDomains(), ctx.domainName) ?? null;
	return ctx.domain;
}

const CLOUDFLARE_MX = /^route\d+\.mx\.cloudflare\.net\.?$/i;

/** MX records that are not the receiving provider's own, so onboarding would take mail from someone. */
export function foreignMx(records: Array<{ content?: string }>, receiving: Provider): string[] {
	const hosts = records.map((record) => String(record.content ?? "").toLowerCase()).filter(Boolean);
	return receiving === "cloudflare" ? hosts.filter((host) => !CLOUDFLARE_MX.test(host)) : hosts;
}

async function onboard(ctx: Context): Promise<string> {
	const options = ctx.spec.onboard ?? {};
	const receiving = options.receivingProvider ?? "cloudflare";
	// Only a domain that will receive gets MX records, and only then can it take someone's mail.
	if (receiving !== "none" && (options.enableRouting ?? true) && !ctx.flags.confirmMx) {
		const foreign = foreignMx((await ctx.store.currentMx(ctx.domainName)) ?? [], receiving);
		if (foreign.length > 0) throw new Error(`it already receives mail through ${foreign.join(", ")} — re-run with --confirm-mx to take over its MX`);
	}
	expectOk(await ctx.store.onboardDomain(onboardBody(ctx.spec, ctx.domainName)));
	if (!(await resolveDomain(ctx))) throw new Error("the app accepted the domain, but does not list it");
	return `onboarded (receiving: ${receiving})`;
}

export const domainResource: Resource = {
	section: "domain",
	prerequisite: true,
	declared: (ctx) => Boolean(ctx.domainName),
	async items(ctx) {
		await resolveDomain(ctx);
		const options = ctx.spec.onboard;
		return [{
			address: `domain.${ctx.domainName}`,
			wants: options ? `onboard (receiving: ${options.receivingProvider ?? "cloudflare"})` : undefined,
			problem: ctx.domain || options ? undefined : "not onboarded — add an onboard section, or add it in the app",
			keep: ctx.spec.teardown?.domain === "remove" ? undefined : 'teardown.domain is not "remove"',
			actual: async () => ctx.domain,
			create: () => onboard(ctx),
			remove: async (present) => {
				expectOk(await ctx.store.removeDomain((present as ApiDomain).id));
				ctx.domain = null;
			},
		}];
	},
};
