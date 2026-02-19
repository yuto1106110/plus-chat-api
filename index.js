const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

// --- データベース接続 ---
const MONGO_URI = process.env.DATABASE_URL;
mongoose.connect(MONGO_URI, { maxPoolSize: 50 }).then(() => console.log("✅ DB Connected"));

// --- スキーマ定義 ---
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    userId: { type: String, required: true, unique: true },
    role: { type: String, default: 'USER' },
    isBanned: { type: Boolean, default: false },
    isShadowBanned: { type: Boolean, default: false },
    muteUntil: { type: Date, default: null },
    nameColor: { type: String, default: '#3ea6ff' }
});
const User = mongoose.model('User', UserSchema);

const MessageSchema = new mongoose.Schema({
    id: Number,
    userId: String,
    user: String,
    text: String,
    role: String,
    color: String,
    isEdited: { type: Boolean, default: false },
    replyTo: { type: Object, default: null }, // {id, user, text}
    createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', MessageSchema);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const lastMessageTimes = new Map();

// --- セキュリティ：強力なサニタイズ関数 ---
function sanitize(str) {
    if (!str) return "";
    return String(str).replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
}

// --- API ルート ---
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        if (await User.findOne({ username }).lean()) return res.json({ success: false, message: "使用済み" });
        const userId = "u_" + Math.random().toString(36).substring(2, 12);
        await new User({ username, password, userId }).save();
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username, password }).lean();
        if (!user) return res.json({ success: false, message: "失敗" });
        if (user.isBanned) return res.json({ success: false, message: "BAN中" });
        res.json({ success: true, userId: user.userId, username: user.username, role: user.role, nameColor: user.nameColor });
    } catch (e) { res.json({ success: false }); }
});

// --- Socket 通信ロジック ---
io.on('connection', async (socket) => {
    io.emit('online count', io.engine.clientsCount);
    
    // 履歴取得
    const history = await Message.find().sort({ createdAt: -1 }).limit(50).lean();
    socket.emit('load messages', history.reverse());

    // 名前色変更
    socket.on('update color', async (data) => {
        await User.updateOne({ userId: data.userId }, { nameColor: data.color });
    });

    // ユーザーステータス取得
    socket.on('get user status', async (tid) => {
        const t = await User.findOne({ userId: tid }).lean();
        if (!t) return;
        let m = "なし";
        if (t.muteUntil && t.muteUntil > new Date()) {
            const diffMs = t.muteUntil.getTime() - Date.now();
            m = diffMs > 1000000000 ? "永久" : `残り約 ${Math.ceil(diffMs/60000)} 分`;
        }
        // 隠密状態を含めて送信。表示の可否はフロントエンドの myRole で制御。
        socket.emit('user status data', { isBanned: t.isBanned, isShadowBanned: t.isShadowBanned, muteStatus: m });
    });

    // メッセージ送信（返信・荒らし対策統合）
    socket.on('chat message', async (data) => {
        const u = await User.findOne({ userId: data.userId }).lean();
        if (!u || u.isBanned) return;
        if (Date.now() - (lastMessageTimes.get(data.userId) || 0) < 2000) return; // 2秒連投制限
        if (u.muteUntil && u.muteUntil > new Date()) return;

        // 返信データのサニタイズ（ここが荒らし対策の肝）
        let safeReply = null;
        if (data.replyTo) {
            safeReply = {
                id: Number(data.replyTo.id),
                user: sanitize(data.replyTo.user),
                text: sanitize(data.replyTo.text) // 返信引用文を無害化
            };
        }

        const msg = { 
            id: Date.now(), 
            userId: data.userId, 
            user: u.username, 
            text: sanitize(data.text), // 送信本文を無害化
            role: u.role, 
            color: u.nameColor,
            replyTo: safeReply,
            isEdited: false
        };

        if (!u.isShadowBanned) {
            io.emit('chat message', msg);
            await new Message(msg).save();
        } else {
            // シャドウバン中のユーザーには自分だけに表示（他人の履歴には残らない）
            socket.emit('chat message', msg);
        }
        lastMessageTimes.set(data.userId, Date.now());
    });

    // 自分のメッセージを編集
    socket.on('edit message', async (d) => {
        const msg = await Message.findOne({ id: d.msgId });
        if (msg && msg.userId === d.myId) {
            const safeText = sanitize(d.newText);
            await Message.updateOne({ id: d.msgId }, { text: safeText, isEdited: true });
            io.emit('update message', { id: d.msgId, text: safeText, isEdited: true });
        }
    });

    // 自分のメッセージを削除
    socket.on('delete my message', async (d) => {
        const msg = await Message.findOne({ id: d.msgId });
        if (msg && msg.userId === d.myId) {
            await Message.deleteOne({ id: d.msgId });
            io.emit('delete message', d.msgId);
        }
    });

    // 管理者コマンド
    socket.on('admin command', async (d) => {
        const a = await User.findOne({ userId: d.myId }).lean();
        if (!a || (a.role !== 'ADMIN' && a.role !== 'OWNER')) return;

        if (d.type === 'delete') { 
            await Message.deleteOne({ id: d.msgId }); 
            io.emit('delete message', d.msgId); 
        }
        else if (d.type === 'ban') { 
            await User.updateOne({ userId: d.targetId }, { isBanned: true }); 
            io.emit('force logout user', d.targetId); 
        }
        else if (d.type === 'mute') {
            const dt = d.minutes ? new Date(Date.now() + d.minutes * 60000) : new Date(253402214400000);
            await User.updateOne({ userId: d.targetId }, { muteUntil: dt });
        }
        else if (d.type === 'unmute') { await User.updateOne({ userId: d.targetId }, { muteUntil: null }); }
        else if (d.type === 'promote') { await User.updateOne({ userId: d.targetId }, { role: 'ADMIN' }); }
        else if (d.type === 'demote') { await User.updateOne({ userId: d.targetId }, { role: 'USER' }); }
        else if (d.type === 'shadowban') { await User.updateOne({ userId: d.targetId }, { isShadowBanned: true }); }
        else if (d.type === 'unshadowban') { await User.updateOne({ userId: d.targetId }, { isShadowBanned: false }); }
    });

    // グローバル管理者コマンド（OWNER専用）
    socket.on('admin global command', async (d) => {
        const o = await User.findOne({ userId: d.myId }).lean();
        if (o && o.role === 'OWNER') {
            if (d.type === 'clearall') { await Message.deleteMany({}); io.emit('clear all messages'); }
            else if (d.type === 'kickall') io.emit('force logout');
        }
    });

    socket.on('disconnect', () => io.emit('online count', io.engine.clientsCount));
});

server.listen(process.env.PORT || 10000, () => {
    console.log("✅ Server version 2.0 (Reply-Secure) is running");
});

