import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export const DATABASE_NAME = 'applyr-local';
export const DATABASE_VERSION = 5;
export interface ApplyrDatabase extends DBSchema {
  // Unknown on disk: every read must cross the runtime schema boundary.
  checkpoints: { key: string; value: unknown };
  profiles: { key: string; value: unknown };
  documents: { key: string; value: unknown };
  documentBlobs: { key: string; value: unknown };
  documentLinks: { key: string; value: unknown };
  providerSettings: { key: string; value: unknown };
  providerCredentials: { key: string; value: unknown };
  history: { key: string; value: unknown };
}

export function openDatabase(name = DATABASE_NAME): Promise<IDBPDatabase<ApplyrDatabase>> {
  const connection = openDB<ApplyrDatabase>(name, DATABASE_VERSION, {
    upgrade(database, oldVersion) {
      // Append migrations here; never silently change a store or persisted record schema.
      if (oldVersion < 1) database.createObjectStore('checkpoints');
      if (oldVersion < 2) database.createObjectStore('profiles');
      if (oldVersion < 3) {
        database.createObjectStore('documents');
        database.createObjectStore('documentBlobs');
        database.createObjectStore('documentLinks');
      }
      if (oldVersion < 4) {
        database.createObjectStore('providerSettings');
        database.createObjectStore('providerCredentials');
      }
      if (oldVersion < 5) database.createObjectStore('history');
    },
    blocking() { void connection.then((database) => database.close()); },
    terminated() { databasePromise = undefined; },
  });
  return connection;
}

let databasePromise: Promise<IDBPDatabase<ApplyrDatabase>> | undefined;
export function getDatabase() {
  databasePromise ??= openDatabase().catch((error: unknown) => { databasePromise = undefined; throw error; });
  return databasePromise;
}
