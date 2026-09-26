import {
  previewLateFeeForBooking,
  createDraftPenalty,
  updateDraftPenalty,
  listPenaltiesForBooking,
  listDraftQueue,
  confirmPenalty,
  voidOrWaivePenalty,
  recordDepositReceived,
  waiveDeposit,
  settleBooking,
  recordShortfallPayment,
} from "../../services/penalty/penalty.service.js";

const send = (res, result, successStatus = 200) => {
  if (result?.error) return res.status(400).json({ message: result.error });
  return res.status(successStatus).json({ data: result });
};

export const getLateFeePreview = async (req, res) => {
  const result = await previewLateFeeForBooking(req.params.bookingID);
  if (!result) return res.status(404).json({ message: "Booking not found." });
  return res.status(200).json({ data: result });
};

export const getBookingPenalties = async (req, res) => {
  const data = await listPenaltiesForBooking(req.params.bookingID);
  return res.status(200).json({ data });
};

export const getDraftQueue = async (_req, res) => {
  const data = await listDraftQueue();
  return res.status(200).json({ data });
};

export const postDraftPenalty = async (req, res) => {
  const result = await createDraftPenalty({ ...req.body, createdBy: req.user.uid });
  return send(res, result, 201);
};

export const patchDraftPenalty = async (req, res) => {
  const result = await updateDraftPenalty(req.params.penaltyID, req.body, req.user.uid);
  return send(res, result);
};

export const postConfirmPenalty = async (req, res) => {
  const result = await confirmPenalty(req.params.penaltyID, req.user.uid);
  return send(res, result);
};

export const patchVoidOrWaivePenalty = async (req, res) => {
  const { status, statusReason } = req.body;
  const result = await voidOrWaivePenalty(req.params.penaltyID, status, statusReason, req.user.uid);
  return send(res, result);
};

export const postDepositReceived = async (req, res) => {
  const { paymentID, method, referenceNumber } = req.body;
  const result = await recordDepositReceived({ paymentID, method, referenceNumber, by: req.user.uid });
  return send(res, result, 201);
};

export const postWaiveDeposit = async (req, res) => {
  const { paymentID, reason } = req.body;
  const result = await waiveDeposit({ paymentID, reason, by: req.user.uid });
  return send(res, result);
};

export const postSettleBooking = async (req, res) => {
  const { bookingID } = req.params;
  const { returnMethod, returnReferenceNumber } = req.body;
  const result = await settleBooking({ bookingID, actorUid: req.user.uid, returnMethod, returnReferenceNumber });
  return send(res, result);
};

export const postShortfallPayment = async (req, res) => {
  const { userID, amount, method, referenceNumber } = req.body;
  const result = await recordShortfallPayment({ userID, amount, method, referenceNumber, performedBy: req.user.uid });
  return send(res, result, 201);
};