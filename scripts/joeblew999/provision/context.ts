import type { ApiDomain, Context, Flags, ProjectManifest } from "./types";
import type { Store } from "./store-types";

export function makeContext(store: Store, flags: Flags, project: ProjectManifest | null, domainName: string): Context {
	return { store, flags, project, domainName, domain: null };
}

// Resource helpers only run after ensureDomain resolved the domain; a null one means
// the flags asked us to stop, so it is a programming error rather than user input.
export function requireDomain(ctx: Context): ApiDomain {
	if (!ctx.domain) throw new Error(`domain ${ctx.domainName} is not resolved`);
	return ctx.domain;
}
