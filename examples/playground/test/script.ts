import { reply, type ReplyScript } from "@karmi/core/testing";

/** The script of the guided refund: look up the order, ask for the refund, then tell the outcome. */
export const refundReplies: ReplyScript = ({ request }) => {
  const results = request.messages.filter((message) => message.role === "toolResult");
  if (results.length === 0) return [reply.toolCall("get_order", { orderId: "A-1042" })];
  if (results.length === 1)
    return [reply.toolCall("refund_order", { orderId: "A-1042", amount: 48, reason: "Arrived broken" })];
  return results.at(-1)?.isError ? "I did not make the refund." : "The refund is complete.";
};

/** The script of the restock prompt: activate the Skill, order from the supplier, then tell the outcome. */
const restockReplies: ReplyScript = ({ request }) => {
  // The Turn is the part of the conversation after the last message of the operator.
  const turn = request.messages.slice(request.messages.findLastIndex((message) => message.role === "user"));
  const results = turn.filter((message) => message.role === "toolResult").length;
  if (results === 0) return [reply.toolCall("use_skill", { name: "restock" })];
  if (results === 1) return [reply.toolCall("order_supplier", { sku: "KET-02", quantity: 24 })];
  return "I ordered 24 kettles from the supplier.";
};

/**
 * The script of the Turn control scenario: pack the parcels that are not packed, or book the courier. The
 * checks run with a small budget, thus the Turn asks to continue before every parcel is packed.
 */
const dispatchReplies: ReplyScript = ({ request }) => {
  const results = request.messages.filter((message) => message.role === "toolResult");
  const asked = JSON.stringify(request.messages.filter((message) => message.role === "user"));
  const packed = results.filter((result) => result.toolName === "pack_parcel" && !result.isError).length;
  if (asked.includes("courier")) {
    if (packed === 0) return [reply.toolCall("pack_parcel", { parcelId: "P-1" })];
    return results.some((result) => result.toolName === "book_courier")
      ? "The courier answered."
      : [reply.toolCall("book_courier", { note: "Ring the bell." })];
  }
  return packed >= 4 ? "Every parcel is packed." : [reply.toolCall("pack_parcel", { parcelId: `P-${packed + 1}` })];
};

/**
 * The script of the Schedules scenario: make a Schedule when the operator asks for one, send the reminder that an
 * Event or the operator asks for, and tell what a supplier Event brought.
 */
const reminderReplies: ReplyScript = ({ request }) => {
  const turn = request.messages.slice(request.messages.findLastIndex((message) => message.role === "user"));
  const asked = JSON.stringify(turn[0]);
  const results = turn.filter((message) => message.role === "toolResult");
  if (asked.includes("supplier.delivery")) return "The supplier delivered 24 kettles.";
  if (asked.includes("Use a Schedule"))
    return results.length === 0
      ? [reply.toolCall("schedule", { delay: "1m", payload: { customer: "Sam Rivera" } })]
      : "I made the Schedule.";
  if (results.length === 0)
    return [reply.toolCall("send_reminder", { customer: "Sam Rivera", text: "Order A-1042 is ready for collection." })];
  return results.at(-1)?.isError ? "I did not send the reminder." : "I sent the reminder.";
};

/**
 * The script of the Compaction and recovery scenario. The reply to the long prompt is large and reports a usage
 * over the limit of the Agent, thus the next Turn compacts. The summarising call of the Harness gets a summary.
 */
const ledgerReplies: ReplyScript = ({ request }) => {
  if (request.system?.includes("compacting")) return "SUMMARY: the operator read the ledger.";
  const turn = request.messages.slice(request.messages.findLastIndex((message) => message.role === "user"));
  const asked = JSON.stringify(turn[0]);
  const results = turn.filter((message) => message.role === "toolResult");
  if (asked.includes("describe each entry"))
    return results.length === 0
      ? [reply.toolCall("read_ledger", {})]
      : [
          reply.text(`Each entry, in one sentence. ${"The shop bought something. ".repeat(100)}`),
          reply.usage({ input: 1600, output: 600 }),
        ];
  if (asked.includes("Post an entry"))
    return results.length === 0
      ? [reply.toolCall("post_entry", { text: "Window cleaning", amount: 12 })]
      : results.length === 1
        ? [reply.toolCall("read_ledger", {})]
        : "The ledger has the new entry.";
  return results.length === 0 ? [reply.toolCall("read_ledger", {})] : "The total is 304.";
};

