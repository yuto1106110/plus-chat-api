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
const io = new Server(server, { cors: { origin: "*" } });

const JWT_SECRET = process.env.JWT_SECRET || 'secret-key-123';
const ROLES = { OWNER: 100, ADMIN: 50, MODERATOR: 20, USER: 0 };

// --- 認証API ---
app.post('/api/register', async (req, res) => {
  try {
    const hashedPassword = await bcrypt.hash(req.body.password, 10);
    const userCount = await prisma.user.count();
    // 最初の1人だけを絶対的管理者(OWNER)にする
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
  // 接続時に最新50件を送信
  const initialMsgs = await prisma.message.findMany({ take: 50, orderBy: { createdAt: 'desc' } });
  socket.emit('load messages', initialMsgs.reverse());

  socket.on('chat message', async (data) => {
    const user = await prisma.user.findUnique({ where: { username: data.user } });
    if (!user || user.isBanned) return;

    // 1. メッセージ保存
    const newMsg = await prisma.message.create({
      data: { user: data.user, text: data.text, userId: String(user.id), role: user.role }
    });

    // 2. 【50件制限機能】
    const count = await prisma.message.count();
    if (count > 50) {
      const oldestMessages = await prisma.message.findMany({
        orderBy: { createdAt: 'asc' },
        take: count - 50
      });
      await prisma.message.deleteMany({
        where: { id: { in: oldestMessages.map(m => m.id) } }
      });
    }

    io.emit('chat message', newMsg);
  });

  // 管理者コマンド
  socket.on('admin command', async (data) => {
    const op = await prisma.user.findUnique({ where: { id: Number(data.myId) } });
    const tg = await prisma.user.findUnique({ where: { id: Number(data.targetId) } });
    if (!op || !tg) return;

    if (ROLES[op.role] <= ROLES[tg.role]) return; // 格上または同格は操作不能

    if (data.type === 'ban' && ROLES[op.role] >= ROLES.ADMIN) {
      await prisma.user.update({ where: { id: tg.id }, data: { isBanned: true } });
      io.emit('system message', `${tg.username} が追放されました`);
    } else if (data.type === 'promote' && op.role === 'OWNER') {
      await prisma.user.update({ where: { id: tg.id }, data: { role: data.newRole } });
      io.emit('system message', `${tg.username} が ${data.newRole} に任命されました`);
    }
  });
});

server.listen(3000, () => console.log('Absolute Server Running on :3000'));

// --- 【緊急用】データベース強制リセットくん ---
async function emergencyReset() {
  try {
    console.log("DBリセットを開始します...");
    // メッセージを全部消す
    await prisma.message.deleteMany({});
    // ユーザーを全部消す
    await prisma.user.deleteMany({});
    console.log("DBのリセットが完了しました！このコードを消して再デプロイしてください。");
  } catch (e) {
    console.error("リセット失敗:", e);
  }
}

// サーバー起動時に実行
emergencyReset();
