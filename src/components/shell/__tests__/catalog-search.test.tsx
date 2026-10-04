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
