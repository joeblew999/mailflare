import { PROVIDER_BASE_URLS } from "@/lib/agent/provider-constants";
import { credential } from "../wrangler";
import type { Context } from "../context";
import type { AssistantEntry, BackupsEntry, SettingsEntry } from "../spec";
import type { Item, Resource } from "./resource";
import type { ManagedTable, SettingsRow } from "../store/types";

const GIB = 1024 ** 3;

/** One setting: what the document wants, what is stored (in the document's terms), and how to write it. */
export type Field = {
	name: string;
	wanted: unknown;
	stored: unknown;
	/** What to write: known now, or only at the moment of the write. */
	columns: SettingsRow | (() => Promise<SettingsRow>);
	/** Never printed. */
	secret?: boolean;
	problem?: string;
	show?(value: unknown): string;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const show = (value: unknown) => (value === null ? "none" : typeof value === "string" ? `"${value}"` : JSON.stringify(value));
export const flag = (value: unknown, fallback: boolean) => (value === null || value === undefined ? fallback : Boolean(Number(value)));
const fromEnv = (name: string) => credential(name);
const unset = (name: string) => `$${name} is not set (environment or keychain)`;

/** Each declared setting is its own item, so a plan says exactly which one differs. */
export function fieldItems(section: string, fields: Field[], save: (columns: SettingsRow) => Promise<void>): Item[] {
	return fields.map((field) => {
		const print = field.secret ? () => "(secret)" : field.show ?? show;
		const write = async () => {
			await save(typeof field.columns === "function" ? await field.columns() : field.columns);
			return field.secret ? "set" : print(field.wanted);
		};
		return {
			address: `${section}.${field.name}`,
			wants: field.secret ? "set from the environment" : `${print(field.stored)} → ${print(field.wanted)}`,
			problem: field.problem,
			actual: async () => ({ value: field.stored }),
			satisfied: () => same(field.stored, field.wanted),
			create: write,
			update: write,
			// A setting always has some value, so destroy has nothing to take away.
			removable: async () => null,
			remove: async () => undefined,
		};
	});
}

function assistantProvider(row: SettingsRow, assistant: AssistantEntry): Field {
	const stored = { provider: row.agent_provider ?? null, preset: row.agent_preset ?? null, baseUrl: row.agent_base_url ?? null, model: row.agent_model ?? null, apiKey: row.agent_api_key ?? null };
	const compatible = assistant.provider === "compatible";
	const preset = compatible ? assistant.preset ?? "custom" : null;
	const models = assistant.models ?? [];
	const wanted = {
		provider: assistant.provider!,
		preset,
		baseUrl: preset === null ? null : preset === "custom" ? (assistant.baseUrl ?? "").replace(/\/+$/, "") : PROVIDER_BASE_URLS[preset],
		model: models.length > 0 ? models.join(", ") : null,
		apiKey: compatible && assistant.apiKeyEnv ? fromEnv(assistant.apiKeyEnv) : null,
	};
	const describe = (value: unknown) => {
		const v = value as typeof wanted;
		return v.provider ? `${v.provider}${v.preset ? `/${v.preset}` : ""}${v.model ? ` ${v.model}` : ""}` : "the default";
	};
	return {
		name: "assistant.provider",
		wanted,
		stored,
		show: describe,
		problem: compatible && assistant.apiKeyEnv && !wanted.apiKey ? unset(assistant.apiKeyEnv) : undefined,
		columns: {
			agent_provider: wanted.provider,
			agent_preset: wanted.preset,
			agent_base_url: wanted.baseUrl,
			agent_model: wanted.model,
			agent_api_key: wanted.apiKey,
			agent_model_rates: JSON.stringify(Object.fromEntries(models.map((model) => [model, { input: null, output: null }]))),
		},
	};
}

function appFields(row: SettingsRow, settings: SettingsEntry): Field[] {
	const fields: Field[] = [];
	if (settings.appName !== undefined) fields.push({ name: "appName", wanted: settings.appName.trim(), stored: row.app_name ?? "Mailflare", columns: { app_name: settings.appName.trim() } });
	if (settings.outboundAttachmentMaxMb !== undefined) {
		fields.push({ name: "outboundAttachmentMaxMb", wanted: settings.outboundAttachmentMaxMb, stored: Number(row.outbound_attachment_max_mb ?? 25), columns: { outbound_attachment_max_mb: settings.outboundAttachmentMaxMb } });
	}
	if (settings.driveStorageLimitGb !== undefined) {
		const bytes = row.drive_storage_limit_bytes;
		const wantedBytes = settings.driveStorageLimitGb === null ? null : Math.round(settings.driveStorageLimitGb * GIB);
		fields.push({ name: "driveStorageLimitGb", wanted: wantedBytes, stored: bytes === null || bytes === undefined ? null : Number(bytes), columns: { drive_storage_limit_bytes: wantedBytes }, show: (value) => (value === null ? "no limit" : `${Math.round((Number(value) / GIB) * 100) / 100} GB`) });
	}
	const assistant = settings.assistant;
	if (assistant?.enabled !== undefined) fields.push({ name: "assistant.enabled", wanted: assistant.enabled, stored: flag(row.agent_enabled, true), columns: { agent_enabled: assistant.enabled ? 1 : 0 } });
	if (assistant?.provider !== undefined) fields.push(assistantProvider(row, assistant));
	if (settings.resendApiKeyEnv !== undefined) {
		const value = fromEnv(settings.resendApiKeyEnv);
		fields.push({ name: "resendApiKey", wanted: value, stored: row.resend_api_key ?? null, columns: { resend_api_key: value }, secret: true, problem: value ? undefined : unset(settings.resendApiKeyEnv) });
	}
	if (settings.aws !== undefined) {
		let saved: { accessKeyId?: string; secretAccessKey?: string; region?: string; accountId?: string } = {};
		try {
			saved = JSON.parse(String(row.aws_config ?? "{}")) ?? {};
		} catch {
			// an unreadable value is one to replace
		}
		const wanted = { accessKeyId: fromEnv(settings.aws.accessKeyIdEnv), secretAccessKey: fromEnv(settings.aws.secretAccessKeyEnv), region: settings.aws.region };
		const missing = [settings.aws.accessKeyIdEnv, settings.aws.secretAccessKeyEnv].filter((name) => !fromEnv(name));
		// The account id is what the app learned when it validated these credentials; it holds for the same key.
		const accountId = saved.accessKeyId === wanted.accessKeyId ? saved.accountId : undefined;
		fields.push({
			name: "aws",
			wanted,
			stored: { accessKeyId: saved.accessKeyId ?? null, secretAccessKey: saved.secretAccessKey ?? null, region: saved.region ?? null },
			columns: { aws_config: JSON.stringify({ ...wanted, ...(accountId ? { accountId } : {}) }) },
			secret: true,
			problem: missing.length > 0 ? missing.map(unset).join(", ") : undefined,
		});
	}
	return fields;
}

function backupFields(row: SettingsRow, backups: BackupsEntry): Field[] {
	const fields: Field[] = [];
	if (backups.enabled !== undefined) fields.push({ name: "enabled", wanted: backups.enabled, stored: flag(row.enabled, false), columns: { enabled: backups.enabled ? 1 : 0 } });
	if (backups.schedule !== undefined) {
		const wanted = { type: backups.schedule, day: backups.schedule === "daily" ? null : backups.scheduleValue ?? null };
		fields.push({
			name: "schedule",
			wanted,
			stored: { type: row.schedule_type ?? "daily", day: row.schedule_type && row.schedule_type !== "daily" ? row.schedule_value ?? null : null },
			columns: { schedule_type: wanted.type, schedule_value: wanted.day },
			show: (value) => {
				const v = value as typeof wanted;
				return v.day === null ? String(v.type) : `${v.type} on day ${v.day}`;
			},
		});
	}
	if (backups.retentionDays !== undefined) {
		const kept = backups.retentionDays;
		fields.push({
			name: "retentionDays",
			wanted: kept,
			stored: flag(row.retention_enabled, false) ? Number(row.retention_days ?? 30) : null,
			columns: kept === null ? { retention_enabled: 0 } : { retention_enabled: 1, retention_days: kept },
			show: (value) => (value === null ? "keep everything" : `${value} day(s)`),
		});
	}
	if (backups.exclude !== undefined) {
		let stored: string[] = [];
		try {
			stored = JSON.parse(String(row.excluded_table_groups ?? "[]"));
		} catch {
			// an unreadable value is one to replace
		}
		const wanted = [...new Set(backups.exclude)].sort();
		fields.push({ name: "exclude", wanted, stored: [...stored].sort(), columns: { excluded_table_groups: JSON.stringify(wanted) } });
	}
	return fields;
}

// Both instance tables hold one row, keyed 'default'.
const DEFAULT = { id: "default" };
const instanceRow = async (ctx: Context, table: ManagedTable): Promise<SettingsRow> => (await ctx.store.rows(table, DEFAULT))[0] ?? {};

export const settingsResource: Resource = {
	section: "settings",
	declared: (ctx) => ctx.spec.settings !== undefined,
	items: async (ctx) => fieldItems("settings", appFields(await instanceRow(ctx, "app_settings"), ctx.spec.settings ?? {}), (columns) => ctx.store.upsertRow("app_settings", DEFAULT, columns)),
};

// A server whose backups are on HAS a backup: the first is taken as it is provisioned, not
// at the next 02:00 UTC, so one that cannot be made is found now rather than when it is needed.
const firstBackup = (ctx: Context): Item => ({
	address: "backups.first",
	wants: "none has completed yet, so one is taken now",
	actual: async () => (await ctx.store.rows("backups", { status: "completed" }))[0] ?? null,
	create: async () => `taken (${await ctx.store.takeBackup()})`,
	// Backups are kept when the settings go: deleting data is never a side effect.
	removable: async () => null,
	remove: async () => undefined,
});

export const backupsResource: Resource = {
	section: "backups",
	declared: (ctx) => ctx.spec.backups !== undefined,
	items: async (ctx) => [
		...fieldItems("backups", backupFields(await instanceRow(ctx, "backup_settings"), ctx.spec.backups ?? {}), (columns) => ctx.store.upsertRow("backup_settings", DEFAULT, columns)),
		...(ctx.spec.backups?.enabled === true ? [firstBackup(ctx)] : []),
	],
};
