import { redirect } from "next/navigation";
import { LandingPage } from "@/components/landing/landing-page";
import { signedInDestination } from "@/lib/security/signed-in-destination";

export default async function HomePage() {
  // A remembered device resumes where the learner left off instead of
  // looking signed out on the marketing page.
  const destination = await signedInDestination();
  if (destination) redirect(destination);
  return <LandingPage />;
}
