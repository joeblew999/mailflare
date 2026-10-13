// How to run, never what to build. The verb sets the first three; they combine: a destroy or
// reset that was not confirmed is `status` as well, and reports instead of writing.
export type Flags = {
	/** Report only: nothing is written. */
	status: boolean;
	/** Walk in reverse, removing. */
	cleanup: boolean;
	/** Wipe the instance before anything else. */
	fresh: boolean;
	/** Destructive actions need approval, as in terraform. */
	confirmMx: boolean;
	confirmDestroy: boolean;
	/** Give every declared account a new password and every declared key a new secret, and record them. */
	rotatePasswords: boolean;
	/** Which instance to act on. */
	url?: string;
	db: string;
	local: boolean;
};
