import { expect, test, type Page } from "@playwright/test";
import { TOKEN } from "../test/worker-options";

async function open(page: Page): Promise<void> {
  await page.goto(`/#token=${TOKEN}`);
  await expect(page.locator("#provider")).toContainText("OpenRouter");
  await page.getByRole("button", { name: "Reset scenario" }).click();
  // The button is off while the reset runs.
  await expect(page.getByRole("button", { name: "Reset scenario" })).toBeEnabled();
  await expect(page.locator("#order")).toContainText("delivered");
}

async function runToApproval(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator(".approval")).toContainText("refund_order");
}

test("a wrong token does not open the Playground", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Access token").fill("wrong");
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("alert")).toContainText("did not accept");
  await expect(page.locator("#app")).toBeHidden();
  await page.getByLabel("Access token").fill(TOKEN);
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.locator("#provider")).toContainText("Model: test/model");
});

test("the scenario explains the model limit and labels the sample data", async ({ page }) => {
  await open(page);
  await expect(page.locator(".note")).toContainText("needs a model that supports Tool calls");
  await expect(page.locator("#order")).toContainText("sample data");
  await expect(page.getByLabel("Prompt")).toHaveValue(/A-1042/);
  await expect(page.getByRole("link", { name: "Example code" })).toHaveAttribute("href", /src\/refund\.ts$/);
});

test("allow refunds the sample order", async ({ page }) => {
  await open(page);
  await page.getByLabel("Prompt").fill("Please refund order A-1042, it arrived broken.");
  await runToApproval(page);
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page.locator(".outcome")).toContainText("allow");
  await expect(page.locator("#steps")).toContainText("The refund is complete.");
  await expect(page.locator("#order")).toContainText("refunded");
  await page.getByText("Event log").click();
  await expect(page.locator("#log")).toContainText('"type":"tool.result"');
  // The state stays after a reload.
  await page.reload();
  await expect(page.locator("#order")).toContainText("refunded");
  await expect(page.locator("#steps")).toContainText("Please refund order A-1042");
});

test("deny leaves the sample order unchanged", async ({ page }) => {
  await open(page);
  await runToApproval(page);
  await page.getByRole("button", { name: "Deny" }).click();
  await expect(page.locator(".outcome")).toContainText("deny");
  await expect(page.locator("#steps")).toContainText("I did not make the refund.");
  await expect(page.locator("#order")).toContainText("delivered");
});

test("reset cancels the pending Approval and restores the scenario", async ({ page }) => {
  await open(page);
  await runToApproval(page);
  await page.getByRole("button", { name: "Reset scenario" }).click();
  await expect(page.locator(".approval")).toHaveCount(0);
  await expect(page.locator("#order")).toContainText("delivered");
  await expect(page.getByRole("button", { name: "Run" })).toBeEnabled();
});

test("a scenario that is not built shows its status and prerequisites", async ({ page }) => {
  await open(page);
  await page.getByRole("link", { name: /Isolate and container Scripts/ }).click();
  await expect(page.locator("main")).toContainText("incomplete");
  await expect(page.locator("main")).toContainText("Docker");
  await page.getByRole("link", { name: "Feature coverage" }).click();
  await expect(page.locator("table")).toContainText("Approvals");
});

async function openScenario(page: Page, id: string): Promise<void> {
  await page.goto(`/#token=${TOKEN}`);
  await expect(page.locator("#provider")).toContainText("OpenRouter");
  await page.goto(`/#${id}`);
  await page.getByRole("button", { name: "Reset scenario" }).click();
  await expect(page.getByRole("button", { name: "Reset scenario" })).toBeEnabled();
}

test("a saved Agent Spec changes the next Turn, and the Scope ceiling rejects a larger grant", async ({ page }) => {
  await openScenario(page, "agents");
  await expect(page.locator("#prompt-preview")).toContainText("for 30 days");
  await expect(page.getByRole("link", { name: "Example code" })).toHaveAttribute("href", /src\/assistant\.ts$/);
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator("#steps")).toContainText("You can return it for 30 days.");

  await page.getByRole("button", { name: "Change the instructions" }).click();
  await page.getByRole("button", { name: "Save the Spec" }).click();
  await expect(page.locator("#saved")).toContainText("The Scope stored version");
  await expect(page.locator("#steps")).toBeEmpty();
  await expect(page.locator("#prompt-preview")).toContainText("pirate");
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator("#steps")).toContainText("Arr, ye have 30 days.");

  await page.getByRole("button", { name: "Grant more than the ceiling" }).click();
  await page.getByRole("button", { name: "Save the Spec" }).click();
  await expect(page.locator("#spec-result")).toContainText("capability.over-ceiling");

  await page.getByRole("button", { name: "Reset scenario" }).click();
  await expect(page.locator("#prompt-preview")).not.toContainText("pirate");
  await expect(page.locator("#steps")).toBeEmpty();
});

test("a Skill adds its Tool, and the Hook writes the audit log", async ({ page }) => {
  await openScenario(page, "stockroom");
  await expect(page.locator(".note")).toContainText("needs a model that supports Tool calls");
  await page.getByRole("button", { name: "Skill", exact: true }).click();
  await expect(page.getByLabel("Prompt")).toHaveValue(/KET-02/);
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator("#steps")).toContainText("The Skill restock is active");
  await expect(page.locator("#steps")).toContainText("I ordered 24 kettles");
  await expect(page.locator("#panel")).toContainText("24 × KET-02");
  await expect(page.locator("#audit")).toContainText("order_supplier");
  await page.getByRole("button", { name: "Reset scenario" }).click();
  await expect(page.locator("#audit")).toContainText("wrote no line yet");
});
