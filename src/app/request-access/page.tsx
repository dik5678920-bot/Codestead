import type { Metadata } from "next";
import { AccessRequestForm } from "@/components/auth/access-request-form";
import { AuthShell } from "@/components/auth/auth-shell";

export const metadata: Metadata = {
  title: "Request access",
  description: "Request a learning seat in the Codestead private pilot. Every request is reviewed by an administrator.",
};


export default function RequestAccessPage() {
  return <AuthShell eyebrow="Private pilot" title="Request a learning seat" description="The administrator reviews every request. Approved learners receive a single-use invitation by email."><AccessRequestForm /></AuthShell>;
}
