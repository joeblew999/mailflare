import { rolesFor } from "./document";
import type { Flags } from "./flags";
import type { ApiDomain, Role, Spec } from "./spec";
import { memoryVault, type Vault } from "./vault";
import type { Change } from "./resources/resource";
import type { Store } from "./store/types";

// Everything a resource needs for one document. The Store is its only way out.
export type Context = {
	store: Store;
	flags: Flags;
	spec: Spec;
	/** "" for an instance document. */
	domainName: string;
	/** The mailboxes the document declares, normalised. */
	roles: Role[];
	/** Set by the domain resource; null until the domain exists. */
	domain: ApiDomain | null;
	/** Mailbox ids on this domain by local part, published as they are found or made. */
	mailboxIds: Map<string, string>;
	log(line: string): void;
	/** Where the logins and keys this run creates are written. */
	vault: Vault;
	/** The instance has no users at all, so this document gives it its primary admin. */
	bootstrap: boolean;
	/**
	 * What ALL of the server's documents declare, when the whole project is being run: the
	 * instance document checks the server against it. Null for anything less than the project.
	 */
	project: ProjectScope | null;
	/** What the run saw (a plan) or did (an apply, a destroy): the same lines it printed, as data. */
	changes: Change[];
	/** Set when something went wrong, as opposed to merely being left to do. */
	failed: boolean;
	/** Set when the only thing left is removals that were not approved. */
	unapproved: boolean;
};

/** `keys` is null when no document writes an mcpKeys section, so keys are nobody's to manage. */
export type ProjectScope = { domains: Set<string>; keys: Set<string> | null };
export type ContextOptions = { log?: (line: string) => void; vault?: Vault; bootstrap?: boolean; project?: ProjectScope | null };

export function makeContext(store: Store, flags: Flags, spec: Spec, { log = console.log, vault = memoryVault(), bootstrap = false, project = null }: ContextOptions = {}): Context {
	return { store, flags, spec, domainName: String(spec.domain ?? "").trim().toLowerCase(), roles: rolesFor(spec), domain: null, mailboxIds: new Map(), log, vault, bootstrap, project, changes: [], failed: false, unapproved: false };
}

/** The domain, for work that cannot start without one. */
export function requireDomain(ctx: Context): ApiDomain {
	if (!ctx.domain) throw new Error(`${ctx.domainName} is not onboarded`);
	return ctx.domain;
}

export const usernameOf = (entry: { username: string }) => entry.username.trim().toLowerCase();

// A plan runs before anything is made, so "does not exist yet" is not "cannot resolve": an
// account the document declares will exist, and it brings a mailbox of its own name.
export const declaresUser = (ctx: Context, email: string): boolean =>
	(ctx.spec.accounts ?? []).some((entry) => `${usernameOf(entry)}@${ctx.domainName}` === email);
export const declaresMailbox = (ctx: Context, role: string): boolean =>
	ctx.roles.some((entry) => entry.role === role) || (ctx.spec.accounts ?? []).some((entry) => usernameOf(entry) === role);
