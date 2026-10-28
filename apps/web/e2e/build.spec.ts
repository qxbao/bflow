import { expect, test } from "@playwright/test";
test("production assets load the W00 skeleton", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("Bflow local web — W00 build skeleton.")).toBeVisible();
  await expect(page.locator("[data-api-version='1']")).toHaveCount(1);
  expect(errors).toEqual([]);
});
