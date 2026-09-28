// ─────────────────────────────────────────────────────────────────────────────
// models/SupportTicket.js
//
// AMBIENCE — Customer Support Ticketing Model (Mongoose)
//
// Created by users via POST /api/support
// Managed by admins via GET/PUT /api/admin/support-tickets
//
// Categories: Billing, Payment Issues, Order Received, Account Security
// Statuses:   open → in-progress → resolved → closed
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");

const supportTicketSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    userName: {
      type: String,
      required: true,
      trim: true,
    },
    userEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    category: {
      type: String,
      enum: {
        values: ["Billing", "Payment Issues", "Order Received", "Account Security"],
        message: "{VALUE} is not a valid ticket category",
      },
      required: [true, "Ticket category is required"],
    },
    orderId: {
      type: String,
      trim: true,
      default: "",
    },
    message: {
      type: String,
      required: [true, "Ticket message is required"],
      trim: true,
      maxlength: [2000, "Message cannot exceed 2000 characters"],
    },
    status: {
      type: String,
      enum: {
        values: ["open", "in-progress", "resolved", "closed"],
        message: "{VALUE} is not a valid status",
      },
      default: "open",
      index: true,
    },
    adminNotes: {
      type: String,
      trim: true,
      default: "",
      maxlength: [2000, "Admin notes cannot exceed 2000 characters"],
    },
  },
  {
    timestamps: true,
  }
);

const SupportTicket = mongoose.model("SupportTicket", supportTicketSchema);
module.exports = SupportTicket;
