import admin from "firebase-admin";

// Remove any literal newlines that may wrap the JSON string (Vercel sometimes adds them)
const raw = process.env.FIREBASE_SERVICE_ACCOUNT.replace(/\r?\n/g, '');

const serviceAccount = JSON.parse(raw);

// Restore actual newlines in the private key (\\n → real newline)
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

export const db = admin.firestore();
