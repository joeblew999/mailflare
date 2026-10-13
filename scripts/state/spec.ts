// The DOCUMENT MODEL: what a desired-state document may contain. The vocabularies are values,
// so the validator and the types cannot drift apart.
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

export const PERMISSIONS = ["read_only", "send_as", "send_on_behalf", "full_access"] as const;
export const PROVIDERS = ["none", "cloudflare", "resend", "ses"] as const;
export const ROUTING_ACTIONS = ["store", "forward", "reject"] as const;
export const ACCOUNT_ROLES = ["admin", "user"] as const;
export const PLANS = ["community", "pro", "team"] as const;
// Mirrors MCP_SCOPES in src/lib/mcp/auth.ts, which is not exported; a test holds the two together.
export const MCP_SCOPES = ["mcp:read", "mcp:draft", "mcp:organize", "mcp:request-send", "mcp:calendar-read", "mcp:calendar-write"] as const;

export const AGENT_PROVIDERS = ["cloudflare", "compatible"] as const;
export const AGENT_PRESETS = ["openai", "openrouter", "groq", "custom"] as const;
export const BACKUP_SCHEDULES = ["daily", "weekly", "monthly"] as const;
// Mirrors BACKUP_TABLE_GROUPS in src/lib/backups/table-groups.ts; a test holds the two together.
export const BACKUP_GROUPS = ["accounts", "mail", "automation", "assistant", "system"] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type Provider = (typeof PROVIDERS)[number];
export type RoutingAction = (typeof ROUTING_ACTIONS)[number];
export type AccountRole = (typeof ACCOUNT_ROLES)[number];
export type Plan = (typeof PLANS)[number];

export const RULE_FIELDS = ["email", "title", "content"] as const;
export const RULE_OPERATORS = ["contains", "exact"] as const;
export const RULE_ACTIONS = ["folder", "spam", "trash"] as const;
export const WEBHOOK_EVENTS = ["message.inbound", "message.outbound", "message.failed"] as const;
export const API_KEY_SCOPES = ["send", "read", "jmap", "calendar:read", "calendar:write"] as const;
export const CALENDAR_REPEATS = ["none", "daily", "weekly", "monthly", "weekdays"] as const;

/** What sorts a mailbox's incoming mail: into a folder of its own, to spam, or to the bin. */
export type InboxRule = { field?: (typeof RULE_FIELDS)[number]; operator?: (typeof RULE_OPERATORS)[number]; value: string; action?: (typeof RULE_ACTIONS)[number]; folder?: string; priority?: number };
/** Everything a mailbox can be told about itself. Used by `mailboxes[]` and by an account's own `mailbox`. */
export type MailboxSettings = {
	signature?: string | null;
	autoReply?: { enabled?: boolean; subject?: string; body?: string };
	/** Other addresses on the domain that deliver here. */
	aliases?: string[];
	folders?: Array<{ name: string; color?: string }>;
	rules?: InboxRule[];
	/** The assistant, for this mailbox. `reviewer` is the address of whoever approves its drafts. */
	assistant?: { enabled?: boolean; autoDraft?: boolean; instructions?: string; dailyLimit?: number; model?: string | null; reviewer?: string | null };
};

export type AccessGrant = { email: string; permission?: Permission };
export type MailboxEntry = MailboxSettings & {
	role?: string;
	/** A synonym for `role`. */
	localPart?: string;
	displayName?: string;
	shared?: boolean;
	access?: AccessGrant[];
};

