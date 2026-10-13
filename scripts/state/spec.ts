// The DOCUMENT MODEL: what a desired-state document may contain, and the shapes the
// app hands back. Response shapes come from the app's own builders, so field access is
// checked against what the endpoint actually returns (no guessing):
//   GET /api/v1/domains   -> listUserDomains() rows (+ sendingEnabled)
//   GET /api/v1/accounts  -> accountListItemFromUser()
//   GET /api/v1/mailboxes -> the inline select in api/v1/mailboxes/utils.ts
import type { InferSelectModel } from "drizzle-orm";
import type { accountListItemFromUser } from "@/app/api/accounts/utils";
import type { listUserDomains } from "@/lib/domains/service";
import type { domains as domainsTable, mailboxes as mailboxesTable } from "@/db/schema";

export type ApiDomain = Awaited<ReturnType<typeof listUserDomains>>[number] & {
	/** Added by GET /api/v1/domains on top of the stored row. */
	sendingEnabled?: boolean;
};
export type ApiAccount = ReturnType<typeof accountListItemFromUser>;
export type ApiMailbox = Pick<
	InferSelectModel<typeof mailboxesTable>,
	"id" | "userId" | "domainId" | "localPart" | "displayName" | "type" | "disabled" | "createdAt"
> & { hostname: InferSelectModel<typeof domainsTable>["hostname"] };

export type Permission = "read_only" | "send_as" | "send_on_behalf" | "full_access";
export type Provider = "none" | "cloudflare" | "resend" | "ses";

export type AccessGrant = { email: string; permission?: Permission };
/** A mailbox the document declares. `shared` is the JSON's word; Role.share is the code's. */
export type MailboxEntry = {
	role?: string;
	localPart?: string;
	displayName?: string;
	shared?: boolean;
	access?: AccessGrant[];
};
export type OnboardEntry = {
	enableRouting?: boolean;
	enableSending?: boolean;
	replaceMxRecords?: boolean;
	sendingProvider?: Provider;
	receivingProvider?: Provider;
};
export type TeardownEntry = { accounts?: "disable" | "keep"; domain?: "remove" | "keep" };
export type FreshEntry = { admin?: { email?: string; password?: string } };
export type ServerEntry = { db?: string; url?: string; jurisdiction?: string; region?: string };
export type Role = { role: string; displayName: string; share: boolean; access: AccessGrant[] };
export type AccountEntry = { username?: string; name?: string; role?: string; password?: string; passwordEnv?: string };
export type RoutingEntry = {
	name?: string;
	pattern?: string;
	action?: string;
	forwardTo?: string;
	keepCopy?: boolean;
	rejectReason?: string;
	priority?: number;
	matchValue?: string;
	mailboxId?: string;
	/** Destination mailbox by role (for keepCopy / store). */
	mailbox?: string;
};
export type McpKeyEntry = { name?: string; mailboxes?: string[]; scopes?: string[] };
/** "team" | "pro" | "community" (revert), or { plan } to match the other sections. */
export type LicenseEntry = { plan?: string } | string;
export type PushEntry = { to?: string; from?: string; subject?: string; timeout?: number };

/** One desired-state document: any subset of these sections. */
export type Spec = {
	domain?: string;
	onboard?: OnboardEntry;
	mailboxes?: MailboxEntry[];
	accounts?: AccountEntry[];
	routing?: RoutingEntry[];
	mcpKeys?: McpKeyEntry[];
	license?: LicenseEntry;
	push?: PushEntry;
	/** What destroy does to the pieces it cannot simply delete. Declared, not flagged. */
	teardown?: TeardownEntry;
	/** Reset the instance to empty and create its primary admin. */
	fresh?: FreshEntry;
};

/** A file that declares many documents at once, for a mass run. */
export type SpecFile = { specs?: Spec[] };
