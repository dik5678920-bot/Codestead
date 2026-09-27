import { expect, test } from "@playwright/test";

// The collapsed lesson rail expands on hover; it must push content aside, never
// cover it. Regression: an invalid nested :has() dropped the push rule, so a
// pointer resting on the rail left "Start checkpoint" under the sidebar.
test("hovering the collapsed lesson rail pushes content instead of covering it", async ({ page }) => {
  await page.goto("/courses/git-tooling/skills/git.branches.merge");
  const start = page.getByRole("button", { name: "Start checkpoint" });
  await expect(start).toBeVisible();

  await page.mouse.move(20, 300);
  const rail = page.locator("#app-sidebar");
  await expect.poll(async () => (await rail.boundingBox())?.width).toBe(248);
  await expect.poll(async () => {
    const railBox = await rail.boundingBox();
    const startBox = await start.boundingBox();
    return railBox && startBox ? startBox.x >= railBox.x + railBox.width : false;
  }).toBe(true);

  // Same actionability hit-test that failed in CI, without the side effect.
  await start.click({ trial: true, timeout: 5_000 });
});
