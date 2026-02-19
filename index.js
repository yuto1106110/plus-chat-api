const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

// --- 1. MongoDB 接続設定 ---
const MONGO_URI = process.env.DATABASE_URL;
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected!"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err));

// --- 2. スキーマ（データ構造）定義 ---
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

// --- 3. セキュリティ設定 ---
const COOLDOWN_MS = 2500; // 2.5秒の連投制限
const lastMessageTimes = new Map();

function sanitize(str) {
    if (typeof str !== 'string') return "";
    return str.replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
}

// --- 4. API (登録・ログイン) ---
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        if (!/^[a-zA-Z0-9ぁ-んァ-ヶー一-龠\-_]+$/.test(username)) {
            return res.json({ success: false, message: "名前に特殊記号は使えません" });
        }
        const existing = await User.findOne({ username });
        if (existing) return res.json({ success: false, message: "この名前は既に使われています" });

        const userId = "u_" + Math.random().toString(36).substring(2, 12);
        const newUser = new User({ username, password, userId, role: 'USER' });
        await newUser.save();
        res.json({ success: true });
    } catch (e) { res.json({ success: false, message: "登録エラー" }); }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username, password });
        if (!user) return res.json({ success: false, message: "認証に失敗しました" });
        if (user.isBanned) return res.json({ success: false, message: "あなたはBANされています" });

        res.json({ 
            success: true, 
            userId: user.userId, 
            username: user.username, 
            role: user.role,
            muteUntil: user.muteUntil 
        });
    } catch (e) { res.json({ success: false }); }
});

// --- 5. Socket.io 通信ロジック ---
io.on('connection', async (socket) => {
    io.emit('online count', io.engine.clientsCount);

    // 履歴取得
    const history = await Message.find().sort({ createdAt: -1 }).limit(100);
    socket.emit('load messages', history.reverse());

    // メッセージ受信
    socket.on('chat message', async (data) => {
        try {
            const sender = await User.findOne({ userId: data.userId });
            if (!sender || sender.isBanned) return;

            // 【対策】連投制限
            const now = Date.now();
            const lastTime = lastMessageTimes.get(sender.userId) || 0;
            if (now - lastTime < COOLDOWN_MS) {
                return socket.emit('system message', "連投禁止です。少し待ってください。");
            }

            // 【対策】ミュート
            if (sender.muteUntil && sender.muteUntil > new Date()) {
                const remains = Math.ceil((sender.muteUntil - new Date()) / 60000);
                return socket.emit('system message', `ミュート中です。残り約${remains}分`);
            }

            const cleanText = data.text ? data.text.trim() : "";
            if (!cleanText || cleanText.length > 500) return;

            const newMessage = new Message({
                id: now,
                userId: sender.userId,
                user: sender.username,
                text: sanitize(cleanText),
                role: sender.role
            });

            await newMessage.save();
            lastMessageTimes.set(sender.userId, now);
            io.emit('chat message', newMessage);

        } catch (e) { console.error(e); }
    });

    // 管理者コマンド (BAN, MUTE, DELETE)
    socket.on('admin command', async (data) => {
        const admin = await User.findOne({ userId: data.myId });
        if (!admin || (admin.role !== 'ADMIN' && admin.role !== 'OWNER')) return;

        if (data.type === 'delete') {
            await Message.deleteOne({ id: data.msgId });
            io.emit('delete message', data.msgId);
        } else if (data.type === 'ban') {
            await User.updateOne({ userId: data.targetId }, { isBanned: true });
            io.emit('force logout user', data.targetId); // 特定ユーザーを追い出す
        } else if (data.type === 'mute') {
            const date = data.minutes ? new Date(Date.now() + data.minutes * 60000) : new Date(8640000000000000);
            await User.updateOne({ userId: data.targetId }, { muteUntil: date });
            io.emit('update user status', { userId: data.targetId, muteUntil: date });
        } else if (data.type === 'unmute') {
            await User.updateOne({ userId: data.targetId }, { muteUntil: null });
            io.emit('update user status', { userId: data.targetId, muteUntil: null });
        }
    });

    // グローバルコマンド (OWNER専用: CLEARALL, KICKALL)
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
server.listen(PORT, () => console.log(`🚀 Final Version Server Port ${PORT}`));

