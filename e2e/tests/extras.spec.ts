import { test, expect } from "@playwright/test";

test("command palette, OWASP coverage and the Markdown run report", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Engineer", exact: true }).click();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Agent reliability overview")).toBeVisible({ timeout: 90_000 });

  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByLabel("Search").fill("red team");
  await palette.getByLabel("Search").press("Enter");
  await expect(page.getByRole("heading", { name: "Prompt injection red team" })).toBeVisible();
  await expect(page.getByText("OWASP Top 10 for LLM apps")).toBeVisible();
  await expect(page.getByText("Prompt Injection", { exact: true })).toBeVisible();

  await page.keyboard.press("Control+k");
  await palette.getByLabel("Search").fill("legacy");
  await palette.getByLabel("Search").press("Enter");
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Report" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^crucible-run-\d+\.md$/);
  const text = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString());
  expect(text).toMatch(/^# Crucible report:/);
});
