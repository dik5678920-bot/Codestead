import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TutorLesson } from "../tutor-context";
import { TutorLauncher } from "../tutor-panel";

const context = vi.hoisted(() => ({ lesson: null as TutorLesson | null }));
vi.mock("../tutor-context", () => ({ useTutorLesson: () => context.lesson }));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function open() { render(<TutorLauncher />); fireEvent.click(screen.getByRole("button", { name: "Open Patch" })); return screen.getByRole("dialog", { name: "Patch" }); }
function send(text = "Explain loops") { fireEvent.change(screen.getByRole("textbox", { name: "Message Patch" }), { target: { value: text } }); fireEvent.click(screen.getByRole("button", { name: "Send message" })); }
beforeEach(() => {
  window.localStorage.clear(); context.lesson = null;
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query.includes("reduced-motion"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); window.localStorage.clear(); });

describe("floating tutor recovery and positioning", () => {
  it("retries transport loss with exactly the same request and uses the server-sanitized message", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(json({ content: "Try a small trace", threadId: "thread-1", acceptedMessage: "redacted question" }))
      .mockResolvedValueOnce(json({ content: "Next step", threadId: "thread-1", callId: "call-2" }));
    vi.stubGlobal("fetch", fetch); open(); send("private question");
    expect(await screen.findByText("Try a small trace")).toBeInTheDocument();
    expect(screen.getByText("redacted question")).toBeInTheDocument(); expect(screen.queryByText("private question")).not.toBeInTheDocument();
    expect(fetch.mock.calls[0][1]).toEqual(fetch.mock.calls[1][1]);
    send("Follow up"); expect(await screen.findByText("Next step")).toBeInTheDocument();
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toMatchObject({ message: "Follow up", threadId: "thread-1" });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).not.toHaveProperty("courseId");
  });
  it.each([json({}, 503), new Response("broken json"), json({ error: "Provider unavailable" }, 502)])("displays a truthful error after a failed provider response", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response)); open(); send();
    await waitFor(() => expect(screen.getByTestId("codestead-mentor-pet")).toHaveAttribute("data-state", "error"));
    expect(document.querySelector('[data-error="true"]')).toHaveTextContent(/unavailable/);
    expect(screen.getByRole("textbox", { name: "Message Patch" })).toHaveFocus();
  });
  it("keeps a second submit out while the provider is pending and starts a fresh conversation only after confirmation", async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }))
      .mockResolvedValueOnce(json({ content: "Fresh response", threadId: "thread-2" }));
    vi.stubGlobal("fetch", fetch); open(); send();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message Patch" }), { key: "Enter" }); expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => resolve(json({ content: "First response", threadId: "thread-1" })));
    expect(await screen.findByText("First response")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New chat" })); expect(screen.getByText("First response")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm new chat" })); expect(screen.queryByText("First response")).not.toBeInTheDocument();
    send("New topic"); expect(await screen.findByText("Fresh response")).toBeInTheDocument(); expect(JSON.parse(fetch.mock.calls[1][1].body)).not.toHaveProperty("threadId");
  });
  it("loads a saved dock, preserves it across minimization, and reflows the page", () => {
    window.localStorage.setItem("codestead.tutor-window", JSON.stringify({ mode: "dock", rect: { x: 30, y: 40, w: 360, h: 400 } }));
    const panel = open(); expect(panel).toHaveAttribute("data-mode", "dock"); expect(document.documentElement.dataset.tutorDocked).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Minimize tutor" })); expect(document.documentElement.dataset.tutorDocked).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Open Patch" })); expect(screen.getByRole("dialog")).toHaveAttribute("data-mode", "dock");
    fireEvent.click(screen.getByRole("button", { name: "Undock tutor" })); expect(screen.getByRole("dialog")).toHaveAttribute("data-mode", "float");
    expect(JSON.parse(window.localStorage.getItem("codestead.tutor-window")!).mode).toBe("float");
  });
  it.each(["bad JSON", JSON.stringify({ mode: "dock", rect: { x: "bad", y: 1, w: 2, h: 3 } })])("recovers from malformed window and bubble state %s", (saved) => {
    window.localStorage.setItem("codestead.tutor-window", saved); window.localStorage.setItem("codestead.patch-bubble", saved);
    const panel = open(); expect(panel).toHaveAttribute("data-mode", "float"); expect(parseFloat(panel.style.width)).toBeGreaterThanOrEqual(320);
    fireEvent.keyDown(panel, { key: "Escape" }); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("keeps chat usable when position storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    open(); fireEvent.click(screen.getByRole("button", { name: "Dock tutor to the right" })); expect(screen.getByRole("dialog")).toHaveAttribute("data-mode", "dock");
  });
  it("uses a phone sheet after a viewport change", () => {
    const media = vi.fn((query: string) => ({ matches: query.includes("max-width"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.stubGlobal("matchMedia", media); open(); expect(screen.getByRole("dialog")).toHaveAttribute("data-mode", "sheet");
    expect(screen.queryByRole("button", { name: "Dock tutor to the right" })).not.toBeInTheDocument();
    media.mockImplementation((query) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    fireEvent(window, new Event("resize")); expect(screen.getByRole("dialog")).toHaveAttribute("data-mode", "float");
  });
  it.each(["n", "s", "e", "w", "ne", "nw", "se", "sw"])("resizes from the %s handle and persists a bounded rectangle", (direction) => {
    const panel = open(); const before = JSON.parse(window.localStorage.getItem("codestead.tutor-window")!).rect;
    const resize = panel.querySelector(`[data-dir="${direction}"]`)!;
    fireEvent.pointerDown(resize, { button: 0, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(window, { clientX: 520, clientY: 420 }); fireEvent.pointerUp(window, { clientX: 520, clientY: 420 });
    const after = JSON.parse(window.localStorage.getItem("codestead.tutor-window")!).rect;
    expect(after).not.toEqual(before); expect(after.w).toBeGreaterThanOrEqual(320); expect(after.h).toBeGreaterThanOrEqual(380);
    expect(after.x).toBeGreaterThanOrEqual(8); expect(after.y).toBeGreaterThanOrEqual(8);
  });
  it("drags into the dock and detaches when the heading is dragged back", () => {
    const panel = open(); const heading = screen.getByText("Patch").closest("div")!;
    fireEvent.pointerDown(heading, { button: 0, clientX: 500, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: window.innerWidth - 1, clientY: 100 }); fireEvent.pointerUp(window, { clientX: window.innerWidth - 1, clientY: 100 });
    expect(panel).toHaveAttribute("data-mode", "dock");
    fireEvent.pointerDown(heading, { button: 0, clientX: 700, clientY: 100 }); fireEvent.pointerMove(window, { clientX: 600, clientY: 200 }); fireEvent.pointerUp(window, { clientX: 600, clientY: 200 });
    expect(panel).toHaveAttribute("data-mode", "float");
  });
  it("snaps a dragged bubble to an edge and suppresses the click caused by the drag", () => {
    render(<TutorLauncher />); const bubble = screen.getByRole("button", { name: "Open Patch" });
    fireEvent.pointerDown(bubble, { button: 0, clientX: 900, clientY: 600 });
    fireEvent.pointerMove(window, { clientX: 901, clientY: 601 }); expect(bubble).not.toHaveAttribute("data-dragging");
    fireEvent.pointerMove(window, { clientX: 100, clientY: 300 }); expect(bubble).toHaveAttribute("data-dragging", "true");
    fireEvent.pointerUp(window); expect(JSON.parse(window.localStorage.getItem("codestead.patch-bubble")!).x).toBe(18);
    fireEvent.click(bubble); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(bubble); expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  it("offers context prompts and sends the registered lesson identity", async () => {
    context.lesson = { courseId: "python", skillId: "loops", skillTitle: "Loops" };
    const fetch = vi.fn().mockResolvedValue(json({ content: "A tiny loop", threadId: "thread-1" })); vi.stubGlobal("fetch", fetch); open();
    fireEvent.click(screen.getByRole("button", { name: "Show a tiny example" })); expect(screen.getByRole("textbox")).toHaveValue("Show me one tiny example of this skill.");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", shiftKey: true }); expect(fetch).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" }); expect(await screen.findByText("A tiny loop")).toBeInTheDocument();
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ courseId: "python", skillId: "loops" });
  });
});
