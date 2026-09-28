import {
  previewLateFeeForBooking,
  listPenaltiesForBooking,
  createPenalty as createPenaltyService,
  voidOrWaivePenalty as voidOrWaivePenaltyService,
  recordDepositReceived as recordDepositReceivedService,
  waiveDeposit as waiveDepositService,
  settleBooking as settleBookingService,
  recordShortfallPayment as recordShortfallPaymentService,
  getAllPenalties,
  isBookingAssignedTo,
} from "../../services/penalty/penalty.service.js";
import { ROLES } from "../../utils/roles/role.util.js";

// Reconstructed — this file was found overwritten with a stray copy of
// customer-backend's read-only controller (CommonJS require/module.exports,
// which doesn't even run under this backend's "type": "module"). Rebuilt
// as thin wrappers around penalty.service.js, matching the handler names
// penalty.routes.js already imports. Every service function below returns
// either `{ error }` or a plain data object — never throws for expected
// failures — so each wrapper checks `.error` first and only falls into
// the catch block for unexpected exceptions.
//
// getDraftQueue / postDraftPenalty (edit) / postConfirmPenalty are gone
// along with the Draft step itself — creating a penalty now confirms it
// in the same call (see postCreatePenalty), so there's no queue to list
// and nothing left in a state that could be edited or separately
// confirmed.

const actorId = (req) => req.user?.userID || req.user?.uid || null;

// A Driver may only touch penalties on a booking assigned to them — create,
// see the late-fee suggestion, or list. Owner/Admin/Supervisor are unchecked.
// (The driver-dispatch routes check this per trip already; this is the same
// rule for the general /api/penalties routes a driver can also reach.)
// Sends the 403 itself and returns false so the handler can just `return`.
const driverMayUse = async (req, res, bookingID) => {
  if (req.user?.role !== ROLES.DRIVER) return true;
  if (await isBookingAssignedTo(bookingID, actorId(req))) return true;
  res.status(403).json({ success: false, message: "This booking is not assigned to you." });
  return false;
};

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
    if (!(await driverMayUse(req, res, bookingID))) return;
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
    if (!(await driverMayUse(req, res, bookingID))) return;
    const data = await listPenaltiesForBooking(bookingID);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[PENALTY] booking list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const postCreatePenalty = async (req, res) => {
  try {
    if (!(await driverMayUse(req, res, req.body?.bookingID))) return;
    const result = await createPenaltyService({ ...req.body, createdBy: actorId(req) });
    if (result.error) return res.status(400).json({ success: false, message: result.error });
    return res.status(201).json({ success: true, data: result });
  } catch (error) {
    console.error("[PENALTY] create error:", error);
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