import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { createNotification, resolveNotification } from "../notification/notification.service.js";

// resolve customer name: firstName+lastName (priority), fallback to username
const resolveCustomerName = async (userID) => {
  if (!userID) return "—";
  try {
    // Try userDetails first for firstName + lastName
    const snap = await db.collection("userDetails").where("userID", "==", userID).limit(1).get();
    if (!snap.empty) {
      const { firstName = "", lastName = "" } = snap.docs[0].data();
      const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
      if (fullName) return fullName;
    }
    // Fallback: username from user collection (skip redundant userDetails doc fetch)
    const userDoc = await db.collection("user").doc(userID).get();
    if (userDoc.exists) {
      const { username = "", email = "" } = userDoc.data();
      return username || email || "—";
    }
    return "—";
  } catch { return "—"; }
};

// carID → vehicle name from cars → model → brand
const resolveVehicleName = async (carID) => {
  if (!carID) return "—";
  try {
    const carDoc = await db.collection("cars").doc(carID).get();
    if (!carDoc.exists) return "—";
    const { modelID } = carDoc.data();
    if (!modelID) return "—";
    const modelDoc = await db.collection("model").doc(modelID).get();
    if (!modelDoc.exists) return "—";
    const { brandID, modelName } = modelDoc.data();
    const brandDoc = await db.collection("brand").doc(brandID).get();
    const brandName = brandDoc.exists ? brandDoc.data().brandName : "";
    return [brandName, modelName].filter(Boolean).join(" ") || "—";
  } catch { return "—"; }
};

// Compute amountPaid and balance based on methodOfPayment (the payment type field)
export const computeAmounts = (payment) => {
  const amount     = Number(payment.amount)     || 0;
  const depositFee = Number(payment.depositFee) || 0;
  // methodOfPayment = "Full" | "Downpayment" | "Deposit" | "Partial" (the TYPE)
  // paymentMethod   = "GCash" | "Cash" | "Maya" etc (the GATEWAY)
  const methodOfPayment = (payment.methodOfPayment || "").toLowerCase();
  const status = (payment.status || "").toLowerCase();
  // Nothing counts as received until the gateway/staff actually confirm it —
  // PayMongo's webhook flips status "pending" -> "paid" the moment its
  // checkout session clears (see customer-side paymongo.controller.js),
  // and manual cash goes "pending" -> "Approved" via confirmInitialPayment().
  // Previously the branches below computed amountPaid off methodOfPayment
  // alone, with no check on status at all — so e.g. a "Full" GCash payment
  // still sitting at "pending" (customer hasn't finished checkout, or the
  // webhook just hasn't landed yet) would show as fully paid with ₱0
  // balance, and a "Partial" one fell through to a fallback branch that
  // guessed amountPaid = depositFee regardless of confirmation. Both are
  // now gated on isConfirmed below.
  const isConfirmed = status === "paid" || status === "approved";

  let payType = "—";
  if (methodOfPayment.includes("full")) {
    payType = "Full";
  } else if (methodOfPayment.includes("down")) {
    payType = "Downpayment";
  } else if (methodOfPayment.includes("partial")) {
    payType = "Partial";
  } else if (methodOfPayment.includes("deposit")) {
    payType = "Deposit";
  } else {
    // Unrecognized/legacy methodOfPayment string — still treat as an
    // upfront-portion type rather than guessing "Full".
    payType = "Deposit";
  }

  let amountPaid = 0;
  let balance    = amount;

  if (isConfirmed) {
    if (payType === "Full") {
      amountPaid = amount;
      balance    = 0;
    } else if (payType === "Downpayment") {
      amountPaid = Math.round(amount / 2);
      balance    = amount - amountPaid;
    } else {
      // Deposit / Partial / legacy-unrecognized — upfront portion is the
      // flat deposit fee (see bookings.controller.js: depositFee is
      // always ₱1,000, regardless of the total).
      amountPaid = depositFee || 0;
      balance    = amount - amountPaid;
    }
  }
  // else: still pending — amountPaid stays 0, balance stays the full amount.

  // Staff/driver manually collected the remaining balance in person (cash
  // at pickup or return) via collectRemainingBalance() below — overrides
  // whatever the Downpayment/Deposit split above computed. Deliberately
  // doesn't touch methodOfPayment itself, so reporting still reflects how
  // the *initial* portion actually came in.
  if (payment.balanceCollected) {
    amountPaid = amount;
    balance    = 0;
  }

  // Flat-peso discount applied by staff via applyDiscount() below — comes
  // off whatever's still owed first; if the balance can't absorb all of
  // it (e.g. the booking's already fully paid, balance already 0), the
  // rest spills onto amountPaid instead. This keeps amountPaid + balance
  // always equal to (totalFee - discountAmount), regardless of whether
  // the discount was applied before or after the customer finished
  // paying. Drivers see this reflected here (read-only) but can't apply
  // it themselves — only staff can, via Payments.jsx or Car Tracking.
  //
  // That spillover is cash now owed BACK to the customer — refundDue
  // below surfaces it. Computed fresh here (not trusted from a stored
  // field) so it can never drift from the actual amount/discount numbers
  // on the doc; only whether it's been handed back (refundIssued) is
  // persisted, by markRefundIssued().
  const discountAmount = Number(payment.discountAmount) || 0;
  let refundDue = 0;
  if (discountAmount > 0) {
    if (balance >= discountAmount) {
      balance -= discountAmount;
    } else {
      const spillover = discountAmount - balance;
      balance = 0;
      amountPaid = Math.max(0, amountPaid - spillover);
      refundDue = payment.refundIssued ? 0 : spillover;
    }
  }

  return { amountPaid, balance, payType, refundDue };
};

