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
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const JWT_SECRET = process.env.JWT_SECRET || 'secret';

// --- アカウント系 ---
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

// --- チャット通信 (最新50件取得) ---
io.on('connection', async (socket) => {
  try {
    // 最新の50件を降順(新しい順)で取得
    const rawMessages = await prisma.message.findMany({
      take: 50,
      orderBy: { createdAt: 'desc' }
    });
    // 画面表示用に昇順(古い順)に反転させる
    const pastMessages = rawMessages.reverse();
    socket.emit('load messages', pastMessages);
  } catch (err) {
    console.error("DB Error:", err);
  }

  socket.on('chat message', async (data) => {
    try {
      const savedMsg = await prisma.message.create({
        data: { user: data.user, text: data.text }
      });
      io.emit('chat message', savedMsg); 
    } catch (err) {
      console.error("Save Error:", err);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));
