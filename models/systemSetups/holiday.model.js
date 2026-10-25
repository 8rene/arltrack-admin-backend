// holidays/{holidayID}
// Written by services/holidays/holidays.service.js. Read by the coding (number coding) check in services/gps/coding.service.js.
export const Holiday = {
  holidayID: "",       // same as the Firestore doc ID, written in the same operation
  holidayName: "",
  holidayDate: null,   // Firestore Timestamp built from a YYYY-MM-DD date
  holidayDay: "",      // weekday name worked out from the date, e.g. "Monday"; rewritten whenever the date changes
  createdAt: null,     // set on create only; edits do not write updatedAt
};
