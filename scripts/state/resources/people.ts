// What a MAILBOX and a PERSON can be told about themselves: mail, calendar, drive and
// integrations. Single values are fields (see settings.ts); lists go through collection.ts.
import { generateApiKey } from "@/lib/api-keys";
import { ADMIN_API_KEY_SCOPES } from "@/lib/api/scopes";
import { parseBookingEventInput } from "@/lib/booking/utils";
import { newId } from "@/lib/ids";
import { declaresUser, requireDomain, usernameOf, type Context } from "../context";
import { collectionItems, type Wanted } from "./collection";
import { publishMailboxIds } from "./mailboxes";
import { fieldItems, flag, type Field } from "./settings";
import type { Item, Resource } from "./resource";
import type { MailboxSettings, PersonSettings } from "../spec";
import type { SettingsRow } from "../store/types";

const brief = (value: unknown) => (value === null || value === "" ? "none" : `"${String(value).replace(/\s+/g, " ").slice(0, 40)}${String(value).length > 40 ? "…" : ""}"`);
const seconds = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const MAILBOX_KEYS = ["signature", "autoReply", "aliases", "folders", "rules", "assistant"] as const;
const PERSON_KEYS = ["preferences", "resetEmail", "forwardingEmail", "canManageMailboxes", "canManageDomains", "canManageUsers", "templates", "contacts", "calendar", "drive", "webhooks", "apiKeys"] as const;
const says = (entry: object, keys: readonly string[]) => keys.some((key) => (entry as Record<string, unknown>)[key] !== undefined);

// --- a mailbox ---------------------------------------------------------------------

