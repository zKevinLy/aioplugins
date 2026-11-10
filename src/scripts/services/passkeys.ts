// Browser side of passkeys (WebAuthn): register, list, remove, sign in.

import { api } from "../core/api.js";
import type { UserResponse } from "../core/types.js";

export interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

function toBuffer(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function toBase64Url(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && "PublicKeyCredential" in window && !!navigator.credentials;
}

function cancelled(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError");
}

export function passkeyErrorMessage(error: unknown): string {
  if (cancelled(error)) return "Passkey request was cancelled.";
  if (error instanceof DOMException && error.name === "InvalidStateError") {
    return "This passkey is already registered.";
  }
  return error instanceof Error ? error.message : "Passkey request failed.";
}

export async function listPasskeys(): Promise<PasskeyInfo[]> {
  return (await api<{ passkeys: PasskeyInfo[] }>("/api/passkeys")).passkeys;
}

export async function removePasskey(id: string): Promise<PasskeyInfo[]> {
  return (await api<{ passkeys: PasskeyInfo[] }>("/api/passkeys", { id }, "DELETE")).passkeys;
}

export async function addPasskey(name: string): Promise<void> {
  const options = await api<{
    challenge: string;
    rp: PublicKeyCredentialRpEntity;
    user: { id: string; name: string; displayName: string };
    pubKeyCredParams: PublicKeyCredentialParameters[];
    authenticatorSelection: AuthenticatorSelectionCriteria;
    attestation: AttestationConveyancePreference;
    timeout: number;
    excludeCredentials: { type: "public-key"; id: string }[];
  }>("/api/passkeys/options", {});

  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: toBuffer(options.challenge),
      rp: options.rp,
      user: { ...options.user, id: toBuffer(options.user.id) },
      pubKeyCredParams: options.pubKeyCredParams,
      authenticatorSelection: options.authenticatorSelection,
      attestation: options.attestation,
      timeout: options.timeout,
      excludeCredentials: options.excludeCredentials.map((c) => ({ type: c.type, id: toBuffer(c.id) }))
    }
  })) as PublicKeyCredential | null;

  if (!credential) throw new Error("No passkey was created.");

  const response = credential.response as AuthenticatorAttestationResponse;
  const publicKey = response.getPublicKey?.();
  const algorithm = response.getPublicKeyAlgorithm?.();

  if (!publicKey || algorithm === undefined || !response.getAuthenticatorData) {
    throw new Error("This browser can't register passkeys for this site.");
  }

  await api("/api/passkeys", {
    id: credential.id,
    name,
    clientDataJSON: toBase64Url(response.clientDataJSON),
    authenticatorData: toBase64Url(response.getAuthenticatorData()),
    publicKey: toBase64Url(publicKey),
    publicKeyAlgorithm: algorithm
  });
}

export async function signInWithPasskey(): Promise<UserResponse> {
  const options = await api<{
    challenge: string;
    rpId: string;
    userVerification: UserVerificationRequirement;
    timeout: number;
  }>("/api/passkey/login/options", {});

  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: toBuffer(options.challenge),
      rpId: options.rpId,
      userVerification: options.userVerification,
      timeout: options.timeout
    }
  })) as PublicKeyCredential | null;

  if (!credential) throw new Error("No passkey was selected.");

  const response = credential.response as AuthenticatorAssertionResponse;

  return api<UserResponse>("/api/passkey/login", {
    id: credential.id,
    clientDataJSON: toBase64Url(response.clientDataJSON),
    authenticatorData: toBase64Url(response.authenticatorData),
    signature: toBase64Url(response.signature)
  });
}
