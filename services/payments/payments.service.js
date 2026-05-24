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
    // Fallback: doc by id
    const detailDoc = await db.collection("userDetails").doc(userID).get();
    if (detailDoc.exists) {
      const { firstName = "", lastName = "" } = detailDoc.data();
      const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
      if (fullName) return fullName;
    }
    // Last fallback: username from user collection
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
const computeAmounts = (payment) => {
  const amount     = Number(payment.amount)     || 0;
  const depositFee = Number(payment.depositFee) || 0;
  // methodOfPayment = "Full" | "Downpayment" | "Deposit" (the TYPE)
  // paymentMethod   = "GCash" | "Cash" | "Maya" etc (the GATEWAY)
  const methodOfPayment = (payment.methodOfPayment || "").toLowerCase();

  let amountPaid = 0;
  let balance    = 0;
  let payType    = "—";

  if (methodOfPayment.includes("full")) {
    amountPaid = amount;
    balance    = 0;
    payType    = "Full";
  } else if (methodOfPayment.includes("down")) {
    amountPaid = Math.round(amount / 2);
    balance    = amount - amountPaid;
    payType    = "Downpayment";
  } else if (methodOfPayment.includes("deposit")) {
    amountPaid = depositFee;
    balance    = amount - depositFee;
    payType    = "Deposit";
  } else {
    // fallback: if status is Paid/Approved treat as full
    const status = (payment.status || "").toLowerCase();
    if (status === "paid" || status === "approved") {
      amountPaid = amount;
      balance    = 0;
      payType    = "Full";
    } else {
      amountPaid = depositFee || 0;
      balance    = amount - amountPaid;
      payType    = "Deposit";
    }
  }

  return { amountPaid, balance, payType };
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

    // Normalize status: Paid → Approved, auto-cancel if booking cancelled
    let status = payment.status || "Pending";
    if (status === "Paid") status = "Approved";
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
  if (status === "Paid") status = "Approved";
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
