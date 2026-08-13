// Same approach as customer-backend/utils/generateOTP.js, just exported as
// an ES module since admin-backend uses import/export instead of require.
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

export default generateOTP;