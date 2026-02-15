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

// ログイン・登録APIは前回と同じなので省略（実際にはそのまま残してください）

// --- Socket.io ---
let onlineUsers = new Set();

io.on('connection', async (socket) => {
    // 接続時にユーザー名を特定できないため、ログイン後にemitするように変更も可能ですが、
    // 簡易的にソケットIDでカウントします
    onlineUsers.add(socket.id);
    io.emit('online count', onlineUsers.size);

    const msgs = await prisma.message.findMany({ take: 50, orderBy: { createdAt: 'desc' } });
    socket.emit('load messages', msgs.reverse());

    socket.on('chat message', async (data) => {
        if (!data || !data.text || !data.user) return;
        try {
            const user = await prisma.user.findUnique({ where: { username: data.user } });
            if (!user || user.isBanned) return;

            // ミュート期間のチェック
            if (user.isMuted) {
                if (user.muteUntil && new Date() > user.muteUntil) {
                    // 期限が過ぎていれば自動解除
                    await prisma.user.update({ where: { id: user.id }, data: { isMuted: false, muteUntil: null } });
                } else {
                    return; // まだミュート中
                }
            }

            const newMsg = await prisma.message.create({
                data: { user: data.user, text: data.text, userId: String(user.id), role: user.role }
            });
            io.emit('chat message', newMsg);
        } catch (err) { console.error(err); }
    });

    socket.on('admin command', async (data) => {
        try {
            const op = await prisma.user.findUnique({ where: { id: Number(data.myId) } });
            const tg = await prisma.user.findUnique({ where: { id: Number(data.targetId) } });
            if (!op || !tg || ROLES[op.role] < ROLES.ADMIN) return;

            let updateData = {};
            
            // ミュート処理 (data.minutes があれば期間限定)
            if (data.type === 'mute') {
                updateData.isMuted = true;
                if (data.minutes) {
                    updateData.muteUntil = new Date(Date.now() + data.minutes * 60000);
                } else {
                    updateData.muteUntil = null; // 永遠
                }
            }
            if (data.type === 'unmute') { updateData.isMuted = false; updateData.muteUntil = null; }
            if (data.type === 'ban') updateData.isBanned = true;
            if (data.type === 'unban') updateData.isBanned = false;
            if (data.type === 'promote' && op.role === 'OWNER') updateData.role = 'ADMIN';
            if (data.type === 'demote' && op.role === 'OWNER') updateData.role = 'USER';

            if (Object.keys(updateData).length > 0) {
                const updated = await prisma.user.update({ where: { id: tg.id }, data: updateData });
                io.emit('system message', `${tg.username}の状態が変更されました`);
            }
            if (data.type === 'delete' && data.msgId) {
                await prisma.message.delete({ where: { id: Number(data.msgId) } });
                io.emit('delete message', data.msgId);
            }
        } catch (err) { console.error(err); }
    });

    socket.on('disconnect', () => {
        onlineUsers.delete(socket.id);
        io.emit('online count', onlineUsers.size);
    });
});

server.listen(3000);
