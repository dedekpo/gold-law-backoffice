import { readFileSync } from "node:fs";
import path from "node:path";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

/**
 * Server-only Firebase Admin bootstrap. Firestore is the structured database
 * for finished AI runs (GHL custom fields remain the human-facing skim layer).
 *
 * Credentials, in priority order:
 *   1. FIREBASE_SERVICE_ACCOUNT — the full service-account JSON in an env var
 *      (what production should use).
 *   2. ./serviceAccountKey.json at the repo root (local dev fallback; the file
 *      is gitignored).
 */

type ServiceAccountJson = {
  project_id: string;
  client_email: string;
  private_key: string;
};

function loadServiceAccount(): ServiceAccountJson {
  const fromEnv = process.env.FIREBASE_SERVICE_ACCOUNT;
  const raw =
    fromEnv && fromEnv.trim()
      ? fromEnv
      : (() => {
          try {
            return readFileSync(
              path.join(process.cwd(), "serviceAccountKey.json"),
              "utf8",
            );
          } catch {
            throw new Error(
              "Firebase credentials not found. Set FIREBASE_SERVICE_ACCOUNT " +
                "(the service-account JSON) or place serviceAccountKey.json at the repo root.",
            );
          }
        })();
  let parsed: ServiceAccountJson;
  try {
    parsed = JSON.parse(raw) as ServiceAccountJson;
  } catch {
    throw new Error("Firebase service-account credentials are not valid JSON.");
  }
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new Error(
      "Firebase service-account JSON is missing project_id / client_email / private_key.",
    );
  }
  return parsed;
}

let cachedApp: App | null = null;
let cachedDb: Firestore | null = null;

function app(): App {
  if (cachedApp) return cachedApp;
  const existing = getApps()[0];
  if (existing) {
    cachedApp = existing;
    return existing;
  }
  const sa = loadServiceAccount();
  cachedApp = initializeApp({
    credential: cert({
      projectId: sa.project_id,
      clientEmail: sa.client_email,
      privateKey: sa.private_key,
    }),
    storageBucket:
      process.env.FIREBASE_STORAGE_BUCKET ??
      `${sa.project_id}.firebasestorage.app`,
  });
  return cachedApp;
}

/** The shared Firestore instance. Undefined-tolerant: optional fields in our
 * domain types simply don't reach the document. */
export function db(): Firestore {
  if (cachedDb) return cachedDb;
  cachedDb = getFirestore(app());
  // Must be configured before the first operation on this instance.
  cachedDb.settings({ ignoreUndefinedProperties: true });
  return cachedDb;
}