// ─────────────────────────────────────────────
// Confirm a booking's initial payment as received — for Cash/in-person
// payments where staff or the driver physically receive the initial
// portion (Full/Downpayment/Deposit) directly at the counter or at
// pickup, rather than it coming through PayMongo (GCash/Maya/QRPH),
// which is already auto-confirmed by handleWebhook() on the customer
// side the moment it settles — no manual step needed there at all.
//
// This lets Car Tracking / My Trips confirm cash on the spot instead of
// requiring a trip to the Payments page just to click Approve.
// ─────────────────────────────────────────────
export const confirmInitialPayment = async (bookingID, confirmedBy) => {
  if (!bookingID) throw new Error("bookingID is required.");

  const snap = await db.collection("payments")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();
  if (snap.empty) throw new Error("No payment record found for this booking.");

  const doc  = snap.docs[0];
  const data = doc.data();

  const status = (data.status || "").toLowerCase();
  if (status === "approved" || status === "paid") {
    throw new Error("This payment is already confirmed.");
  }
  if (status === "rejected" || status === "cancelled") {
    throw new Error(`Cannot confirm: payment is ${data.status}.`);
  }

  await doc.ref.update({
    status:      "Approved",
    confirmedBy: confirmedBy || "—",
    confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
  });

  return { id: doc.id, bookingID };
};

// ─────────────────────────────────────────────
// Manually mark a booking's remaining balance as collected — for
// Cash/in-person payments where staff or the driver physically receive
// the rest of the fee at pickup or return, rather than it coming through
// an online GCash/Maya proof that gets Approved on the Payments page.
//
// Requires the payment's initial portion to already be Approved/Paid
// first (this mirrors the same gate updateBooking() already applies
// before a booking can move to "ongoing" — by the time anyone is at
// pickup, the payment record is guaranteed to already be Approved).
// ─────────────────────────────────────────────
export const collectRemainingBalance = async (bookingID, collectedBy) => {
  if (!bookingID) throw new Error("bookingID is required.");

  const snap = await db.collection("payments")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();
  if (snap.empty) throw new Error("No payment record found for this booking.");

  const doc  = snap.docs[0];
  const data = doc.data();

  const status = (data.status || "").toLowerCase();
  if (status !== "approved" && status !== "paid") {
    throw new Error(
      `Cannot collect balance: payment is still "${data.status || "Pending"}". ` +
      `Approve the payment first in the Payments page.`
    );
  }
  if (data.balanceCollected) {
    throw new Error("This booking is already marked fully paid.");
  }

  const { balance } = computeAmounts(data);
  if (balance <= 0) {
    throw new Error("There is no remaining balance to collect.");
  }

  await doc.ref.update({
    balanceCollected:   true,
    balanceCollectedAt: admin.firestore.FieldValue.serverTimestamp(),
    balanceCollectedBy: collectedBy || "—",
    updatedAt:          admin.firestore.FieldValue.serverTimestamp(),
  });

  return { id: doc.id, bookingID };
};

