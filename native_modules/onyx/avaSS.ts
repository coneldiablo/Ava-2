import "server-only";

import { headers } from "next/headers";

// The gateway removes these headers from browser traffic and adds one trusted
// pair before it reaches the web service. Never manufacture either value: an
// absent pair must fail before a fetch; caller options cannot supply identity.
const NATIVE_SSR_HEADERS = [
  "x-ava-native-peer",
  "x-ava-native-binding",
] as const;

export async function forwardedNativeHeadersSS(): Promise<Record<string, string>> {
  const requestHeaders = await headers();
  const forwarded: Record<string, string> = {};

  for (const name of NATIVE_SSR_HEADERS) {
    const value = requestHeaders.get(name);
    const pattern = name === "x-ava-native-peer"
      ? /^[A-Za-z0-9_-]{43}$/
      : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (!value || !pattern.test(value)) throw new Error("AVA_NATIVE_SSR_DENIED");
    forwarded[name] = value;
  }

  return forwarded;
}
