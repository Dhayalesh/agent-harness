import mongoose from "mongoose";
import { config } from "./config.js";

export async function connectDatabase() {
  mongoose.set("strictQuery", true);
  await mongoose.connect(config.mongoUri, {
    serverSelectionTimeoutMS: 8000,
    ...(config.mongoDbName ? { dbName: config.mongoDbName } : {}),
  });
  return mongoose.connection;
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}

/** 1 = connected. Reported on /api/health so the UI can say why writes fail. */
export function databaseState() {
  const names = ["disconnected", "connected", "connecting", "disconnecting"];
  return names[mongoose.connection.readyState] ?? "unknown";
}

export function databaseName() {
  return mongoose.connection.name || null;
}