// ─────────────────────────────────────────────
// Staff applying a flat-peso discount to a booking's payment — e.g. a
// goodwill deduction at pickup. Flat peso only, deliberately no
// percentage option (matches how discounts are actually decided in
// person). Staff-only (Payments.jsx or Car Tracking) — drivers can see
// the resulting numbers via computeAmounts() above, but never call this
// themselves; there's no driver-facing route for it.
// ─────────────────────────────────────────────
export const applyDiscount = async (bookingID, amount, reason, appliedBy) => {
  if (!bookingID) throw new Error("bookingID is required.");
  const discountAmount = Number(amount);
  if (!Number.isFinite(discountAmount) || discountAmount < 0) {
    throw new Error("Discount must be a valid, non-negative peso amount.");
  }

  const snap = await db.collection("payments")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();
  if (snap.empty) throw new Error("No payment record found for this booking.");

  const doc = snap.docs[0];
  const existing = doc.data();

  // Once a refund created by this discount has already been physically
  // handed back (refundIssued: true), this route is no longer the right
  // one — reopening/renotifying over a discount that's already been
  // settled in person would be misleading (see correctIssuedDiscount()
  // below, which is the Admin-only path for fixing the number on record
  // after the fact, without reopening or re-notifying anyone).
  if (existing.refundIssued) {
    throw new Error(
      "This discount's refund has already been marked as returned. " +
      "Only an Admin can correct the recorded amount now, via the discount correction option."
    );
  }

  // Figure out if this new discount amount spills past the outstanding
  // balance — i.e. creates a refund owed to the customer. Reset
  // refundIssued to false here: this is a fresh discount value, so any
  // earlier "returned" mark doesn't necessarily still apply to it.
  const { refundDue } = computeAmounts({ ...existing, discountAmount, refundIssued: false });

  await doc.ref.update({
    discountAmount,
    discountReason: reason || "",
    discountBy:     appliedBy || "—",
    discountAt:     admin.firestore.FieldValue.serverTimestamp(),
    refundDue,
    refundIssued:   false,
    updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
  });

  if (refundDue > 0) {
    // Visible to everyone logged into the admin panel (the notification
    // bell isn't role-filtered) — the driver holding the cash needs to
    // see this, and staff should be able to track it got handled.
    await createNotification({
      type: "refund_due",
      refID: bookingID,
      refCollection: "bookings",
      title: "Refund due to customer",
      message: `A discount was applied to booking ${bookingID} after it was already paid — ₱${refundDue.toLocaleString()} needs to be returned to the customer.`,
    });
  } else {
    // Discount was reduced/removed so it no longer creates a refund —
    // clear out any stale active alert for this booking.
    await resolveNotification("refund_due", bookingID);
  }

  return { id: doc.id, bookingID, discountAmount, refundDue };
};

