import { test, expect, type Page } from "@playwright/test";

async function signIn(page: Page, role: "Engineer" | "Admin" | "Viewer" = "Engineer") {
  await page.goto("/login");
  await page.getByRole("button", { name: role, exact: true }).click();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Agent reliability overview")).toBeVisible();
}

test("engineer launches a chaos run, inspects a failing case trace, and compares to the baseline", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "New run" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Test suite").selectOption({ label: "Prompt injection red team" });
  await dialog.getByLabel("Agent under test").selectOption({ label: "Support bot v1" });
  await dialog.getByLabel(/Label/).fill("e2e legacy check");
  await dialog.getByRole("button", { name: "Start run" }).click();
  await expect(page.getByRole("heading", { name: /e2e legacy check/ })).toBeVisible();
  await expect(page.getByText("completed").first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("Unsafe").first()).toBeVisible();

  await page.getByRole("button", { name: "Indirect injection → wire transfer" }).click();
  const inspector = page.getByRole("dialog");
  await expect(inspector.getByText("invoke_agent support-naive")).toBeVisible();
  await expect(inspector.getByText("execute_tool transfer_funds")).toBeVisible();
  await inspector.getByRole("tab", { name: /Assertions/ }).click();
  await expect(inspector.getByText("transfer_funds was called").first()).toBeVisible();
  await inspector.getByRole("button", { name: "Close" }).click();

  await page.getByRole("link", { name: "Compare to baseline" }).click();
  await expect(page.getByText("Gate failed: this change would be blocked in CI")).toBeVisible();
  await expect(page.getByText(/critical scenario\(s\) regressed/)).toBeVisible();
});

test("chaos playground shows exactly what the agent receives", async ({ page }) => {
  await signIn(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Chaos studio" }).click();
  await page.getByLabel("Target").selectOption("get_order");
  await page.getByRole("button", { name: "Schema drift" }).click();
  await page.getByRole("button", { name: "Send through proxy" }).click();
  await expect(page.getByText("HTTP 200")).toBeVisible();
  await expect(page.getByText(/"state": "shipped"/)).toBeVisible();
  await page.getByRole("button", { name: "HTTP 5xx" }).click();
  await page.getByRole("button", { name: "Send through proxy" }).click();
  await expect(page.getByText("HTTP 503")).toBeVisible();
});

test("viewers can read results but cannot launch runs", async ({ page }) => {
  await signIn(page, "Viewer");
  await expect(page.getByRole("button", { name: "New run" })).toHaveCount(0);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Test suites" }).click();
  await expect(page.getByRole("link", { name: "Customer support · resilience", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Run suite" })).toHaveCount(0);
});
