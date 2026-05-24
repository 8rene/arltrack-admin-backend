export class StaffUser {
  constructor(userID, roleID, status = "active") {
    this.userID = userID;     // Firebase Auth UID
    this.roleID = roleID;     // reference sa roles collection
    this.status = status;     // active | inactive
    this.createdAt = null;    // set later sa Firestore
  }

  // optional: convert to Firestore object
  toFirestore() {
    return {
      userID: this.userID,
      roleID: this.roleID,
      status: this.status,
      createdAt: this.createdAt
    };
  }
}