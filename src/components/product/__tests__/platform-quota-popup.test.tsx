import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TutorView } from "../tutor-view";
afterEach(() => vi.unstubAllGlobals());
it("lets a keyless learner send and opens key settings when the platform quota is exhausted", async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    void init;
    const body = url === "/api/credentials" ? { credentials: [] }
      : url === "/api/ai/tutor" ? { code: "PLATFORM_AI_QUOTA_EXCEEDED", error: "Daily quota used up" }
      : { threads: [], nextCursor: null };
    return new Response(JSON.stringify(body), { status: url === "/api/ai/tutor" ? 429 : 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<TutorView />);
  const input = await screen.findByRole("textbox", { name: "Message Codestead" });
  fireEvent.change(input, { target: { value: "Explain loops" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  const dialog = await screen.findByRole("dialog", { name: "Add your own free key" });
  expect(within(dialog).getByRole("link", { name: "Add your own free key" })).toHaveAttribute("href", "/settings?section=ai");
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue later" }));
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByRole("dialog", { name: "Add your own free key" });
  const sends = fetchMock.mock.calls.filter(([url]) => url === "/api/ai/tutor");
  expect(JSON.parse(String(sends[0][1]?.body)).requestId).not.toBe(JSON.parse(String(sends[1][1]?.body)).requestId);
});
