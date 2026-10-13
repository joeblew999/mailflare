import type { Flags } from "./flags";
import type { ApiDomain, Spec } from "./spec";
import type { Store } from "./store/types";

// Everything a resource needs for one document: the Store (its only way out), the
export type Context = {
	store: Store;
	flags: Flags;
	spec: Spec | null;
	domainName: string;
	domain: ApiDomain | null;
};

export function makeContext(store: Store, flags: Flags, spec: Spec | null, domainName: string): Context {
	return { store, flags, spec, domainName, domain: null };
}

// Resources only run after the domain is resolved; a null one means the flags asked
// us to stop, so it is a programming error rather than user input.
export function requireDomain(ctx: Context): ApiDomain {
	if (!ctx.domain) throw new Error(`domain ${ctx.domainName} is not resolved`);
	return ctx.domain;
}
