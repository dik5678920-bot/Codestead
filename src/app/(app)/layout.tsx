import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { createContentRepository } from "@/lib/content";
import { AppShell } from "@/components/shell/app-shell";
import { createBrowserDurabilityNamespace } from "@/lib/drafts/cache-namespace";
import { requireAuth } from "@/lib/http/authz";
import { isApplicationAuthRequired } from "@/lib/security/runtime-policy";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function LearnerLayout({ children }: { children: React.ReactNode }) {
  const courses = await createContentRepository().listCourses({ status: ["beta", "verified"] });
  const catalog = courses.flatMap((course) => [
    { id: course.id, title: course.title, courseTitle: course.title, href: `/courses/${encodeURIComponent(course.id)}` },
    ...course.modules.flatMap((module) => module.skills.map((skill) => ({
      id: skill.id, title: skill.title, courseTitle: course.title,
      href: `/courses/${encodeURIComponent(course.id)}/skills/${encodeURIComponent(skill.id)}`,
    }))),
  ]);
  if (isApplicationAuthRequired()) {
    const authz = await requireAuth({ allowPending: true });
    if (!authz.session) {
      const denial = (await authz.response.json().catch(() => ({}))) as { code?: string };
      if (denial.code === "MFA_CHALLENGE_REQUIRED") redirect("/two-factor");
      if (authz.response.status === 401) redirect("/login");
      redirect("/login?error=account-inactive");
    }
    if (authz.account.status === "pending") redirect("/onboarding");
    const browserDurabilityNamespace = createBrowserDurabilityNamespace(
      authz.session.user.id,
      authz.session.session.id,
    );
    return <AppShell catalog={catalog} admin={authz.account.role === "admin"} browserDurabilityNamespace={browserDurabilityNamespace} viewer={{ name: authz.session.user.name, role: authz.account.role === "admin" ? "Administrator" : "Learner", image: authz.session.user.image }}>{children}</AppShell>;
  }
  // A non-null namespace activates authenticated draft/device synchronization.
  // Demo mode has no server session, so keep it local-only instead of turning
  // an expected draft 401 into a delayed redirect to the sign-in page.
  return <AppShell
    admin
    catalog={catalog}
    authenticatedSessionMonitoring={false}
    browserDurabilityNamespace={null}
    viewer={{ name: "Aarav Rao", role: "Demo learner" }}
  >{children}</AppShell>;
}
