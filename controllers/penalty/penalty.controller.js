import {
  previewLateFeeForBooking,
  listPenaltiesForBooking,
  listDraftQueue,
  createDraftPenalty as createDraftPenaltyService,
  updateDraftPenalty as updateDraftPenaltyService,
  confirmPenalty as confirmPenaltyService,
  voidOrWaivePenalty as voidOrWaivePenaltyService,
  recordDepositReceived as recordDepositReceivedService,
  waiveDeposit as waiveDepositService,
  settleBooking as settleBookingService,
  recordShortfallPayment as recordShortfallPaymentService,
  getAllPenalties,
} from "../../services/penalty/penalty.service.js";

// Reconstructed — this file was found overwritten with a stray copy of
// customer-backend's read-only controller (CommonJS require/module.exports,
// which doesn't even run under this backend's "type": "module"). Rebuilt
// as thin wrappers around penalty.service.js, matching the handler names
// penalty.routes.js already imports. Every service function below returns
// either `{ error }` or a plain data object — never throws for expected
// failures — so each wrapper checks `.error` first and only falls into
// the catch block for unexpected exceptions.

const actorId = (req) => req.user?.userID || req.user?.uid || null;

export const getAllPenaltiesHandler = async (req, res) => {
  try {
    const data = await getAllPenalties();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[PENALTY] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getLateFeePreview = async (req, res) => {
  try {
    const { bookingID } = req.params;
    const data = await previewLateFeeForBooking(bookingID);
    if (!data) return res.status(404).json({ success: false, message: "Booking not found." });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[PENALTY] late fee preview error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getBookingPenalties = async (req, res) => {
  try {
    const { bookingID } = req.params;
    const data = await listPenaltiesForBooking(bookingID);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[PENALTY] booking list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getDraftQueue = async (req, res) => {
  try {
    const data = await listDraftQueue();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[PENALTY] draft queue error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const postDraftPenalty = async (req, res) => {
  try {
    const result = await createDraftPenaltyService({ ...req.body, createdBy: actorId(req) });
    if (result.error) return res.status(400).json({ success: false, message: result.error });
    return res.status(201).json({ success: true, data: result });
  } catch (error) {
    console.error("[PENALTY] create draft error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const patchDraftPenalty = async (req, res) => {
  try {
    const { penaltyID } = req.params;
    const result = await updateDraftPenaltyService(penaltyID, req.body, actorId(req));
    if (result.error) return res.status(400).json({ success: false, message: result.error });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[PENALTY] update draft error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const postConfirmPenalty = async (req, res) => {
  try {
    const { penaltyID } = req.params;
    const result = await confirmPenaltyService(penaltyID, actorId(req));
    if (result.error) return res.status(400).json({ success: false, message: result.error });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[PENALTY] confirm error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const patchVoidOrWaivePenalty = async (req, res) => {
  try {
    const { penaltyID } = req.params;
    const { status, statusReason } = req.body;
    const result = await voidOrWaivePenaltyService(penaltyID, status, statusReason, actorId(req));
    if (result.error) return res.status(400).json({ success: false, message: result.error });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[PENALTY] void/waive error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const postDepositReceived = async (req, res) => {
  try {
    const result = await recordDepositReceivedService({ ...req.body, by: actorId(req) });
    if (result.error) return res.status(400).json({ success: false, message: result.error });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[PENALTY] deposit received error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const postWaiveDeposit = async (req, res) => {
  try {
    const result = await waiveDepositService({ ...req.body, by: actorId(req) });
    if (result.error) return res.status(400).json({ success: false, message: result.error });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[PENALTY] waive deposit error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const postSettleBooking = async (req, res) => {
  try {
    const { bookingID } = req.params;
    const result = await settleBookingService({ ...req.body, bookingID, actorUid: actorId(req) });
    if (result.error) return res.status(400).json({ success: false, message: result.error });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[PENALTY] settle booking error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const postShortfallPayment = async (req, res) => {
  try {
    const result = await recordShortfallPaymentService({ ...req.body, performedBy: actorId(req) });
    if (result.error) return res.status(400).json({ success: false, message: result.error });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[PENALTY] shortfall payment error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};