import admin from "firebase-admin";
import { db } from "../../config/firebaseConnection/firebase.js";
import { makeItemDelete } from "./itemDelete.core.js";
import { deleteBookingWithCascade, previewBookingDelete } from "./bookingDelete.service.js";

export const { previewItemDelete, deleteItem } = makeItemDelete({
  db,
  FieldValue: admin.firestore.FieldValue,
  previewBooking: previewBookingDelete,
  deleteBooking: deleteBookingWithCascade,
});