export type BookingPage = { name: string; slug?: string; description?: string; durationMinutes: number; location?: string; weekdays: number[]; startTime: string; endTime: string; timeZone: string; enabled?: boolean; color?: string };
export type CalendarEvent = { title: string; startsAt: string; endsAt: string; description?: string; location?: string; repeat?: (typeof CALENDAR_REPEATS)[number]; repeatDays?: number[]; timeZone?: string; color?: string };
/** Everything a person can be told about their own mail, calendar, drive and integrations. */
export type PersonSettings = {
	preferences?: { timeZone?: string | null; keyboardShortcuts?: boolean; spamProtection?: boolean; trashRetentionDays?: number | null; showFullRecipientAddresses?: boolean };
	resetEmail?: string | null;
	templates?: Array<{ name: string; body: string; html?: string }>;
	/** Added when missing; a person's contacts are theirs, so none is ever removed. */
	contacts?: Array<{ email: string; name?: string; blocked?: boolean }>;
	/** `events` are added when missing and never removed: a calendar is its owner's. */
	calendar?: { bookingUsername?: string; bookingPages?: BookingPage[]; events?: CalendarEvent[] };
	/** Folders, as paths. Added when missing; never removed, because they may hold files. */
	drive?: { folders?: string[] };
	/** The primary admin's only: the app lets nobody else keep them. So: `admin` in instance.json. */
	webhooks?: Array<{ url: string; events: Array<(typeof WEBHOOK_EVENTS)[number]>; description?: string; enabled?: boolean; maxAttempts?: number }>;
	/** `mailboxes` are roles on this domain; the default is the person's own mailbox. */
	apiKeys?: Array<{ name: string; scopes: Array<(typeof API_KEY_SCOPES)[number]>; mailboxes?: string[] }>;
};
/** Options for adding the domain. They apply when it is first onboarded, not afterwards. */
export type OnboardEntry = {
	enableRouting?: boolean;
	enableSending?: boolean;
	replaceMxRecords?: boolean;
	sendingProvider?: Provider;
	receivingProvider?: Provider;
};
/** `erase` is a tenant leaving for good: each account is erased, as if it were declared `erased`. */
export type TeardownEntry = { accounts?: "disable" | "erase" | "keep"; domain?: "remove" | "keep" };
export type FreshEntry = { admin?: { email?: string; password?: string } };
/** The password applies when the account is created; a stored hash cannot be compared. */
export type AccountEntry = PersonSettings & {
	username: string;
	name?: string;
	role?: AccountRole;
	password?: string;
	passwordEnv?: string;
	/** Where their mail is also sent. Needs a Pro or Team licence. */
	forwardingEmail?: string | null;
	canManageMailboxes?: boolean;
	canManageDomains?: boolean;
	canManageUsers?: boolean;
	/** The mailbox of their own name. */
	mailbox?: MailboxSettings;
};
export type RoutingEntry = {
	name?: string;
	pattern: string;
	action?: RoutingAction;
	forwardTo?: string;
	keepCopy?: boolean;
	rejectReason?: string;
	priority?: number;
	matchValue?: string;
	mailboxId?: string;
	/** Destination mailbox by role (for keepCopy / store). */
	mailbox?: string;
};
/** No `mailboxes` means every mailbox the admin can reach; naming some restricts the key to them. */
export type McpKeyEntry = { name?: string; mailboxes?: string[]; scopes?: string[] };
export type LicenseEntry = { plan: Plan } | Plan;
export type PushEntry = { to?: string; from?: string; subject?: string; timeout?: number };
/** The assistant's model provider. A compatible provider's key is read from the environment. */
export type AssistantEntry = {
	enabled?: boolean;
	provider?: (typeof AGENT_PROVIDERS)[number];
	preset?: (typeof AGENT_PRESETS)[number];
	/** For the custom preset: an HTTPS base URL. */
	baseUrl?: string;
	models?: string[];
	apiKeyEnv?: string;
};
/** app_settings. Secrets are never written in a document: each names an environment variable. */
export type SettingsEntry = {
	appName?: string;
	outboundAttachmentMaxMb?: number;
	/** Per-user Drive limit; null removes it. */
	driveStorageLimitGb?: number | null;
	assistant?: AssistantEntry;
	resendApiKeyEnv?: string;
	aws?: { accessKeyIdEnv: string; secretAccessKeyEnv: string; region: string };
};
/** backup_settings. */
export type BackupsEntry = {
	enabled?: boolean;
	schedule?: (typeof BACKUP_SCHEDULES)[number];
	/** Weekly: the day, 0 (Sunday) to 6, UTC. Monthly: the day of the month, 1 to 28. */
	scheduleValue?: number;
	/** How long backups are kept; null keeps them all. */
	retentionDays?: number | null;
	/** Table groups left out of a backup. */
	exclude?: Array<(typeof BACKUP_GROUPS)[number]>;
};

/** One desired-state document: any subset of these sections. */
export type Spec = {
	domain?: string;
	/** The tenant's home country (ISO, two letters). Its server must be one that serves it. */
	country?: string;
	onboard?: OnboardEntry;
	mailboxes?: MailboxEntry[];
	accounts?: AccountEntry[];
	routing?: RoutingEntry[];
	mcpKeys?: McpKeyEntry[];
	license?: LicenseEntry;
	settings?: SettingsEntry;
	backups?: BackupsEntry;
	push?: PushEntry;
	/** What destroy does to the pieces it cannot simply delete. Declared, not flagged. */
	teardown?: TeardownEntry;
	/** Configures `reset`: the primary admin the wiped instance is given. */
	fresh?: FreshEntry;
	/** The primary admin's own settings: what `accounts[]` says of everyone else. */
	admin?: PersonSettings;
	/**
	 * People who must not exist on this server: each an address (in a tenant document, a name
	 * on its domain will do), or `sha256:` and the digest of the address when even that must
	 * not be kept. Found, they are erased - account, mail, files, and from every backup.
	 */
	erased?: string[];
};

