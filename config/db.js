// ─────────────────────────────────────────────────────────────────────────────
// config/db.js
//
// AMBIENCE — MongoDB Atlas Connection Manager
//
// Enterprise-grade connection with:
//   • Connection pooling (maxPoolSize: 10)
//   • Auto-reconnect via Mongoose built-in retry logic
//   • Strict error logging on all connection events
//   • Graceful shutdown on SIGINT / SIGTERM
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");

const connectDB = async () => {
  const MONGO_URI = process.env.MONGO_URI;

  if (!MONGO_URI) {
    console.error("══════════════════════════════════════════════════════════");
    console.error("  ❌  MONGO_URI is not defined in server/.env");
    console.error("  →  Add your MongoDB Atlas connection string:");
    console.error("     MONGO_URI=mongodb+srv://<user>:<pass>@cluster.mongodb.net/ambience");
    console.error("══════════════════════════════════════════════════════════");
    process.exit(1);
  }

  try {
    const conn = await mongoose.connect(MONGO_URI, {
      // ── Connection Pool ───────────────────────────────────────────────────
      maxPoolSize: 10,
      minPoolSize: 2,

      // ── Timeouts ──────────────────────────────────────────────────────────
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,

      // ── Heartbeat ─────────────────────────────────────────────────────────
      heartbeatFrequencyMS: 10000,

      // ── Write Concern ─────────────────────────────────────────────────────
      retryWrites: true,
      w: "majority",
    });

    console.log("");
    console.log("┌─────────────────────────────────────────────────────────┐");
    console.log(`│  ✅  MongoDB Atlas connected: ${conn.connection.host}`.padEnd(58) + "│");
    console.log(`│  📦  Database: ${conn.connection.name}`.padEnd(58) + "│");
    console.log(`│  🔗  Pool size: 10 (min: 2)`.padEnd(58) + "│");
    console.log("└─────────────────────────────────────────────────────────┘");
    console.log("");
  } catch (err) {
    console.error("");
    console.error("══════════════════════════════════════════════════════════");
    console.error("  ❌  MongoDB Atlas connection FAILED");
    console.error(`  →  Error: ${err.message}`);
    console.error("  →  Check your MONGO_URI in server/.env");
    console.error("  →  Ensure your IP is whitelisted in Atlas");
    console.error("══════════════════════════════════════════════════════════");
    console.error("");
    process.exit(1);
  }

  // ── Connection Event Listeners ──────────────────────────────────────────
  mongoose.connection.on("connected", () => {
    console.info("[MongoDB] ✅ Mongoose connected to Atlas");
  });

  mongoose.connection.on("error", (err) => {
    console.error("[MongoDB] ❌ Mongoose connection error:", err.message);
  });

  mongoose.connection.on("disconnected", () => {
    console.warn("[MongoDB] ⚠️  Mongoose disconnected from Atlas");
  });

  mongoose.connection.on("reconnected", () => {
    console.info("[MongoDB] 🔄 Mongoose reconnected to Atlas");
  });

  // ── Graceful Shutdown ───────────────────────────────────────────────────
  const gracefulShutdown = async (signal) => {
    console.info(`[MongoDB] 🛑 ${signal} received — closing connection...`);
    try {
      await mongoose.connection.close();
      console.info("[MongoDB] ✅ Connection closed gracefully");
      process.exit(0);
    } catch (err) {
      console.error("[MongoDB] ❌ Error during shutdown:", err.message);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
};

module.exports = connectDB;
