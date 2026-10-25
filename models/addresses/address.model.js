// regions, provinces, municipalities, barangays -- the address lists, four collections linked top-down
// Written by services/addresses/addresses.service.js. Every document stores its own ID in its own ...ID field, written in the
// same operation as the document. The parent field must point to a document that exists.

// regions/{regionID}
export const Region = {
  regionID: "",
  regionName: "",
};

// provinces/{provinceID}
export const Province = {
  provinceID: "",
  provinceName: "",
  regionID: "",         // parent: regions/{regionID}
};

// municipalities/{municipalityID}
export const Municipality = {
  municipalityID: "",
  municipalityName: "",
  provinceID: "",       // parent: provinces/{provinceID}
};

// barangays/{barangayID}
export const Barangay = {
  barangayID: "",
  barangayName: "",
  municipalityID: "",   // parent: municipalities/{municipalityID}
};
