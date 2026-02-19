const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

// --- MongoDB 接続設定 ---
const MONGO_URI = process.env.DATABASE_URL;
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB 接続成功"))
    .catch(err => console.error("❌ MongoDB 接続エラー:", err));

// --- スキーマ定義 ---
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    userId: { type: String, required: true, unique: true },
    role: { type: String, default: 'USER' },
    isBanned: { type: Boolean, default: false },
    muteUntil: { type: Date, default: null }
});
const User = mongoose.model('User', UserSchema);

const MessageSchema = new mongoose.Schema({
    id: Number,
    userId: String,
    user: String,
    text: String,
    role: String,
    createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', MessageSchema);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- 対策設定 ---
const COOLDOWN_MS = 3000; // 3秒間のクールダウン
const lastMessageTimes = new Map(); // 連投監視用メモリ

function sanitize(str) {
    if (typeof str !== 'string') return "";
    return str.replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
}

// --- API ルート ---
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        if (!/^[a-zA-Z0-9ぁ-んァ-ヶー一-龠\-_]+$/.test(username)) return res.json({ success: false, message: "名前に使用できない文字が含まれています" });
        const existing = await User.findOne({ username });
        if (existing) return res.json({ success: false, message: "既に使われています" });
        const userId = "u_" + Math.random().toString(36).substring(2, 10);
        const newUser = new User({ username, password, userId, role: 'USER' });
        await newUser.save();
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username, password });
        if (!user) return res.json({ success: false, message: "認証失敗" });
        if (user.isBanned) return res.json({ success: false, message: "BANされています" });
        res.json({ success: true, userId: user.userId, username: user.username, role: user.role });
    } catch (e) { res.json({ success: false }); }
});

// --- Socket.io メインロジック ---
io.on('connection', async (socket) => {
    io.emit('online count', io.engine.clientsCount);

    const history = await Message.find().sort({ createdAt: -1 }).limit(100);
    socket.emit('load messages', history.reverse());

    socket.on('chat message', async (data) => {
        try {
            const now = Date.now();
            const sender = await User.findOne({ username: data.user });
            
            if (!sender || sender.isBanned) return;

            // 【対策】連投チェック
            const lastTime = lastMessageTimes.get(sender.userId) || 0;
            if (now - lastTime < COOLDOWN_MS) {
                return socket.emit('system message', "連投は禁止です。少し待ってください。");
            }

            // 【対策】バリデーション
            const cleanText = data.text ? data.text.trim() : "";
            if (!cleanText || cleanText.length > 500) return;

            // ミュートチェック
            if (sender.muteUntil && sender.muteUntil > new Date()) {
                return socket.emit('system message', "現在ミュートされています。");
            }

            const newMessage = new Message({
                id: now,
                userId: sender.userId,
                user: sanitize(sender.username),
                text: sanitize(cleanText),
                role: sender.role
            });

            await newMessage.save();
            lastMessageTimes.set(sender.userId, now); // クールダウン更新
            io.emit('chat message', newMessage);

        } catch (e) { console.error(e); }
    });

    // 管理者操作
    socket.on('admin command', async (data) => {
        const admin = await User.findOne({ userId: data.myId });
        if (!admin || (admin.role !== 'ADMIN' && admin.role !== 'OWNER')) return;

        if (data.type === 'delete') {
            await Message.deleteOne({ id: data.msgId });
            io.emit('delete message', data.msgId);
        } else if (data.type === 'ban') {
            await User.updateOne({ userId: data.targetId }, { isBanned: true });
        } else if (data.type === 'mute') {
            const date = data.minutes ? new Date(Date.now() + data.minutes * 60000) : new Date(8640000000000000);
            await User.updateOne({ userId: data.targetId }, { muteUntil: date });
        }
    });

    // 全体操作
    socket.on('admin global command', async (data) => {
        const owner = await User.findOne({ userId: data.myId });
        if (!owner || owner.role !== 'OWNER') return;

        if (data.type === 'clearall') {
            await Message.deleteMany({});
            io.emit('clear all messages');
        } else if (data.type === 'kickall') {
            io.emit('force logout');
        }
    });

    socket.on('disconnect', () => {
        io.emit('online count', io.engine.clientsCount);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Security Plus Server Port ${PORT}`));

