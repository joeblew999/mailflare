// What the command line asked for. Deliberately flat and primitive: each flag is
// either a switch or a string, and every resource reads the ones it cares about.
// Global capabilities (fresh, plan, push) need no domain; the rest do.
export type Flags = {
	dryRun: boolean;
	/** Required for --destroy to act, like --confirm-mx. */
	confirmDestroy: boolean;
	status: boolean;
	cleanup: boolean;
	confirmMx: boolean;
	replaceMx: boolean;
	url?: string;
	db: string;
	local: boolean;
	fresh: boolean;
	adminEmail?: string;
	adminPassword?: string;
	plan?: string;
	push: boolean;
	to?: string;
	from?: string;
	subject?: string;
	timeout: string;
};
