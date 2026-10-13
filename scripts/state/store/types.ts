// The one seam between the reconciler and the outside world. Every read and write a resource
// makes goes through here, which is what lets the unit tests run a whole lifecycle in memory.
import type { ApiResult } from "../wrangler";
import type { ApiAccount, ApiDomain, ApiMailbox } from "../spec";

// --- keys, access grants, routing rules and settings have no key-authenticated app route,
// --- so they are written with SQL. These are their stored shapes.

/** A domain-scope routing rule as stored (the D1 row, snake_case). */
export type RoutingRuleRow = {
	id: string;
	pattern: string;
	action: string;
	match_value: string | null;
	forward_to: string | null;
	keep_copy: number;
	mailbox_id: string | null;
	reject_reason: string | null;
	priority: number;
	enabled: number;
};

/** Values for a routing rule; ids and timestamps are the store's job. */
export type RoutingRuleValues = {
	userId: string;
	domainId: string;
	name: string;
	enabled: number;
	pattern: string;
	matchField: string;
	matchOperator: string;
	matchValue: string;
	action: string;
	forwardTo: string | null;
	keepCopy: number;
	mailboxId: string | null;
	rejectReason: string | null;
	priority: number;
};

/** The mutable half of a routing rule, for reconciling an existing row. */
export type RoutingRulePatch = Pick<
	RoutingRuleValues,
	"matchValue" | "forwardTo" | "keepCopy" | "mailboxId" | "rejectReason" | "priority" | "enabled"
>;

/** The single license_settings row the app's entitlement gate reads. */
export type LicenseRow = { plan: string; state: string };

/** An MCP key. `mailboxIds` is null when the key is not restricted to particular mailboxes. */
export type McpKeyRow = { id: string; scopes: string[]; mailboxIds: string[] | null };
export type McpKeyValues = { scopes: string[]; mailboxIds: string[] | null };

// Configuration the app has no key-authenticated route for is read and written as rows. The
// live store checks every table and column against the app's own schema before it writes.
export type ManagedTable =
	| "app_settings" | "backup_settings" | "users" | "mailboxes" | "mailbox_aliases" | "mailbox_agent_settings"
	| "folders" | "routing_rules" | "messages" | "contacts" | "webhooks" | "booking_events" | "calendar_events"
	| "drive_items" | "api_keys" | "mcp_key_mailboxes" | "webhook_deliveries";
export type SettingValue = string | number | null;
export type SettingsRow = Record<string, SettingValue>;

export type PushTestInput = { from: string; to: string; subject: string; text: string; html: string };

export type SubjectCount = { table: string; rows: number };
export type SubjectReport = {
	email: string;
	/** null when no account exists for that address. */
	userId: string | null;
	mailboxIds: string[];
	counts: SubjectCount[];
	/** Why this subject cannot be erased as things stand. Empty means it can. */
	blockers: string[];
};

export type EraseResult = {
	email: string;
	userId: string | null;
	deleted: SubjectCount[];
	/** Object-store keys that held the subject's bytes. */
	objectKeys: string[];
	objectsDeleted: number;
};

