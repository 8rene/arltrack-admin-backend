import admin from "firebase-admin";

// Replace actual newlines AND escaped newlines in the raw string
const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  .replace(/\n/g, '\\n')   // convert literal newlines to \n
  .replace(/\\n/g, '\\n'); // keep escaped ones as-is

const serviceAccount = JSON.parse(raw);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

export const db = admin.firestore();
