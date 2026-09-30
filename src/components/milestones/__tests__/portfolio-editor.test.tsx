import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PortfolioEditor } from "../portfolio-editor";

const settings = {
  profile: { slug: "learner-safe", displayName: "Learner", headline: "Building verified programming projects", about: "Saved about", isPublished: true, rowVersion: 2 },
  projects: [], achievements: [],
  certificates: [{ id: "30000000-0000-4000-8000-000000000001", title: "Old certificate", selected: true, version: "1" }],
  disclosure: "Selected proof only.",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());

describe("portfolio mutations", () => {
  it("withdraws without sending invalid unsaved edits and keeps those edits untouched", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method !== "PATCH") return json({ settings });
      const body = JSON.parse(String(init.body));
      if (body.action !== "withdraw" || "headline" in body || "selectedCertificateIds" in body) return json({ error: "INVALID_REQUEST" }, 400);
      return json({ result: { event: "withdrawn", rowVersion: 3, replayed: false }, settings: { ...settings, profile: { ...settings.profile, isPublished: false, rowVersion: 3 }, certificates: [] } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PortfolioEditor />);
    await screen.findByRole("button", { name: "Withdraw public page" });
    await user.clear(screen.getByLabelText("Headline"));
    await user.clear(screen.getByLabelText(/About/));
    await user.type(screen.getByLabelText(/About/), "Unsaved about");
    await user.click(screen.getByRole("button", { name: "Withdraw public page" }));
    await screen.findByText("Portfolio withdrawn immediately.");
    expect(screen.getByLabelText("Headline")).toHaveValue("");
    expect(screen.getByLabelText(/About/)).toHaveValue("Unsaved about");
    expect(screen.getByLabelText(/Old certificate/)).toBeChecked();
    expect(screen.queryByRole("link", { name: /View public page/ })).not.toBeInTheDocument();
    const body = JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")![1]!.body));
    expect(body).toEqual({ action: "withdraw", requestId: expect.any(String), expectedVersion: 2 });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save private draft" })).toBeEnabled());
  });
});
