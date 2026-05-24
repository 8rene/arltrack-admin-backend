import admin from "firebase-admin";

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
const serviceAccount = JSON.parse(raw);

// Fix private key newlines if corrupted
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

export const db = admin.firestore();
