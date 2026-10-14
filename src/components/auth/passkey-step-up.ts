"use client";

function decode(value: string) {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
function encode(value: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function verifyWithPasskey(signal?: AbortSignal) {
  const begin = await fetch("/api/security/passkey-step-up", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal });
  const challenge = await begin.json();
  if (!begin.ok) throw new Error(challenge.error ?? "Passkey verification is unavailable.");
  const credential = await navigator.credentials.get({ publicKey: { ...challenge.options,
    challenge: decode(challenge.options.challenge), userVerification: "required",
    allowCredentials: challenge.options.allowCredentials?.map((entry: { id: string; type: "public-key" }) => ({ ...entry, id: decode(entry.id) })) }, signal }) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey verification was cancelled.");
  const response = credential.response as AuthenticatorAssertionResponse;
  const complete = await fetch("/api/security/passkey-step-up", { method: "POST", headers: { "Content-Type": "application/json" }, signal,
    body: JSON.stringify({ id: challenge.id, response: { id: credential.id, rawId: encode(credential.rawId), type: "public-key", clientExtensionResults: credential.getClientExtensionResults(),
      ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
      response: { clientDataJSON: encode(response.clientDataJSON), authenticatorData: encode(response.authenticatorData), signature: encode(response.signature), userHandle: response.userHandle ? encode(response.userHandle) : null } } }) });
  const body = await complete.json();
  if (!complete.ok || body.ok !== true) throw new Error(body.error ?? "Passkey verification was not accepted.");
}
