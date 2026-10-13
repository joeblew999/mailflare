import { freshResource } from "./fresh";
import { domainResource } from "./domain";
import { licenseResource } from "./license";
import { accountsResource } from "./accounts";
import { mailboxesResource } from "./mailboxes";
import { routingResource } from "./routing";
import { mcpKeysResource } from "./mcp-keys";
import { pushResource } from "./push";
import type { Resource } from "./resource";
import type { Context } from "../context";
import type { Role } from "../spec";

// The order IS the design: fresh wipes, domain resolves and onboards (aborting when it
// cannot), license gates shared inboxes and account management, accounts precede mailboxes
// because access grants name users, and mailboxes precede the rules and keys that name them.
// Destroy walks this in reverse, so the license is reverted last.
export const RESOURCES: Resource[] = [
	freshResource,
	domainResource,
	licenseResource,
	accountsResource,
	mailboxesResource,
	routingResource,
	mcpKeysResource,
	pushResource,
];

/** Does anything other than the domain prerequisite need a domain resolved? */
export const needsDomain = (ctx: Context, roles: Role[]): boolean =>
	RESOURCES.some((resource) => resource !== domainResource && resource.needsDomain && resource.declared(ctx, roles));

/** The resources this run actually asks for (absent sections are skipped). */
export const declaredResources = (ctx: Context, roles: Role[]): Resource[] =>
	RESOURCES.filter((resource) => (resource === domainResource ? needsDomain(ctx, roles) : resource.declared(ctx, roles)));
