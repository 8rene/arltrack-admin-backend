/**
 * reviews.service.js
 *
 * Live (non-archived) customer reviews, for the admin "Reviews" page.
 * Reviews are created by customers via the customer-backend
 * (controllers/reviews/reviews.controller.js) — this service only reads
 * them and handles admin-side deletion (which archives, not hard-deletes,
 * matching every other admin delete flow in this app).
 */

import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

const toISO = (val) => {
  if (!val) return null;
  if (val.toDate) return val.toDate().toISOString();
  if (val._seconds) return new Date(val._seconds * 1000).toISOString();
  return val;
};

/**
 * Returns every live review for one car, enriched with the reviewer's
 * display name. Used by the admin Reviews page, which fetches cars
 * directly (like Inventory.jsx) and only loads a car's reviews once it's
 * selected — avoids reading the entire reviews/user collections up front.
 */
export const getReviewsForCar = async (carID) => {
  const reviewsSnap = await db.collection("reviews").where("carID", "==", carID).get();
  if (reviewsSnap.empty) return [];

  const userIDs = [...new Set(reviewsSnap.docs.map((d) => d.data().userID).filter(Boolean))];
  const userDocs = await Promise.all(userIDs.map((uid) => db.collection("user").doc(uid).get()));
  const userMap = Object.fromEntries(
    userDocs.filter((d) => d.exists).map((d) => [d.id, d.data().username || d.data().email || d.id])
  );

  const reviews = reviewsSnap.docs.map((doc) => {
    const r = doc.data();
    return {
      reviewID: r.reviewID || doc.id,
      userID: r.userID || "",
      reviewerName: userMap[r.userID] || "Unknown user",
      bookingID: r.bookingID || "",
      rating: Number(r.rating) || 0,
      comment: r.comment || "",
      createdAt: toISO(r.createdAt),
      updatedAt: toISO(r.updatedAt),
    };
  });

  reviews.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return reviews;
};

/**
 * Returns every live review, each enriched with the car's label
 * (brand + model) and the reviewer's display name, grouped by carID.
 * Shape: [{ carID, carLabel, plateNumber, reviews: [...] }, ...]
 * Cars with zero reviews are omitted — the frontend already has the
 * full car list (same Firestore read Inventory.jsx does) to show as
 * pickable cards regardless of review count.
 */
export const getAllReviewsGroupedByCar = async () => {
  const [reviewsSnap, carsSnap, brandsSnap, modelsSnap, usersSnap] = await Promise.all([
    db.collection("reviews").get(),
    db.collection("cars").get(),
    db.collection("brand").get(),
    db.collection("model").get(),
    db.collection("user").get(), // collection is singular "user" — see user.controller.js
  ]);

  const modelMap = Object.fromEntries(modelsSnap.docs.map((d) => [d.id, d.data()]));
  const brandMap = Object.fromEntries(brandsSnap.docs.map((d) => [d.id, d.data()]));
  const carMap = Object.fromEntries(
    carsSnap.docs.map((d) => {
      const c = d.data();
      const model = modelMap[c.modelID] || {};
      const brand = brandMap[model.brandID] || {};
      return [
        d.id,
        {
          carLabel: `${brand.brandName || ""} ${model.modelName || ""}`.trim() || d.id,
          plateNumber: c.plateNumber || c.platenumber || "",
        },
      ];
    })
  );
  const userMap = Object.fromEntries(
    usersSnap.docs.map((d) => [d.id, d.data().username || d.data().email || d.id])
  );

  const byCar = {};
  reviewsSnap.docs.forEach((doc) => {
    const r = doc.data();
    const carID = r.carID || "unknown";
    if (!byCar[carID]) {
      byCar[carID] = {
        carID,
        carLabel: carMap[carID]?.carLabel || "Unknown vehicle",
        plateNumber: carMap[carID]?.plateNumber || "",
        reviews: [],
      };
    }
    byCar[carID].reviews.push({
      reviewID: r.reviewID || doc.id,
      userID: r.userID || "",
      reviewerName: userMap[r.userID] || "Unknown user",
      bookingID: r.bookingID || "",
      rating: Number(r.rating) || 0,
      comment: r.comment || "",
      createdAt: toISO(r.createdAt),
      updatedAt: toISO(r.updatedAt),
    });
  });

  Object.values(byCar).forEach((group) => {
    group.reviews.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  });

  return Object.values(byCar).sort((a, b) => b.reviews.length - a.reviews.length);
};

/**
 * Deletes a live review by archiving it first (same doc shape used by
 * bookingDelete.service.js's archiveReview, so it shows up correctly on
 * the existing Reviews Archive page and can be restored from there),
 * then removing the live doc.
 */
export const archiveAndDeleteReview = async (reviewDocID, deletedBy = "admin") => {
  const reviewRef = db.collection("reviews").doc(reviewDocID);
  const reviewDoc = await reviewRef.get();
  if (!reviewDoc.exists) throw new Error("Review not found.");
  const reviewData = reviewDoc.data();

  const archiveRef = db.collection("reviewsArchives").doc();
  await archiveRef.set({
    reviewsArchivesID: archiveRef.id,
    reviewID: reviewData.reviewID ?? reviewDocID,
    originalId: reviewDocID,
    archiveDate: admin.firestore.FieldValue.serverTimestamp(),
    archivedAt: admin.firestore.FieldValue.serverTimestamp(),
    archivedBy: deletedBy,
    ...reviewData,
  });

  await reviewRef.delete();
  console.log(`[REVIEWS] ${reviewDocID} archived → reviewsArchives/${archiveRef.id} and removed from live reviews.`);
  return archiveRef.id;
};