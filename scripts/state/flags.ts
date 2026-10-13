// What the command line asked for. Deliberately flat and primitive: each flag is
// either a switch or a string, and every resource reads the ones it cares about.
// Global capabilities (fresh, plan, push) need no domain; the rest do.
export type Flags = {
	/** Which verb was asked for. */
	status: boolean;
	cleanup: boolean;
	fresh: boolean;
	/** Destructive actions need approval, as in terraform. */
	confirmMx: boolean;
	confirmDestroy: boolean;
	/** Which instance to act on. */
	url?: string;
	db: string;
	local: boolean;
};
