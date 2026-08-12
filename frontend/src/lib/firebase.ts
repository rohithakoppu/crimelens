import { initializeApp, type FirebaseOptions } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
} from "firebase/auth";

const config: FirebaseOptions = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
};

export const firebaseConfigured = Boolean(config.apiKey && config.projectId);

// Only initialize when configured -- an unconfigured app must fail with a
// clear "Google Sign-In is not configured" message, not a cryptic SDK crash.
const app = firebaseConfigured ? initializeApp(config) : null;
export const firebaseAuth = app ? getAuth(app) : null;

export class FirebaseNotConfiguredError extends Error {
  constructor() {
    super("Firebase web config is missing (VITE_FIREBASE_* env vars). Google Sign-In is not available.");
    this.name = "FirebaseNotConfiguredError";
  }
}

export async function signInWithGoogle(): Promise<string> {
  if (!firebaseAuth) throw new FirebaseNotConfiguredError();
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(firebaseAuth, provider);
  return result.user.getIdToken();
}

export async function signInWithEmailPassword(email: string, password: string): Promise<string> {
  if (!firebaseAuth) throw new FirebaseNotConfiguredError();
  const result = await signInWithEmailAndPassword(firebaseAuth, email, password);
  return result.user.getIdToken();
}

export async function firebaseSignOut(): Promise<void> {
  if (firebaseAuth) await fbSignOut(firebaseAuth);
}
