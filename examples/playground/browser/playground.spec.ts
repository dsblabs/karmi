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

/** Opens the Turn control scenario with one suggested prompt and runs it. */
async function runDispatch(page: Page, chip: string): Promise<void> {
  await openScenario(page, "turns");
  await page.getByRole("button", { name: chip, exact: true }).click();
  await page.getByRole("button", { name: "Run" }).click();
}

test("the Turn parks on its budget, takes a steered input and continues after an allow", async ({ page }) => {
  await runDispatch(page, "Budget");
  await expect(page.locator(".approval")).toContainText("Budget of the Turn");
  await expect(page.locator("#turn")).toContainText("a new budget");
  await expect(page.locator("#dispatch")).toContainText("packed");

  // The Harness adds a steered input to the Turn at the next batch boundary, thus its event follows the allow.
  await page.getByLabel("Prompt").fill("Pack the beans parcel last.");
  await page.getByRole("button", { name: "Add to this Turn" }).click();
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page.locator("#steps")).toContainText("added to this Turn");
  await expect(page.locator("#steps")).toContainText("Every parcel is packed.");
  await expect(page.locator("#turn")).toContainText("idle");
});

test("a deny of the continuation ends the Turn on its budget", async ({ page }) => {
  await runDispatch(page, "Budget");
  await page.getByRole("button", { name: "Deny" }).click();
  await expect(page.locator("#steps")).toContainText("ended on its budget");
  await expect(page.locator("#dispatch")).toContainText("open");
});

test("a Job parks the Turn until the operator reports the collection", async ({ page }) => {
  await runDispatch(page, "Job");
  await expect(page.locator("#courier")).toContainText("waiting");
  await expect(page.locator("#turn")).toContainText("the Job");
  await page.getByRole("button", { name: "Report the collection" }).click();
  await expect(page.locator("#steps")).toContainText("The Turn continues");
  await expect(page.locator("#courier")).toContainText("collected");
  await expect(page.locator("#steps")).toContainText("The courier answered.");
});

test("cancellation ends the Turn and keeps what a Tool already did", async ({ page }) => {
  await runDispatch(page, "Job");
  await expect(page.locator("#courier")).toContainText("waiting");
  await page.getByRole("button", { name: "Cancel the Turn" }).click();
  await expect(page.locator("#steps")).toContainText("You cancelled the Turn");
  await expect(page.locator("#courier")).toContainText("No Turn waits for this Job");
  await expect(page.locator("#dispatch")).toContainText("packed");
  await page.getByRole("button", { name: "Reset scenario" }).click();
  await expect(page.locator("#courier")).toContainText("booked no courier yet");
});

test("a Fork keeps its uploaded media after the original Thread is deleted", async ({ page }) => {
  await openScenario(page, "forks");
  await expect(page.locator(".note")).toContainText("Images, audio, video and PDF");
  await page.getByLabel("File").setInputFiles({
    name: "sample.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("browser sample bytes"),
  });
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator("#steps")).toContainText("I received the sample file.");
  await expect(page.locator("#original-thread")).toContainText("sample.txt");
  await expect(page.locator("#steps .you .attachment")).toContainText("sample.txt");
  // The file goes with one message only.
  await expect(page.getByLabel("File")).toHaveValue("");

  await page.getByRole("button", { name: "Fork the Thread" }).click();
  await expect(page.locator("#fork-thread")).toContainText("sample.txt");
  await expect(page.locator("#original-thread")).toContainText("7 events");
  await expect(page.locator("#fork-thread")).toContainText("7 events");

  await page.getByRole("button", { name: "Delete the original" }).click();
  await expect(page.locator("#original-thread")).toContainText("deleted");
  const download = page.waitForEvent("download");
  await page.locator("#fork-thread").getByRole("link", { name: "Download sample.txt" }).click();
  expect(
    await (await download).createReadStream().then(async (stream) => {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      return Buffer.concat(chunks).toString();
    }),
  ).toBe("browser sample bytes");

  // The composer moves to the Fork, which accepts a Turn without a file.
  await expect(page.locator("#target option")).toHaveText(["Send to the Fork Thread"]);
  await page.getByLabel("Prompt").fill("What did I upload?");
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator("#steps .agent")).toHaveCount(2);
  await expect(page.locator("#steps .attachment")).toHaveCount(1);
  await expect(page.locator("#fork-thread")).toContainText("14 events");
});

