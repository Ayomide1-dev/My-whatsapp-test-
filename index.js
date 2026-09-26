// index.js
// WhatsApp Test Automation Bot
// Stack: Node.js + Express + Meta WhatsApp Cloud API + Google Gemini (free tier)
// Deploy target: Render.com

const express = require("express");
const bodyParser = require("body-parser");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// ---- Config (from environment variables) ----
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;         // string you choose yourself, entered in Meta dashboard
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;     // Meta access token (temporary or permanent)
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;   // Meta test/production phone number ID
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v21.0";

// Simple in-memory store of last few messages per sender (for lightweight context)
// NOTE: resets on every deploy/restart since Render free tier has an ephemeral filesystem.
const conversationHistory = {}; // { "234801...": [ {role, text}, ... ] }
const MAX_HISTORY = 6;

// ---------- Health check ----------
app.get("/", (req, res) => {
  res.status(200).send("✅ WhatsApp Gemini bot (Meta Cloud API) is running.");
});

// ============================================================
// 1) WEBHOOK VERIFICATION (Meta calls this once, as GET, when
//    you click "Verify and Save" in the App Dashboard)
// ============================================================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified successfully.");
    return res.status(200).send(challenge);
  }

  console.warn("❌ Webhook verification failed. Token mismatch.");
  return res.sendStatus(403);
});

// ============================================================
// 2) INCOMING MESSAGES (Meta calls this as POST whenever a
//    WhatsApp user messages your test number)
// ============================================================
app.post("/webhook", async (req, res) => {
  // Always respond 200 fast so Meta doesn't retry/flag the webhook
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) {
      // Could be a status update (delivered/read) instead of a real message — ignore
      return;
    }

    const from = message.from; // sender's phone number, e.g. "2348012345678"
    const msgType = message.type;
    const incomingText =
      msgType === "text" ? message.text?.body?.trim() : `[${msgType} message]`;

    console.log(`📩 Incoming from ${from}: ${incomingText}`);

    // Built-in test commands
    if (incomingText?.toLowerCase() === "/ping") {
      await sendWhatsAppMessage(from, "pong ✅");
      return;
    }
    if (incomingText?.toLowerCase() === "/reset") {
      conversationHistory[from] = [];
      await sendWhatsAppMessage(from, "🧹 Conversation history cleared.");
      return;
    }

    const history = conversationHistory[from] || [];
    const aiReply = await askGemini(incomingText, history);

    history.push({ role: "user", text: incomingText });
    history.push({ role: "model", text: aiReply });
    conversationHistory[from] = history.slice(-MAX_HISTORY);

    await sendWhatsAppMessage(from, aiReply);
  } catch (err) {
    console.error("❌ Error handling incoming webhook:", err.message);
  }
});

// ============================================================
// Gemini call
// ============================================================
async function askGemini(userMessage, history = []) {
  if (!GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY environment variable.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const contents = [
    ...history.map((h) => ({
      role: h.role === "user" ? "user" : "model",
      parts: [{ text: h.text }],
    })),
    { role: "user", parts: [{ text: userMessage }] },
  ];

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      generationConfig: { temperature: 0.7, maxOutputTokens: 512 },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return (
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ||
    "Sorry, I couldn't generate a response right now."
  );
}

// ============================================================
// Send a message back via Meta Graph API
// ============================================================
async function sendWhatsAppMessage(to, text) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    throw new Error("Missing WHATSAPP_TOKEN or PHONE_NUMBER_ID environment variable.");
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`❌ Failed to send WhatsApp message (${response.status}): ${errText}`);
  } else {
    console.log(`📤 Reply sent to ${to}`);
  }
}

// ============================================================
// Optional: trigger a message manually (for automated tests)
// POST /send  { "to": "2348012345678", "message": "Hello from automation" }
// ============================================================
app.post("/send", async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!to || !message) {
      return res.status(400).json({ error: "Provide 'to' and 'message'." });
    }
    await sendWhatsAppMessage(to, message);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error sending message:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
