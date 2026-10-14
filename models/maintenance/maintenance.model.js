// maintenance/{id}
//
// BASIS_OPTIONS and STATUS_OPTIONS match Maintenance.jsx's FALLBACK_BASIS /
// FALLBACK_STATUSES exactly — those fallbacks only render before
// GET /api/maintenance/config loads, so this file is the real source of
// truth and must stay word-for-word identical to those fallback arrays or
// a record saved with one label won't match the UI's filter/display logic
// for the other.
//
// bookingID (new): optional FK -> bookings, null for routine maintenance
// that isn't tied to a specific rental. Set manually, via the
// "+ Post-Rental Maintenance" button on a booking's detail view
// (Bookings.jsx's goToMaintenance), which deep-links to
// /maintenance?carID=&bookingID= and pre-fills the create form
// (Maintenance.jsx) to that car and booking, basis defaulted to
// "Post-Rental". Nothing creates these records automatically.
// See services/maintenance/maintenance.service.js's createMaintenance
// (write side) and listMaintenanceForBooking (read side — powers the
// "linked maintenance" list on a booking's detail view). This is also
// what a penalty's optional maintenanceID field points back at, so a
// customer-caused charge and its actual repair cost stay traceable to
// each other without being merged into one number.

// ─────────────────────────────────────────────
// maintenance collection schema
// ─────────────────────────────────────────────
// Documents the shape of one maintenance/{id} document (nothing reads this
// object at runtime — maintenance.service.js is what actually writes it, the
// same way models/inventory and models/pricingSettings work). The archive
// copy of a booking-linked record (models/archives/maintenanceArchives.model.js)
// has these same columns plus its own bookkeeping — keep the two in step.
//
// There is deliberately NO "next maintenance date" column. A job is just one
// dated piece of work; "when is the next one" is decided by scheduling a new
// maintenance record, not stored on the old one. (Older documents may still
// carry a leftover nextMaintenanceDate — nothing reads or writes it any more.)
export const Maintenance = {
  maintenanceID: "",       // Firestore doc ID (createMaintenance mirrors the id onto the doc itself)
  carID: "",               // FK -> cars
  bookingID: null,         // FK -> bookings. Set for post-rental jobs created from a booking; null for routine maintenance
  basis: "",               // one of BASIS_OPTIONS
  services: [],            // [{ serviceID, serviceName, price }] — from SERVICE_CATALOG, or serviceID "other" with a typed serviceName
  totalCost: 0,            // the effective total: sum of services[].price + sum of partsAddressed[].price, OR overrideTotal when one is set
  overrideTotal: null,     // number | null — manual total that replaces the computed sum (totalCost then equals this)
  description: "",         // free-text notes
  maintenanceDate: null,   // Timestamp — when the work is/was scheduled
  status: "Scheduled",     // one of STATUS_OPTIONS
  partsAddressed: [],      // [PartAddressed] — the car parts this job handles (see the PartAddressed shape below)
  createdAt: null,         // Timestamp — when the record was created
  updatedAt: null,         // Timestamp — when the record was last changed
};

// ─────────────────────────────────────────────
// partsAddressed[] entry — one per car part this job handles
// ─────────────────────────────────────────────
// Deliberately small. The part's name, type and serial number are NOT copied
// here — carPartID points at carParts, so they are looked up from there (a
// rename shows up everywhere; a part that was later removed from Inventory
// just reads as "Removed part", its price/conditions/description still stand).
//
// Nothing here points at an inspection record (no bookingID / tripPhase).
// The before/after-trip inspection records are history and are never edited by
// maintenance. This entry is the maintenance side of the story instead:
// what condition the part was in when the job was set up, and what it was
// turned into by the job.
//
// Older records may still carry carID / carPartName / tripPhase / bookingID on
// these entries — nothing reads them any more, and they are not required.
export const PartAddressed = {
  carPartID: "",           // FK -> carParts (must belong to this job's carID)
  conditionBefore: "",     // one of PART_CONDITION_BEFORE — the part's condition when the job was set up (from the car's
                           //   latest inspection; "Good" when it isn't listed there or a Completed job already fixed it).
                           //   null on older entries that predate this field
  conditionAfter: null,    // one of PART_CONDITION_AFTER | null — the part's condition once the job is done.
                           //   Completing a job with none chosen defaults it to "Good". The car part's own status
                           //   (carParts.status) is then RECOMPUTED, not copied from this: a part a Completed job leaves
                           //   "Damaged" stays flagged. The inspection records are never changed
  description: "",         // what was done to THIS part, e.g. "replaced with new OEM unit" (the job-level description is for general notes)
  price: 0,                // number >= 0 — this job's price for the part. Starts at the catalog price (carPartPricing)
                           //   but is a snapshot: editing it here never changes the catalog price
};

