import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

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

  return { amountPaid, balance, payType };
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
    const { amountPaid, balance, payType } = computeAmounts(payment);

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
      methodOfPayment: payment.methodOfPayment || "—",
      paymentMethod: payment.paymentMethod || "—",
      referenceNumber: payment.referenceNumber || "—",
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

  const { amountPaid, balance, payType } = computeAmounts(payment);

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
    methodOfPayment: payment.methodOfPayment || "—",
    paymentMethod: payment.paymentMethod || "—",
    referenceNumber: payment.referenceNumber || "—",
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