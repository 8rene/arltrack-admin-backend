// One place that knows how a payment stores its security deposit.
//
// NEW (flat) shape on payments/{paymentID}:
//   securityDeposit      the deposit amount charged with the first payment (already existed)
//   depositStatus        "Held" | "Waived" | "Settled" | "Forfeited" | "Refunded"
//   depositSettled       pesos of penalties settled against the deposit (Settled only). Every confirmed penalty owed,
//                        so it can be MORE than the deposit: that is how "OwedByCustomer" differs from "Settled".
//   depositReturned      pesos handed back to the customer (Settled only) = the _depositreturn row's amount
//   depositSettledAt     when the deposit stopped being Held (settled, waived, forfeited or refunded)
// Net, the amount deducted and the result (Refunded / Settled / OwedByCustomer) are derived. How it was returned,
// the reference, who and when are the "<paymentID>_depositreturn" out-row in paymentEntries; who settled is the
// DepositReturn transaction log.
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
  const penaltyTotal = status === "Settled" ? num(p.depositSettled) : 0;
  let settlement = null;
  if (status === "Settled") {
    const net = amount - penaltyTotal;
    settlement = {
      status: settlementStatusFor(net), net, confirmedPenaltyTotal: penaltyTotal,
      settledBy: null, settledAt: p.depositSettledAt ?? null,
    };
  } else if (status === "Waived") {
    settlement = {
      status: "Waived", net: 0, confirmedPenaltyTotal: 0,
      settledBy: null, settledAt: p.depositSettledAt ?? null,
    };
  }
  const net = settlement ? settlement.net : null;
  return {
    shape: "flat",
    amount,
    status,
    waivedReason: "",
    penaltyTotal,
    settlement,
    settled: !!settlement,
    net,
    deducted: status === "Settled" ? Math.min(amount, penaltyTotal) : 0,   // penalties actually taken from the deposit
    returnedAmount: status === "Settled" ? num(p.depositReturned) : 0,
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
