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
io.on('connection', (socket) => {
  socket.on('chat message', (data) => {
    io.emit('chat message', data); // 全員に転送
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Run on ${PORT}`));
