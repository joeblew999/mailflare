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

// The order IS the design, and it is load-bearing:
//   fresh     wipes the instance, so nothing may precede it;
//   domain    resolves (and, when declared, onboards) the domain everything scoped
//             operates on, and aborts the run when it cannot;
//   license   before what it GATES: shared inboxes and account management both 403
//             without an active Pro/Team plan - only visible on a fresh server;
//   accounts  before mailboxes, because a mailbox's `access` grants name users and on
//             a fresh server the only users are the ones `accounts` creates;
//   mailboxes before routing rules and MCP keys, which name mailbox ids by role.
// --cleanup walks this in reverse, which reverts the license last so the account
// disable still has a plan to work under.
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
