require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();
app.use(cors()); // 他のサイトからの接続を許可
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] } // WebSocketの他サイト接続許可
});

const JWT_SECRET = process.env.JWT_SECRET || 'secret';

// --- 新規登録 ---
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await prisma.user.create({ data: { username, password: hashedPassword } });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, message: "登録失敗" });
  }
});

// --- ログイン ---
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await prisma.user.findUnique({ where: { username } });
  if (user && await bcrypt.compare(password, user.password)) {
    const token = jwt.sign({ username: user.username }, JWT_SECRET);
    res.json({ success: true, token, username: user.username });
  } else {
    res.status(401).json({ success: false });
  }
});

// --- チャット通信 ---
io.on('connection', async (socket) => {
  // 1. 接続した瞬間に、過去のメッセージを最新50件くらい送ってあげる
  const pastMessages = await prisma.message.findMany({
    take: 50,
    orderBy: { createdAt: 'asc' }
  });
  socket.emit('load messages', pastMessages);

  // 2. メッセージを受け取ったらDBに保存してから全員に送る
  socket.on('chat message', async (data) => {
    // DBに保存
    const savedMsg = await prisma.message.create({
      data: {
        user: data.user,
        text: data.text
      }
    });
    // 保存した内容（時間入り）を全員に送る
    io.emit('chat message', savedMsg); 
  });
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Run on ${PORT}`));
