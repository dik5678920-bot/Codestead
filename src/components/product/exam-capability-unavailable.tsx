import { LockKeyhole } from "lucide-react";
import Link from "next/link";

import styles from "./product-pages.module.css";

export type ExamCapabilityError = { code: "EXAM_CLOSED_BOOK" | "EXAM_STATE_UNAVAILABLE"; message: string };

export function isExamCapabilityError(error: unknown): error is ExamCapabilityError {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Record<string, unknown>;
  return (candidate.code === "EXAM_CLOSED_BOOK" || candidate.code === "EXAM_STATE_UNAVAILABLE")
    && typeof candidate.message === "string";
}

export function ExamCapabilityUnavailable({ feature, error }: {
  feature: "Community" | "Community and battles";
  error: ExamCapabilityError;
}) {
  const verb = feature === "Community" ? "is" : "are";
  return <section className={`${styles.empty} card`} role="status">
    <div>
      <LockKeyhole aria-hidden="true" size={24} />
      <h2>{feature} {verb} {error.code === "EXAM_CLOSED_BOOK" ? "unavailable during your exam" : "temporarily unavailable"}</h2>
      <p>{error.message}</p>
      <Link className="button button-primary" href="/exams">Return to exam workspace</Link>
    </div>
  </section>;
}
