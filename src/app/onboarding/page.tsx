import type { Metadata } from "next";
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};


export default function OnboardingPage() {
  return <OnboardingWizard />;
}