// Condition the part was in before the job. Same labels the inspection
// records use ("New" is never listed there, so it isn't an option here).
export const PART_CONDITION_BEFORE = ["Good", "Damaged", "Stolen", "Missing"];

// Condition after the job. How it was fixed (repaired / replaced...) goes in
// the part's description, not in a separate status. "Damaged" means the job
// was completed but the part is still not right, so it stays flagged.
export const PART_CONDITION_AFTER = ["Good", "Damaged"];

export const BASIS_OPTIONS = [
  "Post-Rental",
  "Monthly",
  "Mileage-based",
  "Annual",
  "Repair/Unplanned",
];

export const STATUS_OPTIONS = [
  "Scheduled",
  "Completed",
  "Cancelled",
];
// "In Progress" and "Overdue" were removed — neither was ever set by any
// automated process (both were purely manual picks), nothing downstream
// depended on "In Progress" being accurate (car availability is tracked
// entirely separately, on the car's own record via Fleet.jsx), and
// "Overdue" was actively counterproductive: picking it manually removed
// the record from the Dashboard's date-based Warning query instead of
// escalating it. Overdue detection is now purely computed from
// maintenanceDate vs. now on a still-"Scheduled" record (see Dashboard.jsx
// and the maintenance_overdue cron check) — no status flag required.

// PLACEHOLDER catalog — services/prices here are starter values, not real
// pricing. Adjust freely; maintenance.service.js only needs each service's
// serviceID to stay stable once records reference it (renaming an ID after
// records exist will orphan those records' service names).
export const SERVICE_CATALOG = [
  {
    group: "Engine & Fluids",
    services: [
      { serviceID: "oil_change",        serviceName: "Engine Oil Change",        price: 1500 },
      { serviceID: "oil_filter",        serviceName: "Oil Filter Replacement",   price: 400 },
      { serviceID: "coolant_flush",     serviceName: "Coolant Flush",            price: 1200 },
      { serviceID: "air_filter",        serviceName: "Air Filter Replacement",   price: 600 },
    ],
  },
  {
    group: "Tires & Brakes",
    services: [
      { serviceID: "tire_rotation",     serviceName: "Tire Rotation",            price: 500 },
      { serviceID: "tire_replacement",  serviceName: "Tire Replacement (set)",   price: 8000 },
      { serviceID: "brake_pads",        serviceName: "Brake Pad Replacement",    price: 2500 },
      { serviceID: "wheel_alignment",   serviceName: "Wheel Alignment",          price: 800 },
    ],
  },
  {
    group: "Electrical & Battery",
    services: [
      { serviceID: "battery_replace",   serviceName: "Battery Replacement",      price: 4500 },
      { serviceID: "battery_check",     serviceName: "Battery/Electrical Check", price: 300 },
      { serviceID: "ac_service",        serviceName: "Aircon Service",           price: 1800 },
    ],
  },
  {
    group: "GPS & Tracking",
    services: [
      { serviceID: "sim_load",          serviceName: "SIM Load",                 price: 300 },
    ],
  },
  {
    group: "Body & Interior",
    services: [
      { serviceID: "car_wash",          serviceName: "Full Car Wash/Detailing",  price: 800 },
      { serviceID: "dent_repair",       serviceName: "Minor Dent/Scratch Repair",price: 3000 },
      { serviceID: "interior_cleaning", serviceName: "Interior Deep Cleaning",   price: 1200 },
    ],
  },
  {
    group: "Inspection & Safety",
    services: [
      { serviceID: "general_inspection",serviceName: "General Safety Inspection",price: 500 },
      { serviceID: "emission_test",     serviceName: "Emission Test",            price: 700 },
    ],
  },
];