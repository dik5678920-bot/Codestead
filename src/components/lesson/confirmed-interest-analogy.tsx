"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { TutorMarkdown } from "./tutor-markdown";
import { PlatformQuotaDialog } from "./platform-quota-dialog";

export function ConfirmedInterestAnalogy({ courseId, skillId }: { courseId: string; skillId: string }) {
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<"ready" | "empty" | "neutral">("ready");
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<"quota" | "consent" | null>(null);
  const request = useRef<string | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  async function apply() {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true); setError(null); setState("ready");
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 45_000);
    try {
      const profileResponse = await fetch("/api/onboarding/status", { cache: "no-store", signal: controller.signal });
      const profileBody = await profileResponse.json();
      if (!profileResponse.ok) throw new Error(profileBody.error ?? "Your interests could not be loaded.");
      if (controller.signal.aborted) return;
      const profile = profileBody.profile;
      const confirmed = Array.isArray(profile?.analogyInterests)
        ? profile.analogyInterests.filter((item: unknown): item is { label: string; confirmed: true } =>
          typeof item === "object" && item !== null && "confirmed" in item && item.confirmed === true
          && "label" in item && typeof item.label === "string" && item.label.trim().length > 0)
        : [];
      if (!confirmed.length) { setState("empty"); return; }
      if (profile.analogyFrequency === "neutral") { setState("neutral"); return; }
      // The tutor reads confirmed interests from the authoritative profile, not
      // from this request. Keep the identity on retry to avoid duplicate calls.
      request.current ??= JSON.stringify({
        requestId: crypto.randomUUID(), courseId, skillId,
        message: "I am stuck on this skill after the plain explanation. Explain it using one analogy from my confirmed interests, then explain where the analogy breaks and how it maps back to the actual concept.",
      });
      const response = await fetch("/api/ai/tutor", {
        method: "POST", headers: { "content-type": "application/json" },
        body: request.current, signal: controller.signal,
      });
      const body = await response.json();
      if (!response.ok) {
        if (body.code === "PLATFORM_AI_QUOTA_EXCEEDED") setNotice("quota");
        if (body.code === "PLATFORM_AI_CONSENT_REQUIRED") setNotice("consent");
        if (typeof body.code === "string" && body.code.startsWith("PLATFORM_AI_")) request.current = null;
        throw new Error(body.error ?? "The analogy could not be applied.");
      }
      if (typeof body.content !== "string" || !body.content.trim()) throw new Error("The tutor returned no analogy. Please retry.");
      if (!controller.signal.aborted) {
        setContent(body.content);
        request.current = null;
      }
    } catch (cause) {
      if (timedOut) setError("The analogy request timed out. Please retry.");
      else if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The analogy could not be applied.");
    } finally {
      window.clearTimeout(timeout);
      active.current = null;
      if (!controller.signal.aborted || timedOut) setBusy(false);
    }
  }

  return <div>
    {notice && <PlatformQuotaDialog consent={notice === "consent"} onClose={() => setNotice(null)} />}
    <button className="button button-secondary" disabled={busy} onClick={() => void apply()} type="button">
      {busy ? "Applying analogy…" : "Use my confirmed interests"}
    </button>
    {busy && <p role="status">Loading your confirmed interests and applying an analogy…</p>}
    {state === "empty" && <p role="status">No confirmed interests are available. <Link href="/settings?section=profile">Add interests in Settings</Link></p>}
    {state === "neutral" && <p role="status">Neutral explanations are selected. <Link href="/settings?section=profile">Change analogy preference in Settings</Link></p>}
    {error && <p role="alert">{error}</p>}
    {content && <section aria-label="Personal analogy" aria-live="polite">
      <p>AI-generated analogy · explanatory help, not mastery evidence.</p>
      <TutorMarkdown>{content}</TutorMarkdown>
    </section>}
  </div>;
}
