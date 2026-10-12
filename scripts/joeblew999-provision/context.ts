import { d1 as libD1, request } from "../joeblew999-lib";
import { withAdminKey } from "../joeblew999-lib-app";
import type { ApiDomain, Context, Flags, ProjectManifest } from "./types";

// Resource helpers only run after ensureDomain resolved the domain; a null one means
// the flags asked us to stop, so it is a programming error rather than user input.
export function requireDomain(ctx: Context): ApiDomain {
	if (!ctx.domain) throw new Error(`domain ${ctx.domainName} is not resolved`);
	return ctx.domain;
}

// Build the Context (resolved URL + minted admin key) and run `fn`. withAdminKey
// always deletes the temporary key afterwards.
export async function withContext(
	flags: Flags,
	project: ProjectManifest | null,
	domainName: string,
	fn: (ctx: Context) => Promise<number>,
): Promise<number> {
	try {
		return await withAdminKey({ db: flags.db, local: flags.local, url: flags.url, name: "provision" }, async ({ base, key, admin }) => {
			const ctx: Context = {
				base,
				key,
				admin: { id: admin.id, email: admin.email },
				flags,
				project,
				domainName,
				domain: null,
				d1: (sql: string) => libD1(sql, { db: flags.db, local: flags.local }),
				api: (path: string, options: { method?: string; body?: unknown } = {}) => request(base, path, { key, ...options }),
			};
			return fn(ctx);
		});
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
