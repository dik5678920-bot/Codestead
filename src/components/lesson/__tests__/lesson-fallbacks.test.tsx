import path from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ContentRepository, type AtomicSkill, type AuthoredFallbackLessonBlueprint } from "@/lib/content";
import { LessonWorkspace, Visualizer } from "../lesson-workspace";

let skill: AtomicSkill;
let blueprint: AuthoredFallbackLessonBlueprint;
beforeAll(async () => {
  const repository = new ContentRepository({ contentRoot: path.resolve(process.cwd(), "content") });
  skill = (await repository.getSkill("pf.computing.program"))!;
  blueprint = await repository.compileLessonBlueprint(skill.id);
});
afterEach(() => vi.unstubAllGlobals());

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function workspace() {
  return render(<LessonWorkspace blueprint={blueprint} skill={skill} courseTitle="Foundations" moduleTitle="Programs" />);
}
async function openAnalogy() {
  const user = userEvent.setup();
  workspace();
  const block = blueprint.blocks.find((item) => item.kind === "analogy-slot")!;
  await user.click(screen.getByRole("button", { name: new RegExp(block.title) }));
  return user;
}

describe("honest lesson fallbacks", () => {
  it("does not fabricate a trace when the skill has none", () => {
    render(<Visualizer />);
    expect(screen.getByText("No visual trace for this skill yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Play visualizer" })).not.toBeInTheDocument();
    expect(screen.queryByText(/for item in \[4, 7\]/)).not.toBeInTheDocument();
  });

  it("generates an inline analogy through the profile-aware tutor and shows loading", async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ profile: { analogyFrequency: "helpful", analogyInterests: [{ label: "cooking", confirmed: true }] } }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const user = await openAnalogy();
    await user.click(screen.getByRole("button", { name: "Use my confirmed interests" }));
    expect(await screen.findByRole("button", { name: "Applying analogy…" })).toBeDisabled();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/onboarding/status");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/ai/tutor");
    const payload = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(payload).toMatchObject({ courseId: blueprint.courseId, skillId: skill.id });
    expect(payload.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(payload.message).toMatch(/confirmed interests/i);
    finish(json({ content: "Think of a program like a recipe. The analogy stops at precise execution." }));
    expect(await screen.findByText(/program like a recipe/)).toBeInTheDocument();
  });

  it("offers Settings without an AI request when only unconfirmed interests exist", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ profile: { analogyInterests: [{ label: "cars", confirmed: false }] } }));
    vi.stubGlobal("fetch", fetchMock);
    const user = await openAnalogy();
    await user.click(screen.getByRole("button", { name: "Use my confirmed interests" }));
    expect(await screen.findByRole("link", { name: "Add interests in Settings" })).toHaveAttribute("href", "/settings?section=profile");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("respects a neutral-only preference", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ profile: { analogyFrequency: "neutral", analogyInterests: [{ label: "cooking", confirmed: true }] } }));
    vi.stubGlobal("fetch", fetchMock);
    const user = await openAnalogy();
    await user.click(screen.getByRole("button", { name: "Use my confirmed interests" }));
    expect(await screen.findByText(/Neutral explanations are selected/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a profile failure without treating it as an empty interest list", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: "Profile temporarily unavailable" }, 503));
    vi.stubGlobal("fetch", fetchMock);
    const user = await openAnalogy();
    await user.click(screen.getByRole("button", { name: "Use my confirmed interests" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Profile temporarily unavailable");
    expect(screen.queryByRole("link", { name: "Add interests in Settings" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not show a blank tutor response as an applied analogy", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json({ profile: { analogyInterests: [{ label: "cooking", confirmed: true }] } }))
      .mockResolvedValueOnce(json({ content: "  " })));
    const user = await openAnalogy();
    await user.click(screen.getByRole("button", { name: "Use my confirmed interests" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The tutor returned no analogy");
    expect(screen.queryByRole("region", { name: "Personal analogy" })).not.toBeInTheDocument();
  });

  it("shows errors and reuses the analogy request identity after a lost response", async () => {
    const profile = { profile: { analogyInterests: [{ label: "cooking", confirmed: true }] } };
    const fetchMock = vi.fn().mockResolvedValueOnce(json(profile)).mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(json(profile)).mockResolvedValueOnce(json({ content: "A program follows a recipe." }));
    vi.stubGlobal("fetch", fetchMock);
    const user = await openAnalogy();
    await user.click(screen.getByRole("button", { name: "Use my confirmed interests" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    await user.click(screen.getByRole("button", { name: "Use my confirmed interests" }));
    expect(await screen.findByText("A program follows a recipe.")).toBeInTheDocument();
    expect(fetchMock.mock.calls[3]![1].body).toBe(fetchMock.mock.calls[1]![1].body);
  });

  it("makes no evidence claim after the fallback quest length check", async () => {
    const user = userEvent.setup();
    workspace();
    await user.click(screen.getByRole("tab", { name: /Quest/i }));
    await user.type(screen.getByPlaceholderText(/reasoning or code fragment/), "A reasonable explanation.");
    await user.click(screen.getByRole("button", { name: /Run action/i }));
    expect(screen.getByText(/No evidence is saved/)).toBeInTheDocument();
    expect(screen.queryByText(/Evidence captured/i)).not.toBeInTheDocument();
  });
});
