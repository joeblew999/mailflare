import type { Item, Resource } from "./resource";

// What is on the SERVER and in no document of its project. It rides on the instance document,
// and only when the whole project is being run: one document cannot speak for the others.
export const undeclaredResource: Resource = {
	section: "undeclared",
	declared: (ctx) => ctx.project !== null && !ctx.domainName,
	async items(ctx) {
		const project = ctx.project!;
		const items: Item[] = [];
		// Key names are instance-wide, so a key no document names is nobody's - once any document
		// writes an mcpKeys section. Until one does, keys are not managed at all.
		for (const key of project.keys ? await ctx.store.mcpKeyNames() : []) {
			if (project.keys!.has(key.name)) continue;
			items.push({
				address: `mcpKey.${key.name}`,
				undeclared: true,
				actual: async () => key,
				remove: async () => {
					await ctx.store.deleteMcpKey(key.id);
					ctx.vault.forgetKey(key.name);
				},
			});
		}
		// A whole domain is never removed for want of a document: it is said, and left.
		for (const domain of await ctx.store.domainNames()) {
			if (project.domains.has(domain)) continue;
			items.push({ address: `domain.${domain}`, unmanaged: `on the server, and no document declares it — add ${domain}.json, or remove it in the app`, actual: async () => null, remove: async () => undefined });
		}
		return items;
	},
};
