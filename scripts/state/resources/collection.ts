// One reconciler for any LIST the app keeps per person or per mailbox - folders, rules,
// templates, webhooks... Each is rows with an owner and a natural key, so each gets the same
// create, update and remove, and the same rule: a list the document writes is complete.
import { newId } from "@/lib/ids";
import type { Context } from "../context";
import type { Item, Note } from "./resource";
import type { ManagedTable, SettingValue, SettingsRow } from "../store/types";

export type Wanted = {
	/** What identifies the row among its owner's. */
	key: string;
	/** The columns the document decides. */
	columns: SettingsRow;
	/** Columns that can only be known at the moment of the write: an id made earlier in the run. */
	late?: () => Promise<SettingsRow>;
	/** Given once, when the row is made: a secret, or what the app would have defaulted. */
	onCreate?: () => SettingsRow | Promise<SettingsRow>;
	/** Depends on something this run has yet to make, so it cannot be satisfied yet. */
	pending?: boolean;
	problem?: string;
	created?(row: SettingsRow): Promise<Note> | Note;
	removed?(): void;
};

export type Collection = {
	/** The address prefix: `folder`, `template`… */
	kind: string;
	/** Whose: `support@acme.de`, `sam@acme.de`. */
	of: string;
	table: ManagedTable;
	/** The columns that say whose rows these are. Null while the owner does not exist yet. */
	owner: SettingsRow | null;
	keyColumn: string;
	idPrefix: string;
	wanted: Wanted[];
	/** The document writes this list, so anything else of the owner's is removed. */
	complete: boolean;
	/** Which of the owner's rows are this list's at all. */
	ours?(row: SettingsRow): boolean;
	/** Called with the key of a row that was removed for being in no document. */
	forgotten?(key: string): void;
};

const plain = (value: SettingValue | undefined) => (value === undefined || value === null ? "" : String(value));
const fold = (value: SettingValue | undefined) => plain(value).trim().toLowerCase();

export async function collectionItems(ctx: Context, list: Collection): Promise<Item[]> {
	const rows = list.owner ? (await ctx.store.rows(list.table, list.owner)).filter(list.ours ?? (() => true)) : [];
	const byKey = new Map(rows.map((row) => [fold(row[list.keyColumn]), row]));
	const address = (key: string) => `${list.kind}.${list.of}.${key}`;

	const items: Item[] = list.wanted.map((entry) => {
		const existing = byKey.get(fold(entry.key)) ?? null;
		const changed = existing ? Object.keys(entry.columns).filter((column) => plain(existing[column]) !== plain(entry.columns[column])) : [];
		return {
			address: address(entry.key),
			wants: existing ? changed.join(", ") || undefined : undefined,
			problem: entry.problem,
			actual: async () => existing,
			satisfied: (actual) => !!actual && changed.length === 0 && !entry.pending,
			create: async () => {
				if (!list.owner) throw new Error(`${list.of} does not exist, so there is nowhere to put it`);
				const row = { id: newId(list.idPrefix), ...list.owner, [list.keyColumn]: entry.key, ...entry.columns, ...((await entry.onCreate?.()) ?? {}), ...((await entry.late?.()) ?? {}) };
				await ctx.store.insertRow(list.table, row);
				return entry.created?.(row);
			},
			update: async (actual) => {
				const late = (await entry.late?.()) ?? {};
				await ctx.store.updateRows(list.table, { id: (actual as SettingsRow).id }, { ...Object.fromEntries(changed.map((column) => [column, entry.columns[column]])), ...late });
				return [...changed, ...Object.keys(late)].join(", ");
			},
			remove: async (present) => {
				await ctx.store.deleteRows(list.table, { id: (present as SettingsRow).id });
				entry.removed?.();
			},
			// On destroy these go with their owner, or are kept with it: never one by one.
			removable: async () => null,
		};
	});

	const named = new Set(list.wanted.map((entry) => fold(entry.key)));
	for (const row of list.complete ? rows.filter((entry) => !named.has(fold(entry[list.keyColumn]))) : []) {
		items.push({
			address: address(plain(row[list.keyColumn])),
			undeclared: true,
			actual: async () => row,
			removable: async () => null,
			remove: async () => {
				await ctx.store.deleteRows(list.table, { id: row.id });
				list.forgotten?.(plain(row[list.keyColumn]));
			},
		});
	}
	return items;
}