/**
 * The script of the Delegation scenario. The parent gives one task to the purchase desk for each order that the
 * operator asks for. The child lists the suppliers, places the order and reports in one sentence.
 */
export const delegationReplies: ReplyScript = ({ request }) => {
  const results = request.messages.filter((message) => message.role === "toolResult");
  if (request.system?.includes("manage a small shop")) {
    if (results.length > 0)
      return `The purchase desk says: ${results
        .map((result) => result.content.map((block) => ("text" in block ? block.text : "")).join(" "))
        .join(" ")}`;
    const asked = JSON.stringify(request.messages.at(-1));
    const tasks = ["Order 20 bags of espresso beans from the cheapest supplier."];
    if (asked.includes("filter paper")) tasks.push("Order 10 boxes of filter paper.");
    return tasks.map((task) => reply.toolCall("delegate", { agent: "buyer", task }));
  }
  const task = JSON.stringify(request.messages[0]);
  const paper = task.includes("filter paper");
  if (results.length === 0) return [reply.toolCall("list_suppliers", {})];
  if (results.length === 1)
    return [reply.toolCall("place_order", { supplierId: paper ? "S-3" : "S-2", quantity: paper ? 10 : 20 })];
  return results.at(-1)?.isError ? "No order was placed." : "I placed the order.";
};

/**
 * The script of the Memory scenario. The Agent saves a preference with `remember`, searches the Notes with `recall`,
 * and answers a question from the Memory Fragment of its Prompt, which the Harness renders under `# Memory`.
 */
export const conciergeReplies: ReplyScript = ({ request }) => {
  const turn = request.messages.slice(request.messages.findLastIndex((message) => message.role === "user"));
  const asked = JSON.stringify(turn[0]).toLowerCase();
  const results = turn.filter((message) => message.role === "toolResult");
  const text = (index: number) =>
    results[index]?.content.map((block) => ("text" in block ? block.text : "")).join(" ") ?? "";
  if (asked.includes("remember")) {
    if (results.length === 0) {
      const roast = /(light|medium|dark) roast/.exec(asked)?.[1] ?? "dark";
      return [reply.toolCall("remember", { profile: { roast }, note: "Collects the order on Fridays." })];
    }
    return results[0]?.isError ? "I could not save that." : "I will remember that.";
  }
  if (asked.includes("search"))
    return results.length === 0 ? [reply.toolCall("recall", { query: "Fridays" })] : `My notes say: ${text(0)}`;
  const roast = /- roast: "(\w+)"/.exec(request.system ?? "")?.[1];
  return roast ? `You like a ${roast} roast.` : "I do not know your preferences yet.";
};

/**
 * The script of the Usage and logging scenario. A ticket prompt looks up T-9. Other prompts answer in text and
 * can report a cost.
 */
export const observabilityReplies: ReplyScript = ({ request }) => {
  const turn = request.messages.slice(request.messages.findLastIndex((message) => message.role === "user"));
  const asked = JSON.stringify(turn[0]).toLowerCase();
  const results = turn.filter((message) => message.role === "toolResult");
  if (asked.includes("ticket") || asked.includes("look up"))
    return results.length === 0 ? [reply.toolCall("lookup_ticket", { ticketId: "T-9" })] : "Ticket T-9 is open.";
  return [
    reply.text("This Thread has the Usage records of its model calls."),
    reply.usage({
      input: 8,
      output: 6,
      cost: { amount: 0.0042, currency: "USD", source: "openrouter", basis: "billed" },
    }),
  ];
};

/** The script of the browser checks. It selects the replies from the Prompt, thus one Provider serves each scenario. */
export const playgroundReplies: ReplyScript = (ctx) => {
  const system = ctx.request.system ?? "";
  if (system.includes("refund desk")) return refundReplies(ctx);
  if (system.includes("stock system")) return restockReplies(ctx);
  if (system.includes("dispatch desk")) return dispatchReplies(ctx);
  if (system.includes("reminder desk")) return reminderReplies(ctx);
  if (system.includes("ledger") || system.includes("compacting")) return ledgerReplies(ctx);
  if (system.includes("manage a small shop") || system.includes("purchase desk")) return delegationReplies(ctx);
  if (system.includes("concierge")) return conciergeReplies(ctx);
  if (system.includes("Usage desk") || system.includes("Do not invent a cost")) return observabilityReplies(ctx);
  if (system.includes("attached file")) return "I received the sample file.";
  const days = /for (\d+) days/.exec(system)?.[1];
  return system.includes("pirate") ? `Arr, ye have ${days} days.` : `You can return it for ${days} days.`;
};
