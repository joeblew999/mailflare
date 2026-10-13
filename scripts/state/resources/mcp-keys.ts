import { declaresMailbox, type Context } from "../context";
import { publishMailboxIds } from "./mailboxes";
import { MCP_SCOPES, type McpKeyEntry } from "../spec";
import type { Resource } from "./resource";
import type { McpKeyRow } from "../store/types";

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/** The mailboxes a key is restricted to: their ids, the roles not there yet, and the unknown ones. */
function restriction(ctx: Context, entry: McpKeyEntry): { ids: string[] | null; pending: string[]; missing: string[] } {
	// No list at all is an unrestricted key, and that has to be said, never arrived at.
	if (!entry.mailboxes?.length) return { ids: null, pending: [], missing: [] };
	const ids: string[] = [];
	const pending: string[] = [];
	const missing: string[] = [];
	for (const name of entry.mailboxes) {
		const role = name.trim().toLowerCase();
		const id = ctx.mailboxIds.get(role);
		if (id) ids.push(id);
		else (declaresMailbox(ctx, role) ? pending : missing).push(role);
	}
	return { ids, pending, missing };
}

export const mcpKeysResource: Resource = {
	section: "mcpKeys",
	declared: (ctx) => (ctx.spec.mcpKeys?.length ?? 0) > 0,
	async items(ctx) {
		if (ctx.domain) await publishMailboxIds(ctx);
		return Promise.all((ctx.spec.mcpKeys ?? []).map(async (entry) => {
			const name = String(entry.name ?? "agent").trim();
			const scopes = entry.scopes?.length ? entry.scopes : [...MCP_SCOPES];
			const existing = await ctx.store.mcpKey(name);
			const planned = restriction(ctx, entry);
			// The ids as they are at the moment of the write, once this run's mailboxes exist.
			const resolve = () => {
				const now = restriction(ctx, entry);
				const absent = [...now.pending, ...now.missing];
				// A key that lost a mailbox would be one that reaches every mailbox instead.
				if (absent.length > 0) throw new Error(`mailbox ${absent.join(", ")} does not exist, so the key cannot be restricted to it`);
				return now.ids;
			};
			// A key's secret cannot be read back, so rotating means minting another in its place.
			const rotate = ctx.flags.rotatePasswords && !!existing;
			const mint = async () => {
				const { fullKey } = await ctx.store.createMcpKey({ name, scopes, mailboxIds: resolve() });
				ctx.vault.at(ctx.store.base);
				ctx.vault.recordKey(name, fullKey);
				return `key written to ${ctx.vault.where}`;
			};
			return {
				address: `mcpKey.${name}`,
				wants: `${rotate ? "mint a new key, " : ""}${scopes.length} scope(s), ${entry.mailboxes?.length ? `mailboxes ${entry.mailboxes.join(", ")}` : "every mailbox"}`,
				problem: planned.missing.length > 0 ? `mailbox "${planned.missing.join('", "')}" is neither on the domain nor declared in this document` : undefined,
				actual: async () => existing,
				satisfied: (actual: unknown) => {
					const key = actual as McpKeyRow | null;
					if (!key || rotate || planned.pending.length > 0 || !sameSet(key.scopes, scopes)) return false;
					return planned.ids === null ? key.mailboxIds === null : key.mailboxIds !== null && sameSet(key.mailboxIds, planned.ids);
				},
				create: mint,
				// The secret stays as it is unless it is being rotated: only what the key may reach is rewritten.
				update: async (actual: unknown) => {
					if (rotate) {
						resolve();
						await ctx.store.deleteMcpKey((actual as McpKeyRow).id);
						return mint();
					}
					await ctx.store.updateMcpKey((actual as McpKeyRow).id, { scopes, mailboxIds: resolve() });
					return "scopes and mailboxes rewritten; the key itself is unchanged";
				},
				remove: async (present: unknown) => {
					await ctx.store.deleteMcpKey((present as McpKeyRow).id);
					ctx.vault.forgetKey(name);
				},
			};
		}));
	},
};
