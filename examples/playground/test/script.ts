import { reply, type ReplyScript } from "@karmi/core/testing";

/** The script of the guided refund: look up the order, ask for the refund, then tell the outcome. */
export const refundReplies: ReplyScript = ({ request }) => {
  const results = request.messages.filter((message) => message.role === "toolResult");
  if (results.length === 0) return [reply.toolCall("get_order", { orderId: "A-1042" })];
  if (results.length === 1)
    return [reply.toolCall("refund_order", { orderId: "A-1042", amount: 48, reason: "Arrived broken" })];
  return results.at(-1)?.isError ? "I did not make the refund." : "The refund is complete.";
};
