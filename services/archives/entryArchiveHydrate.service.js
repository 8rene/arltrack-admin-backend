import { db } from "../../config/firebaseConnection/firebase.js";
import { makeEntryArchiveHydrate } from "./entryArchiveHydrate.core.js";

const svc = makeEntryArchiveHydrate(db);

export const hydratePaymentsWithArchives        = svc.hydratePaymentsWithArchives;
export const hydratePenaltiesWithArchives       = svc.hydratePenaltiesWithArchives;
export const hydrateRefundRequestsWithArchives  = svc.hydrateRefundRequestsWithArchives;