async function mailboxItems(ctx: Context, role: string, settings: MailboxSettings): Promise<Item[]> {
	const address = `${role}@${ctx.domainName}`;
	const id = ctx.mailboxIds.get(role) ?? null;
	const row: SettingsRow = id ? (await ctx.store.rows("mailboxes", { id }))[0] ?? {} : {};
	// Read at the moment of a write: the mailbox may have been made earlier in this run.
	const mailboxId = () => {
		const now = ctx.mailboxIds.get(role);
		if (!now) throw new Error(`${address} does not exist`);
		return now;
	};
	const owner = id ? { mailbox_id: id } : null;
	const ownerUserId = async () => String(((await ctx.store.rows("mailboxes", { id: mailboxId() }))[0] ?? {}).user_id ?? "");
	const items: Item[] = [];

	const fields: Field[] = [];
	if (settings.signature !== undefined) fields.push({ name: "signature", wanted: settings.signature ?? null, stored: row.signature ?? null, columns: { signature: settings.signature ?? null }, show: brief });
	const reply = settings.autoReply ?? {};
	if (reply.enabled !== undefined) fields.push({ name: "autoReply.enabled", wanted: reply.enabled, stored: flag(row.auto_reply_enabled, false), columns: { auto_reply_enabled: reply.enabled ? 1 : 0 } });
	if (reply.subject !== undefined) fields.push({ name: "autoReply.subject", wanted: reply.subject, stored: row.auto_reply_subject ?? "Out of office", columns: { auto_reply_subject: reply.subject }, show: brief });
	if (reply.body !== undefined) fields.push({ name: "autoReply.body", wanted: reply.body, stored: row.auto_reply_body ?? "", columns: { auto_reply_body: reply.body }, show: brief });
	items.push(...fieldItems(`mailbox.${address}`, fields, async (columns) => ctx.store.updateRows("mailboxes", { id: mailboxId() }, columns)));

	if (settings.aliases !== undefined) {
		// An alias has no routing rule of its own in Cloudflare: the domain's catch-all brings its mail in.
		items.push(...(await collectionItems(ctx, {
			kind: "alias", of: address, table: "mailbox_aliases", owner, keyColumn: "local_part", idPrefix: "als", complete: true,
			wanted: settings.aliases.map((alias): Wanted => ({
				key: alias.trim().toLowerCase(),
				columns: {},
				onCreate: () => ({ domain_id: requireDomain(ctx).id }),
				problem: ctx.mailboxIds.has(alias.trim().toLowerCase()) ? `${alias}@${ctx.domainName} is a mailbox, so it cannot also be an alias` : undefined,
			})),
		})));
	}

	const folders = id ? await ctx.store.rows("folders", { mailbox_id: id }) : [];
	if (settings.folders !== undefined) {
		items.push(...(await collectionItems(ctx, {
			kind: "folder", of: address, table: "folders", owner, keyColumn: "name", idPrefix: "fld", complete: true,
			wanted: settings.folders.map((folder): Wanted => ({
				key: folder.name.trim(),
				columns: folder.color ? { color: folder.color } : {},
				// A folder belongs to whoever owns its mailbox, read when it is made: the mailbox may be new.
				onCreate: async () => ({ user_id: await ownerUserId() }),
			})),
		})));
	}

	if (settings.rules !== undefined) {
		const declared = new Set((settings.folders ?? []).map((folder) => folder.name.trim().toLowerCase()));
		const folderId = (name: string) => folders.find((folder) => String(folder.name).toLowerCase() === name.toLowerCase())?.id ?? null;
		items.push(...(await collectionItems(ctx, {
			kind: "rule", of: address, table: "routing_rules", owner: id ? { mailbox_id: id, scope: "mailbox" } : null, keyColumn: "pattern", idPrefix: "rr", complete: true,
			wanted: settings.rules.map((rule): Wanted => {
				const action = rule.action ?? (rule.folder ? "folder" : "spam");
				const into = action === "folder" ? String(rule.folder ?? "").trim() : "";
				const known = into ? folderId(into) : null;
				return {
					key: rule.value.trim(),
					columns: { match_field: rule.field ?? "email", match_operator: rule.operator ?? "contains", match_value: rule.value.trim(), action: action === "folder" ? "store" : action, priority: rule.priority ?? 0, enabled: 1, ...(action === "folder" ? (known ? { folder_id: known } : {}) : { folder_id: null }) },
					// The folder may be made by this same run, so its id is read at the last moment.
					pending: action === "folder" && !known,
					late: action === "folder" && !known ? async () => {
						const made = (await ctx.store.rows("folders", { mailbox_id: mailboxId() })).find((folder) => String(folder.name).toLowerCase() === into.toLowerCase());
						if (!made) throw new Error(`folder "${into}" does not exist in ${address}`);
						return { folder_id: made.id };
					} : undefined,
					onCreate: async () => ({ user_id: await ownerUserId(), domain_id: requireDomain(ctx).id }),
					problem: action === "folder" && !into ? "a rule that files mail needs a folder" : action === "folder" && !known && !declared.has(into.toLowerCase()) ? `folder "${into}" is neither in ${address} nor declared for it` : undefined,
				};
			}),
		})));
	}

	const assistant = settings.assistant;
	if (assistant) {
		const saved: SettingsRow = id ? (await ctx.store.rows("mailbox_agent_settings", { mailbox_id: id }))[0] ?? {} : {};
		const has = Object.keys(saved).length > 0;
		const more: Field[] = [];
		if (assistant.enabled !== undefined) more.push({ name: "assistant.enabled", wanted: assistant.enabled, stored: has ? flag(saved.enabled, false) : null, columns: { enabled: assistant.enabled ? 1 : 0 } });
		if (assistant.autoDraft !== undefined) more.push({ name: "assistant.autoDraft", wanted: assistant.autoDraft, stored: has ? flag(saved.auto_draft_enabled, false) : null, columns: { auto_draft_enabled: assistant.autoDraft ? 1 : 0 } });
		if (assistant.instructions !== undefined) more.push({ name: "assistant.instructions", wanted: assistant.instructions, stored: has ? saved.instructions ?? "" : null, columns: { instructions: assistant.instructions }, show: brief });
		if (assistant.dailyLimit !== undefined) more.push({ name: "assistant.dailyLimit", wanted: assistant.dailyLimit, stored: has ? Number(saved.daily_limit) : null, columns: { daily_limit: assistant.dailyLimit } });
		if (assistant.model !== undefined) more.push({ name: "assistant.model", wanted: assistant.model ?? null, stored: has ? saved.model_id ?? null : null, columns: { model_id: assistant.model ?? null } });
		if (assistant.reviewer !== undefined) {
			const email = assistant.reviewer?.trim().toLowerCase() ?? null;
			const reviewer = email ? await ctx.store.userIdByEmail(email) : null;
			more.push({
				name: "assistant.reviewer",
				// An address until it resolves, so a reviewer this run creates reads as a change.
				wanted: email ? reviewer ?? email : null,
				stored: has ? saved.reviewer_user_id ?? null : null,
				show: () => email ?? "none",
				problem: email && !reviewer && !declaresUser(ctx, email) ? `no local user ${email} to review its drafts` : undefined,
				columns: async () => ({ reviewer_user_id: email ? await ctx.store.userIdByEmail(email) : null }),
			});
		}
		items.push(...fieldItems(`mailbox.${address}`, more, async (columns) => ctx.store.upsertRow("mailbox_agent_settings", { mailbox_id: mailboxId() }, columns)));
	}
	return items;
}

