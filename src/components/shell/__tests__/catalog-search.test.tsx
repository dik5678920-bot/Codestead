import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { CatalogSearch } from "../catalog-search";

const catalog = [
  { title: "Python", courseTitle: "Python", href: "/courses/python", id: "python" },
  { title: "Assignment", courseTitle: "Python", href: "/courses/python/skills/python.assignment", id: "python.assignment" },
];

it("filters courses and skills, supports keyboard links, and announces no matches", async () => {
  const user = userEvent.setup();
  const onNavigate = vi.fn();
  render(<CatalogSearch catalog={catalog} onNavigate={onNavigate} />);
  const input = screen.getByRole("searchbox", { name: "Search courses and skills" });
  await user.type(input, "  ASSIGNMENT ");
  expect(screen.getByRole("link", { name: /Assignment/ })).toHaveAttribute("href", catalog[1].href);
  expect(screen.queryByRole("link", { name: "Python · Python" })).not.toBeInTheDocument();
  await user.tab();
  expect(screen.getByRole("link")).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onNavigate).toHaveBeenCalled();
  await user.clear(input);
  await user.type(input, "nothing-matches");
  expect(screen.getByRole("status")).toHaveTextContent("No courses or skills found");
  await user.keyboard("{Escape}");
  expect(input).toHaveValue("");
});

it.each(["ctrlKey", "metaKey"])("focuses search with %s+K", async (modifier) => {
  const onShortcut = vi.fn();
  render(<CatalogSearch catalog={catalog} onNavigate={() => {}} onShortcut={onShortcut} />);
  fireEvent.keyDown(window, { key: "k", [modifier]: true });
  expect(onShortcut).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.getByRole("searchbox")).toHaveFocus());
});

it.each(["ctrlKey", "metaKey"])("preserves %s+K in editors and other editable controls", async (modifier) => {
  const onShortcut = vi.fn();
  render(<>
    <CatalogSearch catalog={catalog} onNavigate={() => {}} onShortcut={onShortcut} />
    <div className="monaco-editor"><div data-testid="monaco-child" tabIndex={0} /></div>
    <textarea aria-label="Code" />
    <input aria-label="Other input" />
    <div contentEditable suppressContentEditableWarning><span data-testid="editable-child" tabIndex={0}>Edit</span></div>
  </>);
  for (const target of [screen.getByTestId("monaco-child"), screen.getByLabelText("Code"), screen.getByLabelText("Other input"), screen.getByTestId("editable-child")]) {
    target.focus();
    const event = new KeyboardEvent("keydown", { key: "k", [modifier]: true, bubbles: true, cancelable: true });
    fireEvent(target, event);
    await Promise.resolve();
    expect(event.defaultPrevented).toBe(false);
    expect(onShortcut).not.toHaveBeenCalled();
    expect(target).toHaveFocus();
  }
  const search = screen.getByRole("searchbox");
  search.focus();
  fireEvent.keyDown(search, { key: "k", [modifier]: true });
  expect(onShortcut).toHaveBeenCalledOnce();
  await waitFor(() => expect(search).toHaveFocus());
});

it("renders at most 20 matches and announces the full filtered count", async () => {
  const user = userEvent.setup();
  const many = Array.from({ length: 25 }, (_, index) => ({
    id: `python.${index}`, title: `Skill ${index}`, courseTitle: "Python", href: `/courses/python/skills/python.${index}`,
  }));
  render(<CatalogSearch catalog={[...many, { id: "java", title: "Java", courseTitle: "Java", href: "/courses/java" }]} onNavigate={() => {}} />);
  await user.type(screen.getByRole("searchbox"), "python");
  expect(screen.getAllByRole("link")).toHaveLength(20);
  expect(screen.getByRole("status")).toHaveTextContent("Showing 20 of 25");
  expect(screen.getAllByRole("link")[19]).toHaveAttribute("href", many[19].href);
  await user.clear(screen.getByRole("searchbox"));
  await user.type(screen.getByRole("searchbox"), "java");
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByRole("status")).toHaveTextContent("1 results");
});
