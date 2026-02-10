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

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// --- アカウント登録 API ---
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { username, password: hashedPassword }
    });
    res.json({ success: true, message: "ユーザー登録完了！" });
  } catch (e) {
    res.status(400).json({ success: false, message: "既に使われているユーザー名です" });
  }
});

// --- ログイン API ---
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await prisma.user.findUnique({ where: { username } });
  if (user && await bcrypt.compare(password, user.password)) {
    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET);
    res.json({ success: true, token, username: user.username });
  } else {
    res.status(401).json({ success: false, message: "ユーザー名かパスワードが違います" });
  }
});

// --- WebSocket (チャット) ---
io.on('connection', (socket) => {
  socket.on('chat message', (data) => {
    io.emit('chat message', data); 
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