export type Store = {
	/** The instance's origin. Empty until the first HTTP call resolves it. */
	readonly base: string;
	/** The admin whose key drives the API, and who owns what SQL creates. */
	admin(): Promise<{ id: string; email: string }>;

	// the domain's current MX records, from the Cloudflare API (null if unknown)
	currentMx(hostname: string): Promise<Array<{ priority?: number; content?: string }> | null>;

	/**
	 * Addresses on the domain that a Cloudflare Email Routing rule already sends somewhere other
	 * than this server, with where. Empty when there are none, or when Cloudflare cannot be asked.
	 */
	routedElsewhere(hostname: string): Promise<Record<string, string>>;

	// domains (HTTP)
	listDomains(): Promise<ApiDomain[]>;
	onboardDomain(body: unknown): Promise<ApiResult>;
	removeDomain(domainId: string): Promise<ApiResult>;

	// mailboxes (HTTP)
	listMailboxes(): Promise<ApiMailbox[]>;
	createMailbox(body: unknown): Promise<ApiResult>;
	updateMailbox(mailboxId: string, body: unknown): Promise<ApiResult>;
	deleteMailbox(mailboxId: string): Promise<ApiResult>;

	// accounts (HTTP)
	listAccounts(): Promise<ApiAccount[]>;
	createAccount(body: unknown): Promise<ApiResult>;
	updateAccount(accountId: string, body: unknown): Promise<ApiResult>;

	// users and mailbox sharing (SQL)
	userIdByEmail(email: string): Promise<string | null>;
	/** Every grant on these mailboxes, with whom it is to. */
	accessList(mailboxIds: string[]): Promise<Array<{ mailboxId: string; userId: string; email: string; permission: string }>>;
	grantAccess(mailboxId: string, userId: string, permission: string): Promise<void>;
	revokeAccess(mailboxId: string, userId: string): Promise<void>;

	// domain routing rules (SQL)
	/** Every domain-scope rule on the domain. */
	routingRules(domainId: string): Promise<RoutingRuleRow[]>;
	insertRoutingRule(values: RoutingRuleValues): Promise<void>;
	updateRoutingRule(ruleId: string, patch: RoutingRulePatch): Promise<void>;
	deleteRoutingRule(ruleId: string): Promise<void>;

	// MCP keys (SQL): owned by the admin, named instance-wide
	mcpKey(name: string): Promise<McpKeyRow | null>;
	/** Every MCP key the admin owns. */
	mcpKeyNames(): Promise<Array<{ id: string; name: string }>>;
	/** Every domain on the server, whoever added it. */
	domainNames(): Promise<string[]>;
	createMcpKey(input: { name: string } & McpKeyValues): Promise<{ fullKey: string }>;
	updateMcpKey(keyId: string, values: McpKeyValues): Promise<void>;
	deleteMcpKey(keyId: string): Promise<void>;

	// license (SQL): the plan the entitlement gate reads
	licenseRow(): Promise<LicenseRow | null>;
	/** Activate a plan, or revert to community when null. */
	setLicense(plan: string | null): Promise<void>;

	// configuration rows (SQL). `where` is an equality on each column given.
	rows(table: ManagedTable, where: SettingsRow): Promise<SettingsRow[]>;
	/** Insert a row; its timestamps are the store's job. */
	insertRow(table: ManagedTable, values: SettingsRow): Promise<void>;
	updateRows(table: ManagedTable, where: SettingsRow, values: SettingsRow): Promise<void>;
	deleteRows(table: ManagedTable, where: SettingsRow): Promise<void>;
	/** Insert the row `key` names, or update it when it is there. */
	upsertRow(table: ManagedTable, key: SettingsRow, values: SettingsRow): Promise<void>;

	// data-subject index: where one person's data lives (see subject-scope.ts)
	subjectReport(email: string): Promise<SubjectReport>;
	/** Destroy the subject's rows AND their objects. Refuses while the report lists blockers. */
	eraseSubject(email: string): Promise<EraseResult>;

	// fresh instance lifecycle: only the reset capability uses these
	/** Bring the target database up to the current schema. */
	applyMigrations(): Promise<void>;
	schemaPresent(): Promise<boolean>;
	/** How many users there are; null when the database has no schema yet. Zero means nobody can log in. */
	userCount(): Promise<number | null>;
	/** Rows in `domains` — used to warn before a reset orphans Cloudflare config. */
	domainCount(): Promise<number>;
	/** Empty every table, then put back the rows the migrations seed. */
	wipeData(): Promise<void>;
	insertAdmin(user: { id: string; email: string; name: string; passwordHash: string }): Promise<void>;

	// web push verification (network + SQL + wrangler)
	workerSecrets(): Promise<string[] | null>;
	pushSubscriptionCount(): Promise<number>;
	clearPushSubscriptions(): Promise<void>;
	firstAdminEmail(): Promise<string | null>;
	sendViaCloudflare(input: PushTestInput): Promise<{ messageId?: string }>;
	messageStatusBySubject(subject: string): Promise<{ status: string } | null>;
	/** Injectable so tests do not really wait. */
	wait(ms: number): Promise<void>;

	/** Delete the temporary admin key, if one was ever minted. */
	dispose(): Promise<void>;
};
