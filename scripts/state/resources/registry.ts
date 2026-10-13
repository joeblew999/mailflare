import { freshResource } from "./fresh";
import { licenseResource } from "./license";
import { backupsResource, settingsResource } from "./settings";
import { domainResource } from "./domain";
import { accountsResource } from "./accounts";
import { mailboxesResource } from "./mailboxes";
import { routingResource } from "./routing";
import { mcpKeysResource } from "./mcp-keys";
import { mailboxSettingsResource, peopleResource } from "./people";
import { pushResource } from "./push";
import { undeclaredResource } from "./undeclared";
import type { Resource } from "./resource";

// The order IS the design:
//   fresh      wipes, so it is first, and stops the document if it cannot.
//   license    gates shared inboxes and account management, so it precedes both.
//   settings, backups   instance rows that depend on nothing.
//   domain     everything below lives on it; it stops the document if it cannot be had.
//   accounts   precede mailboxes, because access grants name users.
//   mailboxes  precede the rules and keys that name them.
//   mailbox settings, people   what each mailbox and each person is told about itself: after
//              both exist, since a person's keys and templates name their mailbox.
//   push       a round trip through everything above.
//   undeclared what is on the server and in no document; it has nothing to precede.
// Destroy walks it in reverse, so the domain goes after what is on it and the licence after
// the accounts it lets us disable.
export const RESOURCES: Resource[] = [
	freshResource,
	licenseResource,
	settingsResource,
	backupsResource,
	domainResource,
	accountsResource,
	mailboxesResource,
	mailboxSettingsResource,
	routingResource,
	mcpKeysResource,
	peopleResource,
	pushResource,
	undeclaredResource,
];
