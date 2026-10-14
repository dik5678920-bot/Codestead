"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { verifyWithPasskey } from "@/components/auth/passkey-step-up";

type Passkey = { id: string; name: string | null; createdAt: string };

async function readPasskeys(signal?: AbortSignal): Promise<Passkey[]> {
  const response = await fetch("/api/security/passkeys", { cache: "no-store", signal });
  const body = await response.json();
  if (!response.ok || !Array.isArray(body.passkeys)) throw new Error("Passkeys could not be loaded.");
  return body.passkeys;
}

export function PasskeySettings() {
  const [records, setRecords] = useState<Passkey[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  async function load(signal?: AbortSignal) {
    const records = await readPasskeys(signal);
    if (!signal?.aborted) { setRecords(records); setLoading(false); }
  }
  useEffect(() => {
    const controller = new AbortController();
    void readPasskeys(controller.signal).then((records) => {
      if (!controller.signal.aborted) { setRecords(records); setLoading(false); }
    }).catch(() => { if (!controller.signal.aborted) { setError("Passkeys could not be loaded."); setLoading(false); } });
    return () => controller.abort();
  }, []);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(null); setMessage(null);
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Passkey action failed."); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    const response = await fetch(`/api/security/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Passkey could not be removed.");
    await load(); setMessage("Passkey removed.");
  }
  return <section><h3>Passkeys</h3><p>Sign in with your device PIN, biometrics, or security key. Your password and recovery options remain available.</p>
    <p>Verify your authenticator or passkey before adding or removing a passkey. Verification lasts five minutes.</p>
    <label>Authenticator code<input autoComplete="one-time-code" inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} disabled={busy} /></label>
    <button type="button" disabled={busy || !/^\d{6}$/.test(code)} onClick={() => void run(async () => {
      try {
        const response = await fetch("/api/security/fresh-mfa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
        if (!response.ok) throw new Error("Authenticator code was not accepted.");
        setMessage("Identity verified for five minutes.");
      } finally { setCode(""); }
    })}>Verify authenticator</button>
    <button type="button" disabled={busy} onClick={() => void run(async () => { await verifyWithPasskey(); setMessage("Identity verified for five minutes."); })}>Verify with a passkey</button>
    <label>New passkey name<input maxLength={80} value={name} onChange={(event) => setName(event.target.value)} disabled={busy} /></label>
    <button type="button" disabled={busy || !name.trim()} onClick={() => void run(async () => {
      const result = await authClient.passkey.addPasskey({ name: name.trim() });
      if (result.error) throw new Error(result.error.message);
      setName(""); await load(); setMessage("Passkey added.");
    })}>Add passkey</button>
    {loading ? <p role="status">Loading passkeys…</p> : records.length === 0 ? <p>No passkeys registered.</p> : <ul>{records.map((record) => <li key={record.id}>
      <PasskeyName record={record} disabled={busy} save={(value) => void run(async () => {
        const response = await fetch(`/api/security/passkeys/${encodeURIComponent(record.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: value }) });
        if (!response.ok) throw new Error("Passkey could not be renamed.");
        await load(); setMessage("Passkey renamed.");
      })} />
      <button type="button" disabled={busy} onClick={() => void run(() => remove(record.id))}>Remove {record.name ?? "passkey"}</button>
    </li>)}</ul>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {!loading && <button type="button" disabled={busy} onClick={() => void run(() => load())}>Refresh passkeys</button>}
  </section>;
}

function PasskeyName({ record, disabled, save }: { record: Passkey; disabled: boolean; save: (name: string) => void }) {
  const [name, setName] = useState(record.name ?? "Passkey");
  return <><label>Passkey name<input maxLength={80} value={name} disabled={disabled} onChange={(event) => setName(event.target.value)} /></label>
    <button type="button" disabled={disabled || !name.trim() || name === record.name} onClick={() => save(name.trim())}>Rename</button></>;
}