export const mailboxSettingsResource: Resource = {
	section: "mailbox settings",
	declared: (ctx) => Boolean(ctx.domainName) && ((ctx.spec.mailboxes ?? []).some((entry) => says(entry, MAILBOX_KEYS)) || (ctx.spec.accounts ?? []).some((entry) => entry.mailbox !== undefined)),
	async items(ctx) {
		if (ctx.domain) await publishMailboxIds(ctx);
		const items: Item[] = [];
		for (const entry of ctx.spec.mailboxes ?? []) if (says(entry, MAILBOX_KEYS)) items.push(...(await mailboxItems(ctx, String(entry.role ?? entry.localPart).trim().toLowerCase(), entry)));
		for (const entry of ctx.spec.accounts ?? []) if (entry.mailbox) items.push(...(await mailboxItems(ctx, usernameOf(entry), entry.mailbox)));
		return items;
	},
};

// --- a person ----------------------------------------------------------------------

type Person = { label: string; email: string; userId: string | null; /** Their own mailbox: its role on this domain. */ role: string | null };

async function personItems(ctx: Context, who: Person, settings: PersonSettings & { forwardingEmail?: string | null; canManageMailboxes?: boolean; canManageDomains?: boolean; canManageUsers?: boolean }): Promise<Item[]> {
	const row: SettingsRow = who.userId ? (await ctx.store.rows("users", { id: who.userId }))[0] ?? {} : {};
	// Read at the moment of a write: the account may have been made earlier in this run.
	const userId = async () => {
		const id = who.userId ?? (await ctx.store.userIdByEmail(who.email));
		if (!id) throw new Error(`${who.email} does not exist`);
		return id;
	};
	const owner = who.userId ? { user_id: who.userId } : null;
	const items: Item[] = [];

	const fields: Field[] = [];
	const text = (name: string, column: string, value: string | null | undefined) => value !== undefined && fields.push({ name, wanted: value ?? null, stored: row[column] ?? null, columns: { [column]: value ?? null } });
	const toggle = (name: string, column: string, value: boolean | undefined, fallback: boolean) => value !== undefined && fields.push({ name, wanted: value, stored: flag(row[column], fallback), columns: { [column]: value ? 1 : 0 } });
	const preferences = settings.preferences ?? {};
	text("resetEmail", "reset_email", settings.resetEmail);
	text("forwardingEmail", "forwarding_email", settings.forwardingEmail);
	toggle("canManageMailboxes", "can_manage_mailboxes", settings.canManageMailboxes, false);
	toggle("canManageDomains", "can_manage_domains", settings.canManageDomains, false);
	toggle("canManageUsers", "can_manage_users", settings.canManageUsers, false);
	text("preferences.timeZone", "time_zone", preferences.timeZone);
	toggle("preferences.keyboardShortcuts", "keyboard_shortcuts_enabled", preferences.keyboardShortcuts, true);
	toggle("preferences.spamProtection", "spam_protection_enabled", preferences.spamProtection, true);
	toggle("preferences.showFullRecipientAddresses", "show_full_recipient_addresses", preferences.showFullRecipientAddresses, false);
	if (preferences.trashRetentionDays !== undefined) fields.push({ name: "preferences.trashRetentionDays", wanted: preferences.trashRetentionDays, stored: row.trash_retention_days === null || row.trash_retention_days === undefined ? null : Number(row.trash_retention_days), columns: { trash_retention_days: preferences.trashRetentionDays } });
	text("calendar.bookingUsername", "booking_username", settings.calendar?.bookingUsername?.trim().toLowerCase());
	items.push(...fieldItems(`account.${who.label}`, fields, async (columns) => ctx.store.updateRows("users", { id: await userId() }, columns)));

	// The app keeps a template as a message of status "template", sent from the person's mailbox.
	if (settings.templates !== undefined) {
		items.push(...(await collectionItems(ctx, {
			kind: "template", of: who.email, table: "messages", owner: who.userId ? { user_id: who.userId, status: "template" } : null, keyColumn: "subject", idPrefix: "msg", complete: true,
			wanted: settings.templates.map((template): Wanted => ({
				key: template.name.trim(),
				columns: { text_body: template.body, html_body: template.html ?? null, snippet: template.body.replace(/\s+/g, " ").slice(0, 200) },
				onCreate: () => ({ direction: "outbound", from_addr: who.email, to_addr: "", read: 1, mailbox_id: who.role ? ctx.mailboxIds.get(who.role) ?? null : null }),
			})),
		})));
	}

	if (settings.contacts !== undefined) {
		items.push(...(await collectionItems(ctx, {
			kind: "contact", of: who.email, table: "contacts", owner, keyColumn: "email", idPrefix: "con", complete: false,
			wanted: settings.contacts.map((contact): Wanted => ({
				key: contact.email.trim().toLowerCase(),
				columns: { ...(contact.name !== undefined ? { display_name: contact.name } : {}), ...(contact.blocked !== undefined ? { blocked: contact.blocked ? 1 : 0 } : {}) },
				onCreate: () => ({ source: "manual" }),
			})),
		})));
	}

	const calendar = settings.calendar ?? {};
	if (calendar.bookingPages !== undefined) {
		items.push(...(await collectionItems(ctx, {
			kind: "bookingPage", of: who.email, table: "booking_events", owner, keyColumn: "slug", idPrefix: "book", complete: true,
			wanted: calendar.bookingPages.map((page): Wanted => {
				// The app's own parser: what it would refuse in its form is a problem here.
				const parsed = parseBookingEventInput({ ...page, enabled: page.enabled ?? true, hostIds: [] });
				if (!parsed) return { key: page.slug ?? page.name, columns: {}, problem: "not a booking page the app accepts: times on the quarter hour, weekdays 0 to 6, a real time zone, 5 to 480 minutes" };
				return {
					key: parsed.slug,
					columns: { name: parsed.name, description: parsed.description, color: parsed.color, duration_minutes: parsed.durationMinutes, location: parsed.location, weekdays: JSON.stringify(parsed.weekdays), start_time: parsed.startTime, end_time: parsed.endTime, time_ranges: JSON.stringify(parsed.timeRanges), time_zone: parsed.timeZone, enabled: parsed.enabled ? 1 : 0 },
					onCreate: () => ({ host_ids: JSON.stringify(who.userId ? [who.userId] : []) }),
					late: who.userId ? undefined : async () => ({ host_ids: JSON.stringify([await userId()]) }),
				};
			}),
		})));
	}
	if (calendar.events !== undefined) {
		items.push(...(await collectionItems(ctx, {
			kind: "event", of: who.email, table: "calendar_events", owner, keyColumn: "title", idPrefix: "evt", complete: false,
			wanted: calendar.events.map((event): Wanted => ({
				key: event.title.trim(),
				columns: {
					starts_at: seconds(event.startsAt), ends_at: seconds(event.endsAt), repeat: event.repeat ?? "none",
					repeat_days: JSON.stringify(event.repeat === "weekdays" ? event.repeatDays ?? [1, 2, 3, 4, 5] : []),
					...(event.description !== undefined ? { description: event.description } : {}), ...(event.location !== undefined ? { location: event.location } : {}),
					...(event.timeZone !== undefined ? { time_zone: event.timeZone } : {}), ...(event.color !== undefined ? { color: event.color } : {}),
				},
			})),
		})));
	}

	// Drive folders are paths, each made under its parent. They may hold files, so none is removed.
	for (const path of [...new Set((settings.drive?.folders ?? []).flatMap((folder) => folder.split("/").map((part) => part.trim()).filter(Boolean).map((_, index, parts) => parts.slice(0, index + 1).join("/"))))].sort()) {
		const folders = async () => (await ctx.store.rows("drive_items", { owner_id: await userId(), kind: "folder" })).filter((entry) => entry.trashed_at === null || entry.trashed_at === undefined);
		const find = (all: SettingsRow[], wanted: string): SettingsRow | null => wanted.split("/").reduce<SettingsRow | null | undefined>((parent, name) => (parent === null ? null : all.find((entry) => (entry.parent_id ?? null) === (parent?.id ?? null) && String(entry.name) === name) ?? null), undefined) ?? null;
		const existing = who.userId ? find(await folders(), path) : null;
		items.push({
			address: `drive.${who.email}.${path}`,
			actual: async () => existing,
			create: async () => {
				const all = await folders();
				const parent = path.includes("/") ? find(all, path.slice(0, path.lastIndexOf("/"))) : null;
				if (path.includes("/") && !parent) throw new Error("its parent folder was not made");
				await ctx.store.insertRow("drive_items", { id: newId("drv"), owner_id: await userId(), parent_id: parent?.id ?? null, kind: "folder", name: path.slice(path.lastIndexOf("/") + 1), size: 0, content_type: "application/x-directory" });
			},
			removable: async () => null,
			remove: async () => undefined,
		});
	}

	if (settings.webhooks !== undefined) {
		items.push(...(await collectionItems(ctx, {
			kind: "webhook", of: who.email, table: "webhooks", owner, keyColumn: "url", idPrefix: "wh", complete: true,
			forgotten: (url) => ctx.vault.forgetSecret("webhooks", `${who.email} ${url}`),
			wanted: settings.webhooks.map((hook): Wanted => ({
				key: hook.url.trim(),
				columns: { description: hook.description?.trim() || null, events: JSON.stringify(hook.events), enabled: hook.enabled === false ? 0 : 1, max_attempts: hook.maxAttempts ?? 5 },
				// The signing secret is made once and written down; the app never shows it again.
				onCreate: () => ({ secret: newId("whsec") }),
				created: (made) => {
					ctx.vault.recordSecret("webhooks", `${who.email} ${hook.url.trim()}`, String(made.secret));
					return `signing secret written to ${ctx.vault.where}`;
				},
				removed: () => ctx.vault.forgetSecret("webhooks", `${who.email} ${hook.url.trim()}`),
			})),
		})));
	}

	if (settings.apiKeys !== undefined) {
		const secrets = new Map<string, string>();
		items.push(...(await collectionItems(ctx, {
			kind: "apiKey", of: who.email, table: "api_keys", owner: who.userId ? { user_id: who.userId, kind: "legacy" } : null, keyColumn: "name", idPrefix: "key", complete: true,
			forgotten: (name) => ctx.vault.forgetSecret("apiKeys", `${who.email}/${name}`),
			// Not this system's own temporary key, and not an admin key: those are issued elsewhere.
			ours: (key) => key.name !== "state" && !ADMIN_API_KEY_SCOPES.some((scope) => String(key.scopes).includes(`"${scope}"`)),
			wanted: settings.apiKeys.map((key): Wanted => ({
				key: key.name.trim(),
				columns: { scopes: JSON.stringify(key.scopes) },
				onCreate: () => {
					const { fullKey, prefix, hash } = generateApiKey();
					secrets.set(key.name, fullKey);
					return { prefix, key_hash: hash, mailbox_scope_enabled: 1 };
				},
				// A personal key reaches only the mailboxes it is given: the person's own, unless it says.
				created: async (made) => {
					for (const role of key.mailboxes ?? (who.role ? [who.role] : [])) {
						const mailboxId = ctx.mailboxIds.get(role.trim().toLowerCase());
						if (!mailboxId) throw new Error(`mailbox "${role}" does not exist, so the key cannot be given it`);
						await ctx.store.insertRow("mcp_key_mailboxes", { key_id: made.id, mailbox_id: mailboxId });
					}
					ctx.vault.recordSecret("apiKeys", `${who.email}/${key.name.trim()}`, secrets.get(key.name) ?? "");
					return `key written to ${ctx.vault.where}`;
				},
				removed: () => ctx.vault.forgetSecret("apiKeys", `${who.email}/${key.name.trim()}`),
			})),
		})));
	}
	return items;
}

export const peopleResource: Resource = {
	section: "people",
	declared: (ctx) => (ctx.domainName ? (ctx.spec.accounts ?? []).some((entry) => says(entry, PERSON_KEYS)) : ctx.spec.admin !== undefined),
	async items(ctx) {
		ctx.vault.at(ctx.store.base);
		if (!ctx.domainName) {
			const admin = await ctx.store.admin();
			return personItems(ctx, { label: "admin", email: admin.email, userId: admin.id, role: null }, ctx.spec.admin ?? {});
		}
		if (ctx.domain) await publishMailboxIds(ctx);
		const items: Item[] = [];
		for (const entry of ctx.spec.accounts ?? []) {
			if (!says(entry, PERSON_KEYS)) continue;
			const email = `${usernameOf(entry)}@${ctx.domainName}`;
			items.push(...(await personItems(ctx, { label: usernameOf(entry), email, userId: await ctx.store.userIdByEmail(email), role: usernameOf(entry) }, entry)));
		}
		return items;
	},
};