/** Sections that describe the instance, and the ones that describe a tenant on a domain. */
export const INSTANCE_SECTIONS = ["license", "settings", "backups", "push", "fresh", "admin"] as const;
export const TENANT_SECTIONS = ["onboard", "mailboxes", "accounts", "routing", "mcpKeys", "teardown"] as const;
/** Sections either kind of document may write. */
export const SHARED_SECTIONS = ["erased"] as const;

/** A mailbox the document declares, normalised. `displayName` is null when it is not declared. */
export type Role = { role: string; displayName: string | null; shared: boolean; access: AccessGrant[]; /** The entry writes an `access` list, so the list is complete. */ managesAccess: boolean };

// Where Cloudflare will keep a server's data at rest. A jurisdiction is a guarantee; a region
// is a hint, and is ignored when a jurisdiction is set.
export const JURISDICTIONS = ["eu", "fedramp"] as const;
export const REGIONS = ["weur", "eeur", "apac", "oc", "wnam", "enam"] as const;

/**
 * A server: projects/<name>/server.json. The FOLDER names it - and its Worker, database,
 * bucket and queues - and the file says where it lives. `url` and `databaseId` are written
 * back when it is deployed.
 */
export type Server = {
	name: string;
	url?: string;
	db?: string;
	databaseId?: string;
	bucket?: string;
	/** Pins the database, the bucket and the Durable Objects: the data never leaves it. */
	jurisdiction?: (typeof JURISDICTIONS)[number];
	region?: (typeof REGIONS)[number];
	/** The country it runs in (ISO, two letters): its Worker is placed beside a cloud region there. */
	country?: string;
	/** The countries whose tenants are at home here; `"eu"` is every member. Default: its own. */
	serves?: string[];
	/** The exact cloud region to run beside, like `aws:eu-central-1`, when `country` does not say enough. */
	placement?: string;
	/** The local dev instance (`npm run dev`): never deployed, and never a remote database. */
	local?: boolean;
	/** A folder to copy, not a server to build: it can be planned, never applied. */
	template?: boolean;
	/** Built to be torn down: left out of fleet runs and of the router. Named, it runs like any other. */
	disposable?: boolean;
	/**
	 * False gives the server NO Cloudflare token, so it can never touch a zone's DNS or Email
	 * Routing: the app records its domains by hand, and any name will do for one.
	 */
	managesDns?: boolean;
};
export const SERVER_FIELDS = ["db", "databaseId", "bucket", "url", "jurisdiction", "region", "country", "serves", "placement", "local", "template", "disposable", "managesDns"] as const;

// Where a Worker RUNS is chosen by naming a cloud region for Cloudflare to place it beside. A
// country here is the region in that country; anything else is given as `placement`.
export const PLACEMENTS: Record<string, string> = {
	de: "aws:eu-central-1", fr: "aws:eu-west-3", ie: "aws:eu-west-1", gb: "aws:eu-west-2", se: "aws:eu-north-1", it: "aws:eu-south-1", es: "aws:eu-south-2",
	ch: "aws:eu-central-2", nl: "gcp:europe-west4", be: "gcp:europe-west1", fi: "gcp:europe-north1", pl: "gcp:europe-central2",
	us: "aws:us-east-1", ca: "aws:ca-central-1", br: "aws:sa-east-1", jp: "aws:ap-northeast-1", kr: "aws:ap-northeast-2", sg: "aws:ap-southeast-1",
	au: "aws:ap-southeast-2", in: "aws:ap-south-1", id: "aws:ap-southeast-3", hk: "aws:ap-east-1", za: "aws:af-south-1", ae: "aws:me-central-1", il: "aws:il-central-1",
};
/** The members of the European Union: whom `"serves": ["eu"]` is home to, and where the `eu` jurisdiction is. */
export const EU_COUNTRIES = ["at", "be", "bg", "hr", "cy", "cz", "dk", "ee", "fi", "fr", "de", "gr", "hu", "ie", "it", "lv", "lt", "lu", "mt", "nl", "pl", "pt", "ro", "sk", "si", "es", "se"];

/** The cloud region a server's Worker is placed beside, if it says where it runs. */
export const placementOf = (server: Pick<Server, "country" | "placement">): string | undefined => server.placement ?? (server.country ? PLACEMENTS[server.country.toLowerCase()] : undefined);
/** The countries a server is home to: what it says it serves, else the one it is in. */
export const servedBy = (server: Pick<Server, "country" | "serves">): string[] =>
	[...new Set((server.serves ?? (server.country ? [server.country] : [])).flatMap((entry) => (entry.toLowerCase() === "eu" ? EU_COUNTRIES : [entry.toLowerCase()])))];
export const SERVER_FLAGS = ["local", "template", "disposable", "managesDns"] as const;
