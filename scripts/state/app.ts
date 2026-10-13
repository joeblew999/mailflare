// App-coupled helpers: the app's own request schemas, and opening the live Store.
import { addDomainSchema, createUserAccountSchema, mailboxSchema, updateMailboxSchema, updateManagedAccountSchema } from "@/lib/validators";
import { makeLiveStore, type Instance } from "./store/live";
import type { Store } from "./store/types";

// The app's own request schemas, keyed by what we send.
const REQUEST_SCHEMAS = {
	domain: addDomainSchema,
	mailbox: mailboxSchema,
	mailboxUpdate: updateMailboxSchema,
	account: createUserAccountSchema,
	accountUpdate: updateManagedAccountSchema,
};

/** Check a body against the schema the app will apply, so a bad one fails here with a reason. */
export function validateBody<T>(kind: keyof typeof REQUEST_SCHEMAS, body: T): T {
	const parsed = REQUEST_SCHEMAS[kind].safeParse(body);
	if (!parsed.success) throw new Error(`the app's ${kind} schema rejected this: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
	// The body as written, not as parsed: the schemas' transforms turn omissions into nulls
	// that the app's own parse then refuses.
	return body;
}

export type OpenStore = <T>(instance: Instance, fn: (store: Store) => Promise<T>) => Promise<T>;

// Stores holding a temporary admin key. An interrupted run still removes its key.
const open = new Set<Store>();
let hooked = false;
function disposeOnSignal() {
	if (hooked) return;
	hooked = true;
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			void Promise.allSettled([...open].map((store) => store.dispose())).then(() => process.exit(130));
		});
	}
}

/**
 * Run `fn` against a live Store and always dispose it. ONE temporary admin key covers the whole
 * run, minted on the first HTTP call - so a run that only touches instance data needs no origin.
 */
export const withStore: OpenStore = async (instance, fn) => {
	disposeOnSignal();
	const store = makeLiveStore(instance);
	open.add(store);
	try {
		return await fn(store);
	} finally {
		open.delete(store);
		await store.dispose().catch((error) => console.warn(`  ⚠ could not remove the temporary admin key: ${error instanceof Error ? error.message : error}`));
	}
};
