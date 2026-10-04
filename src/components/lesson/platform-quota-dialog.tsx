"use client";
import Link from "next/link";
import { ModalDialog } from "@/components/ui/modal-dialog";
import styles from "./platform-quota-dialog.module.css";

export function PlatformQuotaDialog({ onClose, consent = false }: { onClose: () => void; consent?: boolean }) {
  return <ModalDialog backdropClassName={styles.backdrop} dialogClassName={styles.dialog} labelledBy="platform-quota-title" onClose={onClose}>
    <h2 id="platform-quota-title">{consent ? "Allow platform AI routing" : "Add your own free key"}</h2>
    {consent ? <p>You can use an administrator&apos;s platform key without adding your own. First review and accept the provider&apos;s routing disclosure in Privacy &amp; consent settings. Your bounded lesson context and messages are sent only to providers you authorize.</p>
      : <p>Today&apos;s platform AI allowance is used up. Add your own provider key to continue, or return after the allowance resets at midnight UTC. Provider limits and pricing still apply to your own key.</p>}
    <Link className="button button-primary" href={consent ? "/settings?section=privacy" : "/settings?section=ai"}>{consent ? "Review provider consent" : "Add your own free key"}</Link>
    <button className="button button-secondary" type="button" onClick={onClose}>Continue later</button>
  </ModalDialog>;
}
