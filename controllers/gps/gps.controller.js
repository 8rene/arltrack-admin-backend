import { saveLocation, getLocation, getAllLocations } from "../../services/gps/gps.service.js";

/** POST /api/gps  — GPS device pushes a live location */
export const receiveLocation = async (req, res) => {
  const { device_id, lat, lng } = req.body;
  if (!device_id || lat == null || lng == null) {
    return res.status(400).json({ status: "error", message: "device_id, lat, lng required." });
  }
  const data = await saveLocation(device_id, lat, lng);
  console.log(`[GPS] ${device_id} → ${lat}, ${lng}`);
  return res.json({ status: "ok", data });
};

/** GET /api/gps/:id  — Frontend reads one device */
export const getDeviceLocation = (req, res) => {
  const data = getLocation(req.params.id);
  return res.json(data || {});
};

/** GET /api/gps  — Frontend reads ALL devices that have a stored location */
export const getAllDeviceLocations = (req, res) => {
  return res.json({ status: "ok", data: getAllLocations() });
};
