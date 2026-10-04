import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SecuritySettingsPanel } from "../security-settings-panel";
afterEach(() => vi.unstubAllGlobals());
const reply = (body: unknown, ok = true) => ({ ok, json: async () => body });
it("shows password controls only after credential authority loads", async () => {
 vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ hasPassword: false })));
 render(<SecuritySettingsPanel />);
 expect(screen.queryByRole("button", { name: "Change password" })).not.toBeInTheDocument();
 expect(await screen.findByText("Signed in with Google; manage your password at Google.")).toBeInTheDocument();
});
it("submits current and new passwords, clears secrets, and announces success", async () => {
 const fetcher = vi.fn().mockResolvedValueOnce(reply({ hasPassword: true })).mockResolvedValueOnce(reply({ ok: true })); vi.stubGlobal("fetch", fetcher);
 render(<SecuritySettingsPanel />); fireEvent.click(await screen.findByRole("button", { name: "Change password" }));
 fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "current-password" } });
 fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-long-password" } });
 fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "new-long-password" } });
 fireEvent.click(screen.getByRole("button", { name: "Save password" }));
 await screen.findByText("Password changed. Other sessions were revoked.");
 expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ currentPassword: "current-password", newPassword: "new-long-password" });
 expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
});
it("opens real backup-code recovery guidance", async () => {
 vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ hasPassword: true })));
 render(<SecuritySettingsPanel />); fireEvent.click(screen.getByRole("button", { name: "View recovery guidance" }));
 expect(screen.getByText(/Use one of the backup codes/)).toBeInTheDocument();
});
it("shows retry on a failed status read instead of assuming a Google-only account", async () => {
 vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
 render(<SecuritySettingsPanel />); await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Account security settings could not be loaded."));
 expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
});
