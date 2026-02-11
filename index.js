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
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const ROLES = { OWNER: 100, ADMIN: 50, USER: 0 };

// オンライン人数の管理
let onlineUsers = new Set();

// --- 認証系API ---
app.post('/api/register', async (req, res) => {
  try {
    const hashedPassword = await bcrypt.hash(req.body.password, 10);
    const userCount = await prisma.user.count();
    const role = userCount === 0 ? "OWNER" : "USER";
    await prisma.user.create({
      data: { username: req.body.username, password: hashedPassword, role: role }
    });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ success: false }); }
});

app.post('/api/login', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { username: req.body.username } });
  if (user && await bcrypt.compare(req.body.password, user.password)) {
    if (user.isBanned) return res.status(403).json({ success: false, message: "BANされています" });
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET);
    res.json({ success: true, token, username: user.username, userId: user.id, role: user.role });
  } else { res.status(401).json({ success: false }); }
});

// --- Socket.io ---
io.on('connection', async (socket) => {
  onlineUsers.add(socket.id);
  io.emit('online count', onlineUsers.size);

  const initialMsgs = await prisma.message.findMany({ take: 50, orderBy: { createdAt: 'desc' } });
  socket.emit('load messages', initialMsgs.reverse());

  socket.on('chat message', async (data) => {
    const user = await prisma.user.findUnique({ where: { username: data.user } });
    if (!user || user.isBanned || user.isMuted) return;

    const newMsg = await prisma.message.create({
      data: { user: data.user, text: data.text, userId: String(user.id), role: user.role }
    });

    const count = await prisma.message.count();
    if (count > 50) {
      const oldest = await prisma.message.findMany({ orderBy: { createdAt: 'asc' }, take: count - 50 });
      await prisma.message.deleteMany({ where: { id: { in: oldest.map(m => m.id) } } });
    }
    io.emit('chat message', newMsg);
  });

  socket.on('admin command', async (data) => {
    const op = await prisma.user.findUnique({ where: { id: Number(data.myId) } });
    const tg = await prisma.user.findUnique({ where: { id: Number(data.targetId) } });
    if (!op || !tg) return;

    const opLevel = ROLES[op.role];
    const tgLevel = ROLES[tg.role];

    // --- ADMIN以上の現場権限 ---
    if (data.type === 'delete' && opLevel >= ROLES.ADMIN) {
      await prisma.message.delete({ where: { id: Number(data.msgId) } });
      io.emit('delete message', data.msgId);
    } else if (data.type === 'mute' && opLevel >= ROLES.ADMIN && opLevel > tgLevel) {
      await prisma.user.update({ where: { id: tg.id }, data: { isMuted: true } });
      io.emit('system message', `${tg.username} がミュートされました`);
    }

    // --- OWNER専用の人事・赦免権限 ---
    if (op.role === 'OWNER' && op.id !== tg.id) {
      if (data.type === 'promote') {
        await prisma.user.update({ where: { id: tg.id }, data: { role: 'ADMIN' } });
        io.emit('system message', `${tg.username} をADMINに任命しました`);
      } else if (data.type === 'demote') {
        await prisma.user.update({ where: { id: tg.id }, data: { role: 'USER' } });
        io.emit('system message', `${tg.username} の権限を剥奪しました`);
      } else if (data.type === 'ban') {
        await prisma.user.update({ where: { id: tg.id }, data: { isBanned: true } });
        io.emit('system message', `${tg.username} を追放しました`);
      } else if (data.type === 'unban') {
        await prisma.user.update({ where: { id: tg.id }, data: { isBanned: false } });
        io.emit('system message', `${tg.username} の追放を解除しました`);
      } else if (data.type === 'unmute') {
        await prisma.user.update({ where: { id: tg.id }, data: { isMuted: false } });
        io.emit('system message', `${tg.username} のミュートを解除しました`);
      }
    }
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    io.emit('online count', onlineUsers.size);
  });
});

server.listen(3000, () => console.log('Server running on port 3000'));
