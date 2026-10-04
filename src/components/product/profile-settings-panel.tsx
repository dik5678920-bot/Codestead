"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { LearningProfile } from "@/lib/preferences/profile-settings-values";
import styles from "./product-pages.module.css";
export function ProfileSettingsPanel() {
  const router = useRouter();
  const [profile, setProfile] = useState<LearningProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const mutation = useRef(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError(null); setSuccess(false);
    try {
      const response = await fetch("/api/settings/profile", { cache: "no-store", signal });
      const body = await response.json();
      if (!response.ok || !body.profile) throw new Error(body.error ?? "Profile unavailable.");
      if (!signal?.aborted) setProfile(body.profile);
    } catch (error) { if (!signal?.aborted) setError(error instanceof Error ? error.message : "Profile unavailable."); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) void load(controller.signal); });
    return () => controller.abort();
  }, [load]);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!profile || mutation.current) return;
    const name = profile.name.trim();
    if (!name || name.length > 120) { setError("Display name must be 1–120 characters."); return; }
    mutation.current = true; setBusy(true); setError(null); setSuccess(false);
    try {
      const values = {
        name, bio: profile.bio.trim(), analogyFrequency: profile.analogyFrequency,
        cohortVisibility: profile.cohortVisibility,
        profileVersion: profile.profileVersion, cohortVersion: profile.cohortVersion,
        requestId: crypto.randomUUID(),
      };
      const response = await fetch("/api/settings/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
      const body = await response.json();
      if (!response.ok || !body.profile) throw new Error(body.error ?? "Profile could not be saved.");
      setProfile(body.profile); setSuccess(true); router.refresh();
    } catch (error) { setError(error instanceof Error ? error.message : "Profile could not be saved."); }
    finally { mutation.current = false; setBusy(false); }
  }
  return <><h2>Learning profile</h2><p>Your name and learning bio are private. Cohort sharing uses your alias and explicitly selected fields.</p>
    {loading ? <p role="status">Loading profile…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {success ? <p role="status">Profile saved.</p> : null}
    {!loading && !profile ? <button className="button button-secondary" onClick={() => void load()}>Retry profile</button> : null}
    {!loading && profile ? <form className={styles.form} onSubmit={save}>
      <fieldset disabled={busy}>
        <label>Display name<input value={profile.name} required maxLength={120} onChange={(event) => { setSuccess(false); setProfile({ ...profile, name: event.target.value }); }} /></label>
        <label>Bio<textarea value={profile.bio} maxLength={280} onChange={(event) => { setSuccess(false); setProfile({ ...profile, bio: event.target.value }); }} /></label>
        <small>Private learning bio, up to 280 characters.</small>
        <label>Analogy preference<select value={profile.analogyFrequency} onChange={(event) => { setSuccess(false); setProfile({ ...profile, analogyFrequency: event.target.value as LearningProfile["analogyFrequency"] }); }}><option value="helpful">When helpful</option><option value="frequent">Frequent</option><option value="neutral">Neutral only</option></select></label>
        <label>Public cohort fields<select value={profile.cohortVisibility} onChange={(event) => { setSuccess(false); setProfile({ ...profile, cohortVisibility: event.target.value as LearningProfile["cohortVisibility"] }); }}><option value="selected" disabled={!profile.cohortConsent}>Alias, selected badges, streak, projects</option><option value="alias" disabled={!profile.cohortConsent}>Alias only</option><option value="hidden">Hidden profile</option></select></label>
        <small>{profile.cohortAlias ? `Cohort alias: ${profile.cohortAlias}. ` : ""}Select badges and projects in Community. Accept cohort sharing in Privacy &amp; consent before publishing.</small>
        <button className="button button-primary" type="submit">{busy ? "Saving profile…" : "Save profile"}</button>
        {error ? <button className="button button-secondary" type="button" onClick={() => void load()}>Reload profile</button> : null}
      </fieldset>
    </form> : null}
  </>;
}