test("the operator removes a selected file before the message goes", async ({ page }) => {
  await openScenario(page, "forks");
  await page.getByRole("button", { name: "Attach the sample file" }).click();
  await expect(page.getByLabel("File")).toHaveValue(/sample\.txt$/);
  await page.getByRole("button", { name: "Remove the file" }).click();
  await expect(page.getByLabel("File")).toHaveValue("");
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator("#steps .agent")).toBeVisible();
  await expect(page.locator("#steps .attachment")).toHaveCount(0);
  await expect(page.locator("#original-thread")).toContainText("Upload a file to this Thread.");
});

// The layout rules of docs/ui.md. A new view or card must pass at each size without a change to this check.
const VIEWPORTS = { desktop: [1440, 900], tablet: [820, 1180], mobile: [390, 844] } as const;
for (const [name, [width, height]] of Object.entries(VIEWPORTS))
  test(`each view fits a ${name} screen`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(`/#token=${TOKEN}`);
    await expect(page.locator("#provider")).toContainText("Model");
    const views = await page
      .locator("#scenarios a")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    for (const view of [...views, "#coverage"]) {
      await page.goto(`/${view}`);
      await expect(page.locator("main h1")).toBeVisible();
      if (view !== "#coverage") {
        await page.getByRole("button", { name: "Reset scenario" }).click();
        await page.getByRole("button", { name: "Run" }).click();
        await expect(page.locator("#steps .agent, #steps .approval").first()).toBeVisible();
      }
      // Nothing is wider than the page, and no card is cut off by the container that holds it.
      const overflow = await page.locator("html").evaluate((root) => {
        const wide = [...root.querySelectorAll("main .card, main .chat, main .table, main .intro")]
          .filter((node) => node.getBoundingClientRect().right > root.clientWidth + 1)
          .map((node) => node.id || node.className);
        return { scroll: root.scrollWidth - root.clientWidth, wide };
      });
      expect(overflow, `${view} at ${name}`).toEqual({ scroll: 0, wide: [] });
      // A control that the operator presses on a phone is at least 40 CSS pixels high.
      if (name === "mobile")
        for (const button of await page.locator("main button:visible").all())
          expect((await button.boundingBox())?.height, `${view}: ${await button.textContent()}`).toBeGreaterThanOrEqual(
            40,
          );
    }
  });

async function openSchedules(page: Page): Promise<void> {
  await openScenario(page, "schedules");
  await expect(page.locator("#schedules")).toContainText("Create a Schedule here");
}

async function createSchedule(page: Page, mode: string, value: string): Promise<void> {
  await page.getByLabel("Timing mode").selectOption(mode);
  await page.getByLabel("Timing value").fill(value);
  await page.getByRole("button", { name: "Create the Schedule" }).click();
}

test("a Schedule fires into the conversation, and a cancel removes a recurring Schedule", async ({ page }) => {
  await openSchedules(page);
  await createSchedule(page, "cron", "0 9 * * *");
  await expect(page.locator("#schedules")).toContainText("Recurring");
  await page.getByRole("button", { name: "Cancel the Schedule" }).click();
  await expect(page.locator("#schedules")).toContainText("Create a Schedule here");
  await expect(page.locator("#steps")).toContainText("The Thread cancelled a Schedule.");

  await createSchedule(page, "delay", "1s");
  await expect(page.locator("#steps")).toContainText("A Schedule fired.");
  await expect(page.locator("#steps")).toContainText("reminder.due");
  // The Subscriber is attached, thus the Approval request shows in the conversation and the inbox stays empty.
  await page.locator("#steps").getByRole("button", { name: "Allow" }).click();
  await expect(page.locator("#steps")).toContainText("I sent the reminder.");
  await expect(page.locator("#reminders")).toContainText("Sam Rivera");
  await expect(page.locator("#inbox")).toContainText("wrote no message yet");
});

test("the Agent makes a Schedule with its scheduling grant", async ({ page }) => {
  await openSchedules(page);
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator("#steps")).toContainText("I made the Schedule.");
  await expect(page.locator("#schedules")).toContainText("schedule.fired");
});

test("a detached page gets the Approval request and the completed Turn in the sample inbox", async ({ page }) => {
  await openSchedules(page);
  await page.getByRole("button", { name: "Detach the Subscriber" }).click();
  await expect(page.locator("#subscriber")).toContainText("detached");
  await createSchedule(page, "delay", "1s");
  await expect(page.locator("#inbox")).toContainText("The Agent wants to call send_reminder.", { timeout: 15_000 });
  // The detached page reads the events with plain requests, thus the conversation still shows the Turn.
  await expect(page.locator("#steps")).toContainText("A Schedule fired.");
  await page.locator("#inbox").getByRole("button", { name: "Allow" }).click();
  await expect(page.locator("#inbox")).toContainText("I sent the reminder.", { timeout: 15_000 });
  await expect(page.locator("#reminders")).toContainText("Sam Rivera");

  await page.getByRole("button", { name: "Send the supplier Event" }).click();
  await expect(page.locator("#inbox")).toContainText("The supplier delivered 24 kettles.", { timeout: 15_000 });

  await page.getByRole("button", { name: "Reset scenario" }).click();
  await expect(page.locator("#inbox")).toContainText("wrote no message yet");
  await expect(page.locator("#schedules")).toContainText("Create a Schedule here");
});

