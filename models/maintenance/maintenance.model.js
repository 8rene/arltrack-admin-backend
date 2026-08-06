// carMaintenance/{id}
//
// BASIS_OPTIONS and STATUS_OPTIONS match Maintenance.jsx's FALLBACK_BASIS /
// FALLBACK_STATUSES exactly — those fallbacks only render before
// GET /api/maintenance/config loads, so this file is the real source of
// truth and must stay word-for-word identical to those fallback arrays or
// a record saved with one label won't match the UI's filter/display logic
// for the other.

export const BASIS_OPTIONS = [
  "Post-Rental",
  "Monthly",
  "Mileage-based",
  "Annual",
  "Repair/Unplanned",
];

export const STATUS_OPTIONS = [
  "Scheduled",
  "In Progress",
  "Completed",
  "Cancelled",
  "Overdue",
];

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