#!/usr/bin/env node
// Generate a Web Push (VAPID) key pair, printed as env vars for `npm run push:keys`.
// Public key is the raw uncompressed P-256 point (65 bytes); the private key is the
// JWK scalar "d" (32 bytes). Both are base64url — the format src/lib/push/server.ts
// validates before signing.
import { webcrypto } from "node:crypto";

// base64url without padding, which is what the Push API expects.
function base64Url(bytes) {
	return Buffer.from(bytes).toString("base64url");
}

const pair = await webcrypto.subtle.generateKey(
	{ name: "ECDSA", namedCurve: "P-256" },
	true,
	["sign", "verify"],
);
const publicKey = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
const privateJwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);

if (!privateJwk.d) throw new Error("Generated VAPID private key is missing its scalar");

console.log(`VAPID_PUBLIC_KEY=${base64Url(publicKey)}`);
console.log(`VAPID_PRIVATE_KEY=${privateJwk.d}`);
console.log("VAPID_SUBJECT=mailto:admin@example.com");
