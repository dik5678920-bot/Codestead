import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NotificationMenu } from "../notification-menu";

const payload = {
  notifications: [{
    id: "11111111-1111-4111-8111-111111111111",
    type: "smart_reminder.revision",
    title: "A five-question refresh is ready",
    body: "Previous learning is due for retrieval practice.",
    actionUrl: "/review",
    readAt: null,
    createdAt: "2026-07-14T10:00:00.000Z",
  }],
  unreadCount: 1,
  nextCursor: null,
};

describe("NotificationMenu", () => {
  it("marks an activated sidebar notification read and clears its unread dot", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify(init?.method === "PATCH" ? { updated: 1 } : payload), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<NotificationMenu inSidebar />);
    await user.click(await screen.findByRole("button", { name: "Notifications, 1 unread" }));
    await user.click(await screen.findByRole("link", { name: /five-question refresh/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toBeEnabled());
    expect(fetchMock).toHaveBeenCalledWith("/api/notifications", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ ids: [payload.notifications[0].id], read: true }),
    }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByRole("button", { name: "Mark all read" })).toBeDisabled();
  });
  it("opens the sidebar panel outside the rail that clips overflow", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));
    const user = userEvent.setup();
    const { container } = render(<aside data-testid="sidebar"><NotificationMenu inSidebar /></aside>);
    await user.click(await screen.findByRole("button", { name: "Notifications, 1 unread" }));
    const panel = await screen.findByRole("dialog", { name: "Notifications" });
    expect(container.contains(panel)).toBe(false);
    expect(panel).toBeVisible();
    expect(panel).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toBeEnabled());
    expect(panel).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toHaveFocus());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("loads a private feed, exposes unread state, and marks all read", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return new Response(JSON.stringify({ updated: 1 }), { status: 200 });
      return new Response(JSON.stringify(payload), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<NotificationMenu />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications, 1 unread" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Notifications, 1 unread" }));
    expect(await screen.findByRole("dialog", { name: "Notifications" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /five-question refresh/i })).toHaveAttribute("href", "/review");

    await user.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toBeEnabled());
    expect(fetchMock).toHaveBeenCalledWith("/api/notifications", expect.objectContaining({ method: "PATCH" }));
  });

  it("does not turn an unsafe stored action URL into a link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...payload,
      notifications: [{ ...payload.notifications[0], actionUrl: "https://evil.example.test" }],
    }), { status: 200 })));
    const user = userEvent.setup();
    render(<NotificationMenu />);
    await user.click(await screen.findByRole("button", { name: "Notifications, 1 unread" }));
    expect(await screen.findByRole("button", { name: /five-question refresh/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /five-question refresh/i })).not.toBeInTheDocument();
  });

  it("shows a retryable error without presenting an empty state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not available", { status: 503 })));
    const user = userEvent.setup();
    render(<NotificationMenu />);
    await user.click(screen.getByRole("button", { name: "Notifications" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be loaded/i);
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });
});
