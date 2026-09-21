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

/** The script of the browser checks. It selects the replies from the Prompt, thus one Provider serves each scenario. */
export const playgroundReplies: ReplyScript = (ctx) => {
  const system = ctx.request.system ?? "";
  if (system.includes("refund desk")) return refundReplies(ctx);
  if (system.includes("stock system")) return restockReplies(ctx);
  if (system.includes("dispatch desk")) return dispatchReplies(ctx);
  if (system.includes("reminder desk")) return reminderReplies(ctx);
  if (system.includes("attached file")) return "I received the sample file.";
  const days = /for (\d+) days/.exec(system)?.[1];
  return system.includes("pirate") ? `Arr, ye have ${days} days.` : `You can return it for ${days} days.`;
};
