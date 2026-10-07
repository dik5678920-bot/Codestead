import path from "node:path";

import { fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ContentRepository, type AuthoredLesson } from "@/lib/content";
import { InteractiveLessonFlow } from "../interactive-lesson-flow";

let lesson: AuthoredLesson;

beforeAll(async () => {
  const repository = new ContentRepository({ contentRoot: path.resolve(process.cwd(), "content") });
  lesson = (await repository.getAuthoredLesson("pf.computing.program"))!;
});


// Walkthrough steps are authored as inline markdown; match the rendered text of the innermost element.
function renderedMarkdown(source: string) {
  const plain = source.replace(/\*\*|`/g, "");
  return (_: string, element: Element | null) =>
    element !== null &&
    element.textContent === plain &&
    !Array.from(element.children).some((child) => child.textContent === plain);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("interactive authored lesson flow", () => {
  it("preserves authored Python indentation through repository parsing", () => {
    expect(lesson.trace.artifact).toContain("    if s > best: best = s");
  });

  it("preserves four spaces, eight spaces, and tabs in prediction and trace code", () => {
    const artifact = ["    four", "        eight", "\t tab"];
    const { container } = render(<InteractiveLessonFlow lesson={{ ...lesson, trace: { ...lesson.trace, artifact } }} />);
    for (const id of ["predict", "trace"]) {
      const code = container.querySelector(`#${id} pre`)!;
      expect(code.textContent).toBe(artifact.join("\n"));
      expect(getComputedStyle(code).whiteSpace).toBe("pre");
    }
  });

  it.each([
    ["PRINT 91", true], ["abc", true], ["ab", false], ["a b", false],
    ["", false], [" \t\n ", false], [" a \t b ", false],
  ])("accepts only predictions with three non-whitespace characters: %j", (value, enabled) => {
    render(<InteractiveLessonFlow lesson={lesson} />);
    fireEvent.input(screen.getByRole("textbox", { name: "Your prediction" }), { target: { value } });
    const reveal = screen.getByRole("button", { name: "Reveal the first step" });
    if (enabled) expect(reveal).toBeEnabled();
    else expect(reveal).toBeDisabled();
    expect(screen.getByText("Write a short prediction to compare it with the trace.")).toBeInTheDocument();
  });

  it("uses unique landmark and heading ids with a stable sources label", () => {
    const { container } = render(<InteractiveLessonFlow lesson={lesson} />);
    const ids = Array.from(container.querySelectorAll<HTMLElement>("[id]"), (element) => element.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(screen.getByRole("region", { name: "Sources and review status" }))
      .toHaveTextContent(lesson.sources[0]!.sourceRef);
  });

  it("retains the twelve-character minimum for practice and recap", () => {
    render(<InteractiveLessonFlow lesson={lesson} />);
    for (const [label, button] of [["Your guided-practice answer", "Continue to near transfer"], ["Teach it back in your own words", "Compare with the recap"]]) {
      fireEvent.input(screen.getByRole("textbox", { name: label }), { target: { value: "PRINT 91" } });
      expect(screen.getByRole("button", { name: button })).toBeDisabled();
    }
  });

  it("requires a prediction before revealing the first machine-state step", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("jest", vi);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<InteractiveLessonFlow lesson={lesson} />);

    const reveal = screen.getByRole("button", { name: "Reveal the first step" });
    expect(reveal).toBeDisabled();
    expect(screen.getByText(/scratchpad responses stay in this tab/i)).toBeInTheDocument();

    await user.click(screen.getByRole("textbox", { name: "Your prediction" }));
    await user.paste("The computer will read the instructions in order.");
    await user.click(reveal);

    expect(screen.getByRole("status")).toHaveTextContent(/prediction saved locally/i);
    expect(screen.getByText(new RegExp(`Step 1: ${lesson.trace.steps[0]!.focus}`, "i"))).toBeInTheDocument();
  });

  it("recovers a prediction entered before hydration and enables the reveal action", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<InteractiveLessonFlow lesson={lesson} />);
    const prediction = container.querySelector<HTMLTextAreaElement>("#predict textarea");
    expect(prediction).not.toBeNull();
    prediction!.value = "The named branch changes are applied to the checked-out branch.";
    document.body.append(container);

    const view = render(<InteractiveLessonFlow lesson={lesson} />, { container, hydrate: true });

    expect(screen.getByRole("button", { name: "Reveal the first step" })).toBeEnabled();
    view.unmount();
    container.remove();
  });

  it("steps through a worked example and keeps every explanation available to keyboard users", async () => {
    const user = userEvent.setup();
    render(<InteractiveLessonFlow lesson={lesson} />);

    expect(screen.getByText(`Step 1 of ${lesson.examples[0]!.walkthrough.length}`)).toBeInTheDocument();
    expect(screen.getByText(renderedMarkdown(lesson.examples[0]!.walkthrough[0]!))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next worked step" }));
    expect(screen.getByText(`Step 2 of ${lesson.examples[0]!.walkthrough.length}`)).toBeInTheDocument();
    expect(screen.getByText(renderedMarkdown(lesson.examples[0]!.walkthrough[1]!))).toBeInTheDocument();
  });

  it("gives immediate misconception feedback without awarding official evidence", async () => {
    const user = userEvent.setup();
    render(<InteractiveLessonFlow lesson={lesson} />);

    await user.click(screen.getByRole("button", { name: "Choose the precise explanation" }));
    expect(screen.getByText(/That is the safer mental model/i).closest("p"))
      .toHaveTextContent(lesson.misconceptions[0]!.correction);
    expect(screen.getByText(/practice-only check/i)).toBeInTheDocument();
  });

  it("fades support from a guided prompt to near and far transfer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Testing Library detects fake timers through its Jest-compatible adapter.
    vi.stubGlobal("jest", vi);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<InteractiveLessonFlow lesson={lesson} />);

    expect(screen.getByRole("heading", { name: /Rung 1.*Guided/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to near transfer" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Show one hint" }));
    expect(screen.getByText(lesson.practice.faded.scaffold[0]!)).toBeInTheDocument();
    await user.click(screen.getByRole("textbox", { name: "Your guided-practice answer" }));
    await user.paste("I would apply the rule, trace the state, and check the result.");
    await user.click(screen.getByRole("button", { name: "Continue to near transfer" }));
    expect(screen.getByRole("heading", { name: /Rung 2.*Similar problem/i })).toBeInTheDocument();
  });

  it("makes retrieval active before showing the authored recap", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Testing Library detects fake timers through its Jest-compatible adapter.
    vi.stubGlobal("jest", vi);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<InteractiveLessonFlow lesson={lesson} />);

    const reveal = screen.getByRole("button", { name: "Compare with the recap" });
    expect(reveal).toBeDisabled();
    await user.click(screen.getByRole("textbox", { name: "Teach it back in your own words" }));
    await user.paste("A program is a precise set of instructions that turns input into observable output.");
    await user.click(reveal);
    expect(screen.getByText(lesson.recap.summary)).toBeInTheDocument();
    expect(screen.getByText(/This is reflection, not a correctness grade/i)).toBeInTheDocument();
  });
});
