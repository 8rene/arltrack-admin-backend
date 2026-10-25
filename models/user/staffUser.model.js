export class StaffUser {
  // Mirrors what syncStaffUser() in controllers/user/user.controller.js
  // actually writes — that function builds plain objects directly rather
  // than instantiating this class, so this is documentation of the shape,
  // not enforcement of it. Keep the two in sync by hand.
  constructor(userID, email, staffUserID) {
    this.userID = userID;           // Firebase Auth UID — links back to the `user` collection doc
    this.email = email;             // what auth.controller.js's login query matches on
    this.staffUserID = staffUserID; // this doc's own Firestore ID, self-referenced
    this.createdAt = null;          // set later sa Firestore
    // status intentionally NOT stored here anymore — login enforcement now
    // reads status off the `user` collection doc instead (see
    // auth.controller.js). staffUser is a pure email→userID lookup table.
    // roleID intentionally NOT stored here — nothing in the backend ever
    // reads staffUser.roleID; the actual permission check reads roleID off
    // the separate `user` collection doc instead (see auth.controller.js).
  }

  // optional: convert to Firestore object
  toFirestore() {
    return {
      userID: this.userID,
      email: this.email,
      staffUserID: this.staffUserID,
      createdAt: this.createdAt
    };
  }
}