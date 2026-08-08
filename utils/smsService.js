const sendSMS = async ({ to, message, logLabel = "SMS" }) => {
  console.log("");
  console.log("┌─────────────────────────────────────────────────┐");
  console.log(`│  📱  AMBIENCE ${logLabel} — MOCK SMS`.padEnd(50) + "│");
  console.log(`│  To:  ${to}`.padEnd(50) + "│");
  console.log(`│  Msg: ${message}`.padEnd(50) + "│");
  console.log("└─────────────────────────────────────────────────┘");
  console.log("");
  return { success: true, messageId: "mock-" + Date.now() };
};

module.exports = { sendSMS };
