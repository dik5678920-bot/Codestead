import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TutorLessonProvider } from "../tutor-context";
import { TutorLauncherHost } from "../tutor-panel";
afterEach(() => vi.unstubAllGlobals());
it("links a keyless learner to existing provider consent settings before platform routing", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "PLATFORM_AI_CONSENT_REQUIRED", error: "Provider consent is required" }), { status: 409 })));
  render(<TutorLessonProvider><TutorLauncherHost /></TutorLessonProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Open Patch" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Message Patch" }), { target: { value: "Explain loops" } });
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Message Patch" }), { key: "Enter" });
  const dialog = await screen.findByRole("dialog", { name: "Allow platform AI routing" });
  expect(within(dialog).getByRole("link", { name: "Review provider consent" })).toHaveAttribute("href", "/settings?section=privacy");
});
it("opens the add-key popup on typed platform exhaustion and links to existing key settings", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "PLATFORM_AI_QUOTA_EXCEEDED", error: "Today's platform AI quota is used up." }), { status: 429 })));
  render(<TutorLessonProvider><TutorLauncherHost /></TutorLessonProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Open Patch" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Message Patch" }), { target: { value: "Explain loops" } });
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Message Patch" }), { key: "Enter" });
  const dialog = await screen.findByRole("dialog", { name: "Add your own free key" });
  expect(within(dialog).getByRole("link", { name: "Add your own free key" })).toHaveAttribute("href", "/settings?section=ai");
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue later" }));
  expect(screen.queryByRole("dialog", { name: "Add your own free key" })).not.toBeInTheDocument();
});