/** Runs the long prompt of the ledger scenario. A sent message empties the editor, thus the chip fills it again. */
async function runLedger(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Run" })).toBeEnabled();
  await page.getByRole("button", { name: "Long conversation", exact: true }).click();
  await page.getByRole("button", { name: "Run" }).click();
}

async function openLedger(page: Page): Promise<void> {
  await openScenario(page, "compaction");
  await expect(page.locator("#ledger")).toContainText("open");
}

test("a long conversation compacts the Thread, and the Agent continues", async ({ page }) => {
  await openLedger(page);
  await expect(page.locator("#context")).toContainText("2000 tokens");
  await runLedger(page);
  await expect(page.locator("#steps .agent")).toHaveCount(1);
  await expect(page.locator("#steps .compacted")).toHaveCount(0);
  // The reply reported a usage over the limit, thus the next Turn compacts before its model Step.
  await runLedger(page);
  await expect(page.locator("#steps")).toContainText("over the window minus the reserve");
  await expect(page.locator("#steps .compacted")).toContainText("SUMMARY: the operator read the ledger.");
  await expect(page.locator("#steps .compacted")).toContainText("events from seq");
  await expect(page.locator("#steps .agent")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Run" })).toBeEnabled();
  await page.locator(".events summary").click();
  await expect(page.locator("#log")).toContainText('"type":"thread.compacted"');
});

test("the operator compacts an idle Thread with instructions", async ({ page }) => {
  await openLedger(page);
  await runLedger(page);
  await expect(page.locator("#steps .agent")).toHaveCount(1);
  await runLedger(page);
  await expect(page.locator("#steps .agent")).toHaveCount(2);
  // The Thread refuses a Compaction while the Turn runs. Run is enabled again when the Turn ends.
  await expect(page.getByRole("button", { name: "Run" })).toBeEnabled();
  await page.getByRole("button", { name: "Compact the Thread" }).click();
  await expect(page.locator("#steps")).toContainText("You asked for a Compaction.");
  await expect(page.locator("#steps .compacted")).toHaveCount(2);
});

test("a held ledger keeps the Tool call running until the operator releases it", async ({ page }) => {
  await openLedger(page);
  await page.getByRole("button", { name: "Hold the ledger" }).click();
  await expect(page.locator("#ledger")).toContainText("held");
  await page.getByRole("button", { name: "Unsafe call", exact: true }).click();
  await page.getByRole("button", { name: "Run" }).click();
  // The Tool writes the entry before it waits, thus the card shows the entry while the call runs.
  await expect(page.locator("#ledger")).toContainText("Window cleaning");
  await expect(page.locator("#steps .tool .state").first()).toHaveText("running");
  await expect(page.locator("#turn")).toContainText("running");
  await page.getByRole("button", { name: "Release the ledger" }).click();
  await expect(page.locator("#steps")).toContainText("The ledger has the new entry.");
  await expect(page.locator("#turn")).toContainText("idle");
  await page.getByRole("button", { name: "Reset scenario" }).click();
  await expect(page.locator("#ledger")).not.toContainText("Window cleaning");
});

async function openDelegation(page: Page): Promise<void> {
  await openScenario(page, "delegation");
  await expect(page.locator("#children")).toContainText("starts a child Thread");
}

test("the parent shows the child Thread and its Approval, and allow places the order", async ({ page }) => {
  await openDelegation(page);
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator("#steps")).toContainText("started the child Thread");
  // The child card shows the events of the child. The parent log has the Approval of the child only.
  await expect(page.locator("#steps .child")).toContainText("list_suppliers");
  await expect(page.locator("#steps .approval")).toContainText("Tool call of the child Thread: place_order");
  await expect(page.locator("#children")).toContainText("your Approval");
  await expect(page.locator("#turn")).toContainText("the child Thread");
  await expect(page.locator("#turn")).toContainText("1 started, 1 active");
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page.locator("#steps .child")).toContainText("I placed the order.");
  await expect(page.locator("#steps .child")).toContainText("Result for the parent");
  await expect(page.locator("#steps .agent").last()).toContainText("The purchase desk says");
  await expect(page.locator("#purchases")).toContainText("O-1");
  await expect(page.locator("#children")).toContainText("idle");
  await expect(page.locator("#usage")).toContainText("buyer, model");
  await expect(page.locator("#usage")).toContainText("for the call");
  await expect(page.locator("#steps .child")).toContainText("Child Thread for the call");
  await page.locator(".events summary").click();
  await expect(page.locator("#log")).not.toContainText('"name":"list_suppliers"');
});

