const express = require('express');
const { PrismaClient } = require('@prisma/client');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const prisma = new PrismaClient();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

const ROLES = { OWNER: 100, ADMIN: 50, USER: 0 };

// 登録API
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const count = await prisma.user.count();
        const role = count === 0 ? 'OWNER' : 'USER';
        await prisma.user.create({ data: { username, password, role } });
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

// ログインAPI
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await prisma.user.findUnique({ where: { username } });
        if (user && user.password === password) {
            if (user.isBanned) return res.json({ success: false, message: 'BANされています' });
            res.json({ success: true, username: user.username, userId: user.id, role: user.role });
        } else { res.json({ success: false }); }
    } catch (e) { res.json({ success: false }); }
});

io.on('connection', async (socket) => {
    // 履歴読み込み
    const msgs = await prisma.message.findMany({ take: 50, orderBy: { createdAt: 'desc' } });
    socket.emit('load messages', msgs.reverse());

    // メッセージ送信
    socket.on('chat message', async (data) => {
        if (!data || !data.text || !data.user) return;
        try {
            const user = await prisma.user.findUnique({ where: { username: data.user } });
            if (!user || user.isBanned || user.isMuted) return;

            const newMsg = await prisma.message.create({
                data: { 
                    user: data.user, 
                    text: data.text, 
                    userId: String(user.id), 
                    role: user.role 
                }
            });
            io.emit('chat message', newMsg);
        } catch (err) { console.error("Create error:", err); }
    });

    // 管理コマンド (型変換 Number() を徹底)
    socket.on('admin command', async (data) => {
        if (!data || !data.targetId || !data.myId) return;
        try {
            const op = await prisma.user.findUnique({ where: { id: Number(data.myId) } });
            const tg = await prisma.user.findUnique({ where: { id: Number(data.targetId) } });
            if (!op || !tg) return;

            let updateData = {};
            const opLevel = ROLES[op.role] || 0;
            const tgLevel = ROLES[tg.role] || 0;

            if (opLevel >= ROLES.ADMIN && opLevel > tgLevel) {
                if (data.type === 'mute') updateData = { isMuted: true };
                if (data.type === 'unmute') updateData = { isMuted: false };
                if (data.type === 'delete' && data.msgId) {
                    await prisma.message.delete({ where: { id: Number(data.msgId) } });
                    return io.emit('delete message', data.msgId);
                }
            }
            if (op.role === 'OWNER' && op.id !== tg.id) {
                if (data.type === 'ban') updateData = { isBanned: true };
                if (data.type === 'unban') updateData = { isBanned: false };
                if (data.type === 'promote') updateData = { role: 'ADMIN' };
                if (data.type === 'demote') updateData = { role: 'USER' };
            }

            if (Object.keys(updateData).length > 0) {
                const updated = await prisma.user.update({ where: { id: tg.id }, data: updateData });
                io.emit('user updated', { userId: String(updated.id), role: updated.role, isBanned: updated.isBanned, isMuted: updated.isMuted });
            }
        } catch (err) { console.error("Admin error:", err); }
    });
});

server.listen(3000, () => console.log('Server is running!'));
