import type { CatalogueInput } from "@karmi/core";
import { shopPolicy } from "./assistant";
import { bookCourier, dispatchAgent, listParcels, packParcel } from "./dispatch";
import { forksAgent } from "./media-forks";
import { getOrder, refundAgent, refundOrder } from "./refund";
import { remindersAgent, sampleInbox, sendReminder } from "./reminders";
import { adjustStock, checkStock, deleteProduct, restock, stockAudit, stockroomAgent } from "./stockroom";

/**
 * The Catalogue of the Playground for the model that setup selected. It has no Agent for the Agent Spec scenario,
 * because that scenario stores its Agent at runtime.
 */
export const catalogue = (model: string): CatalogueInput => ({
  tools: [
    getOrder,
    refundOrder,
    checkStock,
    adjustStock,
    deleteProduct,
    listParcels,
    packParcel,
    bookCourier,
    sendReminder,
  ],
  fragments: [shopPolicy],
  skills: [restock],
  hooks: [stockAudit],
  deliverers: [sampleInbox],
  agents: [refundAgent(model), stockroomAgent(model), dispatchAgent(model), forksAgent(model), remindersAgent(model)],
});