// ─────────────────────────────────────────────
// Admin-only "backdoor" correction — for when a discount's refund has
// ALREADY been marked as returned (refundIssued: true) via
// markRefundIssued(), but the recorded amount was wrong (e.g. staff
// verbally told the driver ₱500 but only entered ₱50 in the system, the
// driver handed over ₱500 and clicked "given" against the ₱50 figure).
//
// This exists purely to fix the paper trail after the fact — it does NOT
// reopen the refund (refundIssued stays true) and does NOT create or
// touch the refund_due notification, since nothing further is being
// asked of the driver or anyone else; the money already changed hands.
// Route-gated to Admin only (see payments.routes.js) — Owner and
// Supervisor go through the normal applyDiscount() edit flow instead,
// which is blocked once refundIssued is true (see above).
// ─────────────────────────────────────────────
export const correctIssuedDiscount = async (bookingID, amount, reason, correctedBy) => {
  if (!bookingID) throw new Error("bookingID is required.");
  const discountAmount = Number(amount);
  if (!Number.isFinite(discountAmount) || discountAmount < 0) {
    throw new Error("Discount must be a valid, non-negative peso amount.");
  }
  if (!reason || !reason.trim()) {
    throw new Error("A reason is required when correcting an already-issued discount.");
  }

  const snap = await db.collection("payments")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();
  if (snap.empty) throw new Error("No payment record found for this booking.");

  const doc = snap.docs[0];
  const existing = doc.data();

  if (!existing.refundIssued) {
    throw new Error(
      "This booking's refund hasn't been marked as returned yet — use the normal discount edit instead."
    );
  }

  const previousAmount = Number(existing.discountAmount) || 0;

  // Recompute refundDue against the corrected number, but leave
  // refundIssued exactly as it was (true) — this is a records-only fix,
  // not a new refund event.
  const { refundDue } = computeAmounts({ ...existing, discountAmount, refundIssued: true });

  await doc.ref.update({
    discountAmount,
    discountReason: reason.trim(),
    refundDue,
    discountCorrectedBy: correctedBy || "—",
    discountCorrectedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:           admin.firestore.FieldValue.serverTimestamp(),
  });

  // Deliberately no createNotification()/resolveNotification() call here
  // — see comment above.

  return { id: doc.id, bookingID, previousAmount, discountAmount, refundDue };
};

// ─────────────────────────────────────────────
// Staff OR the driver holding the cash confirming a refund-due amount
// (see applyDiscount()'s refundDue above) was actually handed back to
// the customer. Resolves the refund_due notification once marked.
// ─────────────────────────────────────────────
export const markRefundIssued = async (bookingID, issuedBy) => {
  if (!bookingID) throw new Error("bookingID is required.");

  const snap = await db.collection("payments")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();
  if (snap.empty) throw new Error("No payment record found for this booking.");

  const doc  = snap.docs[0];
  const data = doc.data();

  const { refundDue } = computeAmounts(data);
  if (refundDue <= 0) {
    throw new Error("There is no refund due on this booking.");
  }

  await doc.ref.update({
    refundIssued:   true,
    refundIssuedBy: issuedBy || "—",
    refundIssuedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
  });

  await resolveNotification("refund_due", bookingID);

  return { id: doc.id, bookingID };
};

