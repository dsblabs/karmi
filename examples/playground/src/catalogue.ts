import type { CatalogueInput, Retriever } from "@karmi/core";
import { shopPolicy } from "./assistant";
import { conciergeAgent } from "./concierge";
import { containerAgent, sampleFiles } from "./containers";
import { bookCourier, dispatchAgent, listParcels, packParcel } from "./dispatch";
import { ledgerAgent, postEntry, readLedger } from "./ledger";
import { librarianAgent } from "./librarian";
import { scopeDeskAgent } from "./lifecycle";
import { forksAgent } from "./media-forks";
import { mcpDeskAgent } from "./remote-mcp";
import { buyerAgent, listSuppliers, managerAgent, placeOrder } from "./purchases";
import { getOrder, refundAgent, refundOrder } from "./refund";
import { remindersAgent, sampleInbox, sendReminder } from "./reminders";
import { lookupTicket, observabilityAgent, sampleUsageHandler } from "./observability";
import { cancelOrder, findOrders, packBox, readOrder, scriptsAgent } from "./scripts";
import { adjustStock, checkStock, deleteProduct, restock, stockAudit, stockroomAgent } from "./stockroom";
import { vectorAgent } from "./vectors";

/**
 * The Catalogue of the Playground for the model that setup selected. It has no Agent for the Agent Spec scenario,
 * because that scenario stores its Agent at runtime. `retriever` is the vector Retriever of the vector retrieval
 * scenario, which `semanticRetriever` defines.
 */
export const catalogue = (model: string, retriever: Retriever): CatalogueInput => ({
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
    readLedger,
    postEntry,
    listSuppliers,
    placeOrder,
    lookupTicket,
    findOrders,
    readOrder,
    packBox,
    cancelOrder,
  ],
  fragments: [shopPolicy, sampleFiles],
  skills: [restock],
  hooks: [stockAudit],
  retrievers: [retriever],
  deliverers: [sampleInbox],
  agents: [
    refundAgent(model),
    stockroomAgent(model),
    dispatchAgent(model),
    forksAgent(model),
    remindersAgent(model),
    ledgerAgent(model),
    managerAgent(model),
    buyerAgent(model),
    conciergeAgent(model),
    observabilityAgent(model),
    scriptsAgent(model),
    librarianAgent(model),
    containerAgent(model),
    scopeDeskAgent(model),
    mcpDeskAgent(model),
    vectorAgent(model),
  ],
  usageHandler: sampleUsageHandler,
});
