import { db } from "../../config/firebaseConnection/firebase.js";
import { resolveUserName } from "../archives/resolveUserName.service.js";
import { makeEntriesView } from "./paymentEntries.view.js";

export const { listEntries } = makeEntriesView({ db, resolveName: resolveUserName });