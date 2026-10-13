/* eslint-disable @typescript-eslint/no-explicit-any -- a Spec is user-authored JSON. */
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

export type AccessGrant = { email?: string; permission?: string };
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
export type PushEntry = { to?: string; from?: string; subject?: string };

/** One desired-state document: any subset of these sections. */
export type Spec = {
	domain?: string;
	onboard?: Record<string, any>;
	mailboxes?: any[];
	accounts?: AccountEntry[];
	routing?: RoutingEntry[];
	mcpKeys?: McpKeyEntry[];
	license?: LicenseEntry;
	push?: PushEntry;
	/** Reset the instance to empty and create its primary admin. */
	fresh?: { admin?: { email?: string; password?: string } };
};

/** A file that declares many documents at once, for a mass run. */
export type SpecFile = { specs?: Spec[] };
