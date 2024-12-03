const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const mysql = require("mysql2");
const { get } = require("lodash");
const request = require("request");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { WebSocketServer } = require("ws");

require("dotenv").config(); // โหลด .env

const FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

console.log("Facebook Token:", FACEBOOK_ACCESS_TOKEN);

// ตั้งค่าการเชื่อมต่อ MySQL
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// สร้าง Express App
const app = express();
app.use(cors());
app.use(bodyParser.json());

// สร้าง WebSocket Server
const wss = new WebSocketServer({ port: 3002 });
const clients = [];

// จัดการการเชื่อมต่อ WebSocket
wss.on("connection", (ws) => {
  clients.push(ws);
  console.log("WebSocket connected");

  ws.on("close", () => {
    console.log("WebSocket disconnected");
    clients.splice(clients.indexOf(ws), 1);
  });
});

// ฟังก์ชัน Broadcast ข้อความไปยังทุก Client
const broadcastMessage = (message) => {
  clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  });
};

//function gemini AI
async function start_AI(message_in) {
  let prompt =
    "คุณคือผู้ขายรถเต้น EVX เพศหญิง มีหน้าที่รับคำถามจากลูกค้าและให้คำแนะนำ\n";
  prompt += message_in;
  prompt += "\nหลังจากแนะนำทำการขอเบอร์ลูกค้าไว้ติดต่อกลับเพิ่มเติม";
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  let result = await model.generateContent(prompt);
  return result.response.text();
}

// app.post("/api/geminicall", async (req, res) => {
//   const { message } = req.body;
//   let ai_talk = await start_AI(message);
//   res.send({ AI: ai_talk });
// });

app.get("/api/webhookfacebook", async (req, res) => {
  // Parse the query params
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === FACEBOOK_ACCESS_TOKEN) {
    res.send(challenge);
  } else {
    // Responds with '403 Forbidden' if verify tokens do not match
    console.log("WEBHOOK_VERIFIED");
    res.sendStatus(403);
  }
});

// Endpoint: รับข้อความจาก Facebook Webhook
app.post("/api/webhookfacebook", async (req, res) => {
  const { body } = req;
  if (body.object === "page") {
    const events = body && body.entry && body.entry[0];
    await handleEventsFacebook(events);
  } else {
    // Returns a '404 Not Found' if event is not from a page subscription
    res.sendStatus(404);
  }
  return res.sendStatus(200);
});

// Endpoint: รับข้อความจาก LINE Webhook
app.post("/webhook/line", (req, res) => {
  const message = req.body.events[0]?.message;
  if (message) {
    const senderId = req.body.events[0]?.source?.userId; // ตัวระบุบุคคล
    const text = message?.text || "ไม่มีข้อความ";
    saveMessageToDB("line", senderId, text);
  }
  res.sendStatus(200);
});

// Endpoint: รับข้อความจาก WhatsApp Webhook
app.post("/webhook/whatsapp", (req, res) => {
  const message = req.body.messages[0];
  if (message) {
    const senderId = message.from; // ตัวระบุบุคคล
    const text = message.text?.body || "ไม่มีข้อความ";
    saveMessageToDB("whatsapp", senderId, text);
  }
  res.sendStatus(200);
});

// บันทึกข้อความลงฐานข้อมูล
const saveMessageToDB = (platform, senderId, text) => {
  const roomName = `${platform} - ${senderId}`; // ใช้ sender_id เป็นส่วนหนึ่งของชื่อห้อง
  pool.query(
    "INSERT INTO chat_rooms (name, platform, sender_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)",
    [roomName, platform, senderId],
    (roomError, roomResults) => {
      if (roomError) {
        console.error("Error saving room:", roomError);
        return;
      }
      const roomId = roomResults.insertId;
      pool.query(
        "INSERT INTO chat_messages (room_id, sender_id, message) VALUES (?, ?, ?)",
        [roomId, senderId, text],
        (messageError) => {
          if (messageError) {
            console.error("Error saving message:", messageError);
            return;
          }
          broadcastMessage({
            room_id: roomId,
            sender_id: senderId,
            message: text,
          });
        }
      );
    }
  );
};

// Endpoint: ดึงรายชื่อห้องแชท
app.get("/api/chat-rooms", (req, res) => {
  pool.query(
    "SELECT * FROM chat_rooms ORDER BY created_at DESC",
    (error, results) => {
      if (error) {
        return res.status(500).json({ error: "Error fetching chat rooms" });
      }
      res.json(results);
    }
  );
});

// Endpoint: ดึงประวัติแชทในห้อง
app.get("/api/chat-rooms/:roomId/messages", (req, res) => {
  const roomId = req.params.roomId;
  pool.query(
    "SELECT * FROM chat_messages WHERE room_id = ? ORDER BY created_at ASC",
    [roomId],
    (error, results) => {
      if (error) {
        return res.status(500).json({ error: "Error fetching chat messages" });
      }
      res.json(results);
    }
  );
});

app.get("/api/test", (req, res) => {
  return res.status(200).json({ ss: "ok" });
});

const handleEventsFacebook = async (events) => {
  const hunmen = get(events, ["messaging", 0, "message", "text"]);
  const sender = get(events, ["messaging", 0, "sender", "id"]);
 
  let text = await start_AI(hunmen);
  text = text.toString();

  const requestBody = {
    messaging_type: "RESPONSE",
    recipient: {
      id: sender,
    },
    message: { text },
  };

  const config = {
    method: "post",
    uri: "https://graph.facebook.com/v21.0/me/messages",
    json: requestBody,
    qs: {
      access_token: `${PAGE_ACCESS_TOKEN}`,
    },
  };

  return request(config, (err, res, body) => {
    if (!body.error) {
      console.log("message sent!", body);
      return body;
    } else {
      return new Error("Unable to send message:" + body.error);
    }
  });
};

// ใช้ค่าจาก .env
const PORT = process.env.PORT || 3001;

// เริ่มต้นเซิร์ฟเวอร์
app.listen(PORT, () => {
  console.log(`Backend server is running on http://0.0.0.0:${PORT}`);
});
