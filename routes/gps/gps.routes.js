import {
  receiveLocation,
  getDeviceLocation,
  getAllDeviceLocations,
} from "../../controllers/gps/gps.controller.js";

export const registerGpsRoutes = (app) => {
  // GPS device pushes location (no auth — device uses device_id as key)
  app.post("/api/gps", receiveLocation);

  // Frontend reads locations
  app.get("/api/gps",      getAllDeviceLocations);
  app.get("/api/gps/:id",  getDeviceLocation);
};
