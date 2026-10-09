// One place that knows how a payment stores its security deposit.
//
// NEW (flat) shape on payments/{paymentID}:
//   securityDeposit      the deposit amount charged with the first payment (already existed)
//   depositStatus        "Held" | "Waived" | "Settled" | "Forfeited" | "Refunded"
//   depositWaivedReason  why it was waived (Waived only)
//   depositPenaltyTotal  every confirmed penalty owed at settlement (Settled only). It can be MORE than the
//                        deposit; that is how "OwedByCustomer" is told apart from "Settled".
//   depositSettledAt / depositSettledBy   when / who closed the deposit
// The money that left at settlement is the "<paymentID>_depositreturn" out-row in paymentEntries
// (method, reference, who, when, amount). Nothing about it is stored on the payment.
//
// OLD (nested) shape, still read until scripts/migrate-deposit-flat.js has run:
//   payments.deposit = { amount, status, waivedReason, received, returned, settlement }
//
// getDepositView() returns the same shape for both, so no reader needs to know which one it is looking at.
// It has no imports, so it can be copied to another repo unchanged.

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const has = (v) => v !== undefined && v !== null && v !== "";

export const DEPOSIT_STATUSES = ["Held", "Waived", "Settled", "Forfeited", "Refunded"];

/** Settlement result for a net amount (deposit - penalties): money back, exact, or still owed. */
export const settlementStatusFor = (net) => (net > 0 ? "Refunded" : net === 0 ? "Settled" : "OwedByCustomer");

const fromFlat = (p) => {
  const status = String(p.depositStatus);
  const amount = status === "Waived" ? 0 : (num(p.securityDeposit) || num(p.depositFee));
  const penaltyTotal = status === "Settled" ? num(p.depositPenaltyTotal) : 0;
  let settlement = null;
  if (status === "Settled") {
    const net = amount - penaltyTotal;
    settlement = {
      status: settlementStatusFor(net), net, confirmedPenaltyTotal: penaltyTotal,
      settledBy: p.depositSettledBy ?? null, settledAt: p.depositSettledAt ?? null,
    };
  } else if (status === "Waived") {
    settlement = {
      status: "Waived", net: 0, confirmedPenaltyTotal: 0,
      settledBy: p.depositSettledBy ?? null, settledAt: p.depositSettledAt ?? null,
    };
  }
  const net = settlement ? settlement.net : null;
  return {
    shape: "flat",
    amount,
    status,
    waivedReason: p.depositWaivedReason || "",
    penaltyTotal,
    settlement,
    settled: !!settlement,
    net,
    deducted: status === "Settled" ? Math.min(amount, penaltyTotal) : 0,   // penalties actually taken from the deposit
    returnedAmount: status === "Settled" ? Math.max(0, net) : 0,           // equals the _depositreturn row's amount
    settledAt: p.depositSettledAt ?? null,
  };
};

const fromNested = (d) => {
  const s = d.settlement && d.settlement.status ? d.settlement : null;
  const amount = num(d.amount);
  const net = s ? num(s.net) : null;
  return {
    shape: "nested",
    amount,
    status: d.status || "",
    waivedReason: d.waivedReason || "",
    penaltyTotal: s ? num(s.confirmedPenaltyTotal) : 0,
    settlement: s,
    settled: !!s,
    net,
    deducted: s ? amount - Math.max(0, net) : 0,
    returnedAmount: num(d.returned && d.returned.amount),
    settledAt: s ? (s.settledAt ?? null) : null,
  };
};

/** The payment's security deposit, or null if none was ever recorded. */
export const getDepositView = (payment) => {
  const p = payment || {};
  if (has(p.depositStatus)) return fromFlat(p);
  if (p.deposit && typeof p.deposit === "object") return fromNested(p.deposit);
  return null;
};
