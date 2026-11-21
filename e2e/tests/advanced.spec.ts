import { test, expect, type Page } from "@playwright/test";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Engineer", exact: true }).click();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Agent reliability overview")).toBeVisible({ timeout: 90_000 });
}
const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Main" }).getByRole("link", { name }).click();

test("live experiment: start, see it inject into real traffic, kill switch", async ({ page }) => {
  await signIn(page);
  await page.request.post("/api/experiments/stop-all"); // clean slate: no leftovers from earlier runs
  await nav(page, "Live experiments");
  await page.getByRole("button", { name: "New experiment" }).click();
  const d = page.getByRole("dialog");
  const name = `e2e weather outage ${Date.now()}`;
  await d.getByLabel("Name / hypothesis").fill(name);
  await d.getByLabel("Target").selectOption("tool:get_weather");
  await d.getByLabel("Fault").selectOption("http_error");
  await d.getByLabel("% of traffic").fill("100");
  await d.getByLabel("Max injections").fill("3");
  await d.getByRole("button", { name: "Start experiment" }).click();
  await expect(page.getByText(/injecting faults into live traffic/)).toBeVisible();

  await nav(page, "Chaos studio");
  await page.getByLabel("Target").selectOption("get_weather");
  await page.getByRole("button", { name: "Send through proxy" }).click();
  await expect(page.getByText("HTTP 503")).toBeVisible();

  await nav(page, "Live experiments");
  const card = page.locator(".card").filter({ hasText: name });
  await expect(card.getByText(/1 \/ 3 injections/)).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /Kill switch/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Stop everything" }).click();
  await expect(card.getByText(/kill switch by/)).toBeVisible();
  await expect(page.getByText(/injecting faults into live traffic/)).toHaveCount(0);
});

test("mutation fuzzing adds obfuscated red-team variants", async ({ page }) => {
  await signIn(page);
  await nav(page, "Test suites");
  await page.getByRole("link", { name: "Prompt injection red team", exact: true }).click();
  await page.getByRole("button", { name: "Generate attack mutations of Direct system-prompt extraction", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Add 4 scenarios/ }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Direct system-prompt extraction · Base64 smuggling", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Flakiness & stability")).toBeVisible();
});
