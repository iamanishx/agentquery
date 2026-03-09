import { openDB, type DBSchema } from "idb";
import type { ChatMessage, ChatSession, DatabaseCredential } from "@/lib/types";

interface AppDB extends DBSchema {
  databases: {
    key: string;
    value: DatabaseCredential;
  };
  sessions: {
    key: string;
    value: ChatSession;
    indexes: { "by-db": string; "by-updated": number };
  };
  messages: {
    key: string;
    value: ChatMessage;
    indexes: { "by-session": string };
  };
  settings: {
    key: string;
    value: { key: string; value: string };
  };
}

const DB_NAME = "agentquery";
const DB_VERSION = 2;

function getDb() {
  return openDB<AppDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("databases")) {
        db.createObjectStore("databases", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("sessions")) {
        const sessions = db.createObjectStore("sessions", { keyPath: "id" });
        sessions.createIndex("by-db", "dbId");
        sessions.createIndex("by-updated", "updatedAt");
      }
      if (!db.objectStoreNames.contains("messages")) {
        const messages = db.createObjectStore("messages", { keyPath: "id" });
        messages.createIndex("by-session", "sessionId");
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    },
  });
}

export async function listDatabases() {
  const db = await getDb();
  return db.getAll("databases");
}

export async function upsertDatabase(entry: DatabaseCredential) {
  const db = await getDb();
  await db.put("databases", entry);
}

export async function removeDatabase(id: string) {
  const db = await getDb();
  const sessions = await db.getAllFromIndex("sessions", "by-db", id);
  for (const session of sessions) {
    const messages = await db.getAllFromIndex("messages", "by-session", session.id);
    for (const message of messages) {
      await db.delete("messages", message.id);
    }
    await db.delete("sessions", session.id);
  }
  await db.delete("databases", id);
}

export async function clearAllLocalData() {
  const db = await getDb();
  await Promise.all([
    db.clear("messages"),
    db.clear("sessions"),
    db.clear("databases"),
    db.clear("settings"),
  ]);
}

export async function listSessions(dbId: string) {
  const db = await getDb();
  const sessions = await db.getAllFromIndex("sessions", "by-db", dbId);
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function upsertSession(entry: ChatSession) {
  const db = await getDb();
  await db.put("sessions", entry);
}

export async function removeSession(id: string) {
  const db = await getDb();
  const messages = await db.getAllFromIndex("messages", "by-session", id);
  for (const message of messages) {
    await db.delete("messages", message.id);
  }
  await db.delete("sessions", id);
}

export async function listMessages(sessionId: string) {
  const db = await getDb();
  const messages = await db.getAllFromIndex("messages", "by-session", sessionId);
  return messages.sort((a, b) => a.createdAt - b.createdAt);
}

export async function putMessages(messages: ChatMessage[]) {
  const db = await getDb();
  const tx = db.transaction(["messages", "sessions"], "readwrite");
  for (const message of messages) {
    await tx.objectStore("messages").put(message);
    const session = await tx.objectStore("sessions").get(message.sessionId);
    if (session) {
      session.updatedAt = message.createdAt;
      await tx.objectStore("sessions").put(session);
    }
  }
  await tx.done;
}

export async function getSetting(key: string): Promise<string | undefined> {
  const db = await getDb();
  const row = await db.get("settings", key);
  return row?.value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.put("settings", { key, value });
}
