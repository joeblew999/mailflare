// App-coupled helpers for scripts run under `tsx` (so they resolve `@/` paths).
// Validating request bodies here means a hand-written body cannot drift from what
// the route accepts: it throws before the request is made, instead of 400-ing
// halfway through a run.
import { addDomainSchema, createUserAccountSchema, mailboxSchema, updateManagedAccountSchema } from "@/lib/validators";
import { makeLiveStore } from "./provision/store-live";
import type { Store } from "./provision/store-types";

// The app's own request schemas, keyed by what we send.
const REQUEST_SCHEMAS = {
	domain: addDomainSchema,
	mailbox: mailboxSchema,
	account: createUserAccountSchema,
	accountUpdate: updateManagedAccountSchema,
};

export function validateBody(kind: string, body: unknown) {
	const schema = REQUEST_SCHEMAS[kind as keyof typeof REQUEST_SCHEMAS];
	if (!schema) throw new Error(`no schema registered for "${kind}"`);
	const parsed = schema.safeParse(body);
	if (!parsed.success) {
		throw new Error(`the app's ${kind} schema rejected this body: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
	}
	return parsed.data;
}

/**
 * Run `fn` against the live Store and always dispose it. The store resolves the
 * instance URL and mints its temporary admin key lazily, on the first HTTP call, so
 * a run that only touches global data (license, web push) needs neither Cloudflare
 * credentials nor an instance URL. ONE key covers the whole run, which is what lets
 * a mass run touch thousands of domains without thousands of key round-trips.
 */
export async function withProvisionStore(
	{ db, local, url, name = "provision" }: { db?: string; local?: boolean; url?: string; name?: string },
	fn: (store: Store) => Promise<number>,
): Promise<number> {
	const store = makeLiveStore({ db, local, url, name });
	try {
		return await fn(store);
	} finally {
		store.dispose();
	}
}
