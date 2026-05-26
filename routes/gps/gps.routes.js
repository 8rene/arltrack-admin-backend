import {
  receiveLocation,
  getDeviceLocation,
  getAllDeviceLocations,
  getAllGpsDevices,
  addGpsDevice,
  updateGpsDevice,
} from "../../controllers/gps/gps.controller.js";

export const registerGpsRoutes = (app) => {
  // GPS device pushes location (no auth — device uses device_id as key)
  app.post("/api/gps", receiveLocation);

  // GPS device management
  app.get("/api/gps/devices",      getAllGpsDevices);
  app.post("/api/gps/devices",     addGpsDevice);
  app.put("/api/gps/devices/:id",  updateGpsDevice);

  // Frontend reads locations — MUST be after /devices routes
  app.get("/api/gps",      getAllDeviceLocations);
  app.get("/api/gps/:id",  getDeviceLocation);
};