test("deny leaves the purchase system unchanged, and the child reports it", async ({ page }) => {
  await openDelegation(page);
  await page.getByRole("button", { name: "Run" }).click();
  await page.getByRole("button", { name: "Deny" }).click();
  await expect(page.locator("#steps .child")).toContainText("No order was placed.");
  await expect(page.locator("#steps .agent").last()).toContainText("The purchase desk says");
  await expect(page.locator("#purchases")).toContainText("placed no order yet");
});

test("cancel of the parent Turn stops the child, and reset deletes the children", async ({ page }) => {
  await openDelegation(page);
  await page.getByRole("button", { name: "Two children", exact: true }).click();
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator("#steps .approval")).toHaveCount(2);
  await expect(page.locator("#turn")).toContainText("2 started, 2 active");
  await page.getByRole("button", { name: "Cancel the Turn" }).click();
  await expect(page.locator("#steps")).toContainText("You cancelled the Turn.");
  await expect(page.locator("#steps .child .state").first()).toHaveText("cancelled with the parent Turn");
  await expect(page.locator("#steps .child .state").last()).toHaveText("cancelled with the parent Turn");
  await expect(page.locator("#purchases")).toContainText("placed no order yet");
  await page.getByRole("button", { name: "Reset scenario" }).click();
  await expect(page.locator("#children")).toContainText("starts a child Thread");
  await expect(page.locator("#usage")).toContainText("No model call ran yet");
});

async function openMemory(page: Page): Promise<void> {
  await openScenario(page, "memory");
  await expect(page.locator("#memory-sample-a")).toContainText("Nothing is stored");
}

/** Runs one suggested prompt of the Memory scenario and waits for the answer of the Agent. */
async function runConcierge(page: Page, chip: string, answer: string | RegExp): Promise<void> {
  await expect(page.getByRole("button", { name: "Run" })).toBeEnabled();
  await page.getByRole("button", { name: chip, exact: true }).click();
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator("#steps .agent").last()).toContainText(answer);
}

test("a remembered preference reaches a new Thread, and a forget removes it", async ({ page }) => {
  await openMemory(page);
  await expect(page.locator(".note")).toContainText("needs a model that supports Tool calls");
  await runConcierge(page, "Remember", "I will remember that.");
  await expect(page.locator("#steps .tool")).toContainText("remember");
  await expect(page.locator("#memory-sample-a")).toContainText("stored");
  await expect(page.locator("#memory-sample-a")).toContainText('"roast": "dark"');
  await expect(page.locator("#memory-sample-a")).toContainText("Collects the order on Fridays.");
  await expect(page.locator("#memory-sample-a")).toContainText("operator");

  await page.locator("#memory-sample-a").getByRole("button", { name: "Start a new Thread" }).click();
  await expect(page.locator("#saved")).toContainText("A new Thread of operator in sample-a");
  await expect(page.locator("#steps")).toBeEmpty();
  await expect(page.locator("#memory-sample-a")).toContainText("Threads since the reset2");
  await runConcierge(page, "Ask", "You like a dark roast.");
  await expect(page.locator("#steps .tool")).toHaveCount(0);
  await runConcierge(page, "Search the Notes", "My notes say: ");
  await expect(page.locator("#steps .tool").last()).toContainText("recall");

  await page.locator("#memory-sample-a").getByRole("button", { name: "Forget the User" }).click();
  await expect(page.locator("#memory-sample-a")).toContainText("Nothing is stored");
  await page.locator("#memory-sample-a").getByRole("button", { name: "Start a new Thread" }).click();
  await expect(page.locator("#steps")).toBeEmpty();
  await runConcierge(page, "Ask", "I do not know your preferences yet.");
});

