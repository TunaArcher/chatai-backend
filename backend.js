const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const mysql = require("mysql2");
const { WebSocketServer } = require("ws");

// ตั้งค่าการเชื่อมต่อ MySQL
const pool = mysql.createPool({
  host: "",
  user: "doadmin",
  password: "",
  database: "ChatAi",
  port: 25060,
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

// Endpoint: รับข้อความจาก Facebook Webhook
app.post("/webhook/facebook", (req, res) => {
  const message = req.body.entry[0]?.messaging[0];
  if (message) {
    const senderId = message.sender.id; // ตัวระบุบุคคล
    const text = message.message?.text || "ไม่มีข้อความ";
    saveMessageToDB("facebook", senderId, text);
  }
  res.sendStatus(200);
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

// เริ่มต้นเซิร์ฟเวอร์
app.listen(3001, () => {
  console.log("Backend server is running on http://localhost:3001");
});
