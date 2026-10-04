import { LearningRequestsView, type LearningRequestPrefill } from "@/components/product/learning-requests-view";
import { createContentRepository } from "@/lib/content";

export default async function RequestsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const kind = query.kind;
  let prefill: LearningRequestPrefill | undefined;
  if (kind === "new-subject" || kind === "topic-extension" || kind === "content-defect") {
    prefill = { kind, subject: "" };
    if (kind === "content-defect" && typeof query.skillId === "string" && query.skillId.length <= 200) {
      const location = await createContentRepository().getSkillLocation(query.skillId);
      if (location && ["beta", "verified"].includes(location.course.status)) {
        const { course, skill } = location;
        prefill = {
          kind,
          subject: `${course.title}: ${skill.title}`.slice(0, 120),
          context: `Course: ${course.title} (${course.id})\nSkill: ${skill.title} (${skill.id})\nLesson: /courses/${encodeURIComponent(course.id)}/skills/${encodeURIComponent(skill.id)}`,
        };
      }
    }
  }
  return <LearningRequestsView key={JSON.stringify(prefill)} prefill={prefill} />;
}
