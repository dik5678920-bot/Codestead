import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NotificationPreferencesPanel } from "../notification-preferences-panel";

const preferences = {
  dailyStudyEnabled: true, revisionEnabled: true, goalEnabled: true,
  challengeEnabled: true, weeklySummaryEnabled: true, learningEmailEnabled: true,
  timezone: "UTC", dailyStudyMinute: 545, revisionMinute: 1080,
  quietHoursEnabled: true, quietStartMinute: 1320, quietEndMinute: 420, rowVersion: 7,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("notification preference editing", () => {
  it("saves every editable choice with the current optimistic version and displays the server warning", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ preferences }))
      .mockResolvedValueOnce(json({ preferences: { ...preferences, rowVersion: 8 }, warning: "Email delivery is paused." }));
    vi.stubGlobal("fetch", fetch);
    render(<NotificationPreferencesPanel />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading reminder preferences");
    await screen.findByRole("button", { name: "Save reminders" });
    for (const name of ["Daily study nudge", "Due-review reminder", "Weekly goal check-in", "Upcoming challenge reminder", "Weekly progress summary", "Also send learning reminders by email"]) {
      fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(`^${name}`) }));
    }
    fireEvent.change(screen.getByLabelText("Time zone", { exact: false }), { target: { value: "Asia/Kolkata" } });
    for (const [label, value] of [["Daily study time", "10:15"], ["Revision time", "17:30"], ["Quiet from", "23:10"], ["Quiet until", "06:20"]]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByRole("checkbox", { name: /^Quiet hours/ }));
    expect(screen.queryByLabelText("Quiet from")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save reminders" }));
    expect(await screen.findByText("Email delivery is paused.")).toHaveAttribute("role", "status");
    const request = fetch.mock.calls[1][1];
    expect(request.method).toBe("PATCH");
    expect(JSON.parse(request.body)).toEqual({
      ...preferences, rowVersion: undefined, expectedVersion: 7,
      dailyStudyEnabled: false, revisionEnabled: false, goalEnabled: false,
      challengeEnabled: false, weeklySummaryEnabled: false, learningEmailEnabled: false,
      timezone: "Asia/Kolkata", dailyStudyMinute: 615, revisionMinute: 1050,
      quietHoursEnabled: false, quietStartMinute: 1390, quietEndMinute: 380,
    });
  });

  it.each([json({}, 503), json({}), new Response("invalid json")])("offers a retry after an unsuccessful load", async (response) => {
    const fetch = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(json({ preferences }));
    vi.stubGlobal("fetch", fetch);
    render(<NotificationPreferencesPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Daily study time")).toHaveValue("09:05");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reloads a conflict and uses the new version on the next save", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ preferences }))
      .mockResolvedValueOnce(json({}, 409))
      .mockResolvedValueOnce(json({ preferences: { ...preferences, timezone: "Europe/London", rowVersion: 11 } }))
      .mockResolvedValueOnce(json({ preferences: { ...preferences, rowVersion: 12 } }));
    vi.stubGlobal("fetch", fetch);
    render(<NotificationPreferencesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Save reminders" }));
    expect(await screen.findByText(/changed in another tab/)).toBeInTheDocument();
    expect(screen.getByLabelText("Time zone", { exact: false })).toHaveValue("Europe/London");
    fireEvent.click(screen.getByRole("button", { name: "Save reminders" }));
    expect(await screen.findByText("Reminder preferences saved.")).toBeInTheDocument();
    expect(JSON.parse(fetch.mock.calls[3][1].body).expectedVersion).toBe(11);
  });

  it.each([json({}, 500), json({}), new Response("invalid json")])("keeps unsaved choices available after a rejected save", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ preferences })).mockResolvedValueOnce(response));
    render(<NotificationPreferencesPanel />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /^Daily study nudge/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save reminders" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("were not saved");
    expect(screen.getByRole("checkbox", { name: /^Daily study nudge/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: /^Daily study nudge/ }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("prevents duplicate saves while a request is pending", async () => {
    let resolve!: (value: Response) => void;
    const fetch = vi.fn().mockResolvedValueOnce(json({ preferences })).mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    vi.stubGlobal("fetch", fetch);
    render(<NotificationPreferencesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Save reminders" }));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Saving…" }));
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => resolve(json({ preferences })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save reminders" })).toBeEnabled());
  });
});