test("the second sample Scope has no Memory of the User, and a key of it is not reachable through the first", async ({
  page,
}) => {
  await openMemory(page);
  await runConcierge(page, "Remember", "I will remember that.");
  await expect(page.locator("#memory-sample-a")).toContainText("stored");
  await page.getByLabel("Thread that receives the Turn").selectOption({ label: "Send in the Scope sample-b" });
  await expect(page.locator("#steps")).toBeEmpty();
  await runConcierge(page, "Ask", "I do not know your preferences yet.");
  await expect(page.locator("#memory-sample-b")).toContainText("Nothing is stored");
  await expect(page.locator("#memory-sample-a")).toContainText('"roast": "dark"');

  await page.getByRole("button", { name: "Read the sample-b Thread as sample-a" }).click();
  await expect(page.locator("#boundary pre")).toContainText("HTTP 404");
  await expect(page.locator("#boundary pre")).toContainText("thread.notFound");

  await page.getByRole("button", { name: "Reset scenario" }).click();
  await expect(page.locator("#memory-sample-a")).toContainText("Nothing is stored");
  await expect(page.locator("#memory-sample-b")).toContainText("Nothing is stored");
  await expect(page.locator("#target option:checked")).toHaveText("Send in the Scope sample-a");
});

test("usage records show attribution, tokens and cost, the handler skips a duplicate, and logs redact credentials", async ({
  page,
}) => {
  await openScenario(page, "observability");
  await expect(page.locator("#usage")).toContainText("No model call ran yet");
  await expect(page.getByRole("link", { name: "Example code" })).toHaveAttribute("href", /src\/observability\.ts$/);
  await page.getByRole("button", { name: "Ask the desk", exact: true }).click();
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator("#steps .agent").last()).toContainText("Usage records of its model calls");
  await expect(page.locator("#usage")).toContainText("sample-a");
  await expect(page.locator("#usage")).toContainText("observability");
  await expect(page.locator("#usage")).toContainText("operator");
  await expect(page.locator("#usage")).toContainText("fake/model");
  await expect(page.locator("#usage td").nth(1)).toHaveText("8 in, 6 out");
  await expect(page.locator("#usage")).toContainText("0.0042 USD, from 1 of 1 records");
  await expect(page.locator("#handler .badge.stored")).toHaveCount(1, { timeout: 15_000 });

  await page.getByRole("button", { name: "Deliver the last batch again" }).click();
  await expect(page.locator("#handler .badge.duplicate")).toHaveText("duplicate, skipped");

  await page.getByRole("button", { name: "Look up a ticket", exact: true }).click();
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator("#steps .agent").last()).toContainText("Ticket T-9 is open");
  await expect(page.locator("#usage")).toContainText("Not reported");
  await expect(page.locator("#usage")).toContainText("0.0042 USD, from 1 of 3 records");
  await expect(page.locator("#logs")).toContainText("[REDACTED]");
  await expect(page.locator("#logs")).not.toContainText("sk-live-example");
  await page.getByRole("button", { name: "Show redaction" }).click();
  await expect(page.locator("#logs")).toContainText('"apiKey": "[REDACTED]"');
  await page.locator("#example-child summary").click();
  await expect(page.locator("#example-child")).toContainText("parent");

  await page.getByRole("button", { name: "Reset scenario" }).click();
  await expect(page.locator("#usage")).toContainText("No model call ran yet");
  await expect(page.locator("#handler")).toContainText("No batch has reached");
  await expect(page.getByRole("button", { name: "Deliver the last batch again" })).toBeHidden();
});

test("the UsageHandler card reads the state again while it waits for the Queue", async ({ page }) => {
  // A deployed Queue delivers some seconds after the Turn. The route answers `waiting` until the check releases it.
  let delivered = false;
  await page.route("**/api/scenarios/observability", async (route) => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("handler" in body)) return route.fulfill({ response });
    const { handler } = body;
    if (typeof handler !== "object" || handler === null) return route.fulfill({ response });
    await route.fulfill({ response, json: { ...body, handler: { ...handler, waiting: !delivered } } });
  });
  await openScenario(page, "observability");
  await expect(page.locator("#handler h3")).toContainText("waiting for the Queue");
  delivered = true;
  // No Thread event arrives now. Only the next read of the page clears the badge.
  await expect(page.locator("#handler h3")).not.toContainText("waiting", { timeout: 5_000 });
});

test("a reconnect timer of the Schedules page does not take the stream of the next view", async ({ page }) => {
  await openScenario(page, "schedules");
  // The reset closes the socket of the Schedules page, and the page connects again after one second.
  await page.goto("/#refund");
  await page.getByRole("button", { name: "Reset scenario" }).click();
  await expect(page.getByRole("button", { name: "Reset scenario" })).toBeEnabled();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator(".approval")).toContainText("refund_order");
});