export const getAllPayments = async () => {
  const snapshot = await db.collection("payments").orderBy("createdAt", "desc").get();
  const docs = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  // Batch-resolve bookings for carID and userID
  const bookingIDs = [...new Set(docs.map((d) => d.bookingID).filter(Boolean))];
  const bookingMap = {};
  if (bookingIDs.length) {
    const bookingDocs = await Promise.all(
      bookingIDs.map((id) => db.collection("bookings").doc(id).get())
    );
    bookingDocs.forEach((doc) => {
      if (doc.exists) bookingMap[doc.id] = doc.data();
    });
  }

  // Collect unique carIDs and userIDs from bookings
  const carIDs  = [...new Set(Object.values(bookingMap).map((b) => b.carID).filter(Boolean))];
  const userIDs = [...new Set(Object.values(bookingMap).map((b) => b.userID).filter(Boolean))];

  // Resolve vehicles
  const vehicleMap = {};
  await Promise.all(carIDs.map(async (id) => {
    vehicleMap[id] = await resolveVehicleName(id);
  }));

  // Resolve customer names
  const nameMap = {};
  await Promise.all(userIDs.map(async (id) => {
    nameMap[id] = await resolveCustomerName(id);
  }));

  return docs.map((payment) => {
    const booking = bookingMap[payment.bookingID] || {};
    const vehicleName = vehicleMap[booking.carID] || "—";
    const customerName = nameMap[booking.userID] || "—";
    const { amountPaid, balance, payType, refundDue } = computeAmounts(payment);

    // Normalize status: Paid → Approved (case-insensitive, since automated
    // PayMongo payments — GCash/PayMaya/QRPH — are saved as lowercase "paid"
    // while manual approvals from patchPaymentStatus save "Approved").
    // auto-cancel if booking cancelled
    let status = payment.status || "Pending";
    if (status.toLowerCase() === "paid") status = "Approved";
    if ((booking.status || "").toLowerCase() === "cancelled") {
      status = "Cancelled";
    }

    return {
      id: payment.id,
      paymentID: payment.paymentID || payment.id,
      bookingID: payment.bookingID || "—",
      customerName,
      vehicleName,
      totalFee: Number(payment.amount) || 0,
      amountPaid,
      balance,
      payType,
      discountAmount: Number(payment.discountAmount) || 0,
      discountReason: payment.discountReason || "",
      refundDue: refundDue,
      refundIssued: !!payment.refundIssued,
      methodOfPayment: payment.methodOfPayment || "—",
      paymentMethod: payment.paymentMethod || "—",
      referenceNumber: payment.referenceNumber || "—",
      paymongoPaymentID: payment.paymongoPaymentID || null,
      status,
      proofUrl: payment.proofUrl || "",
      depositFee: Number(payment.depositFee) || 0,
      rentalFee: Number(payment.rentalFee) || 0,
      extraFee: Number(payment.extraFee) || 0,
      serviceFee: Number(payment.serviceFee) || 0,
      createdAt: payment.createdAt?.toDate ? payment.createdAt.toDate().toISOString() : null,
      updatedAt: payment.updatedAt?.toDate ? payment.updatedAt.toDate().toISOString() : null,
    };
  });
};

export const updatePaymentStatus = async (id, status) => {
  const allowed = ["Pending", "Approved", "Rejected", "Cancelled"];
  if (!allowed.includes(status)) throw new Error("Invalid status.");
  await db.collection("payments").doc(id).update({
    status,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
};

export const getPaymentById = async (id) => {
  const doc = await db.collection("payments").doc(id).get();
  if (!doc.exists) throw new Error("Payment not found.");
  const payment = { id: doc.id, ...doc.data() };

  const booking = payment.bookingID
    ? (await db.collection("bookings").doc(payment.bookingID).get())
    : null;
  const bookingData = booking?.exists ? booking.data() : {};

  const [customerName, vehicleName] = await Promise.all([
    resolveCustomerName(bookingData.userID),
    resolveVehicleName(bookingData.carID),
  ]);

  const { amountPaid, balance, payType, refundDue } = computeAmounts(payment);

  let status = payment.status || "Pending";
  if (status.toLowerCase() === "paid") status = "Approved";
  if ((bookingData.status || "").toLowerCase() === "cancelled") status = "Cancelled";

  return {
    id: payment.id,
    paymentID: payment.paymentID || payment.id,
    bookingID: payment.bookingID || "—",
    customerName,
    vehicleName,
    totalFee: Number(payment.amount) || 0,
    amountPaid,
    balance,
    payType,
    discountAmount: Number(payment.discountAmount) || 0,
    discountReason: payment.discountReason || "",
    refundDue: refundDue,
    refundIssued: !!payment.refundIssued,
    methodOfPayment: payment.methodOfPayment || "—",
    paymentMethod: payment.paymentMethod || "—",
    referenceNumber: payment.referenceNumber || "—",
    paymongoPaymentID: payment.paymongoPaymentID || null,
    status,
    proofUrl: payment.proofUrl || "",
    depositFee: Number(payment.depositFee) || 0,
    rentalFee: Number(payment.rentalFee) || 0,
    extraFee: Number(payment.extraFee) || 0,
    serviceFee: Number(payment.serviceFee) || 0,
    createdAt: payment.createdAt?.toDate ? payment.createdAt.toDate().toISOString() : null,
    updatedAt: payment.updatedAt?.toDate ? payment.updatedAt.toDate().toISOString() : null,

  };
};