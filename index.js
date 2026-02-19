const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

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
    id: Number, userId: String, user: String, text: String, role: String, color: String,
    isEdited: { type: Boolean, default: false },
    replyTo: { type: Object, default: null },
    createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', MessageSchema);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const spamTrack = new Map(); 
const lastMessageTimes = new Map();
const AUTO_MUTE_MINUTES = 10;
const SPAM_THRESHOLD = 5;
const SPAM_INTERVAL = 3000;

function sanitize(str) {
    if (!str) return "";
    return String(str).replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
}

// --- Socket 通信 ---
io.on('connection', async (socket) => {
    io.emit('online count', io.engine.clientsCount);
    const history = await Message.find().sort({ createdAt: -1 }).limit(50).lean();
    socket.emit('load messages', history.reverse());

    // ユーザーステータス取得
    socket.on('get user status', async (tid) => {
        const t = await User.findOne({ userId: tid }).lean();
        if (!t) return;
        let m = "なし";
        if (t.muteUntil && t.muteUntil > new Date()) {
            const diffMs = t.muteUntil.getTime() - Date.now();
            m = diffMs > 1000000000 ? "永久" : `残り約 ${Math.ceil(diffMs/60000)} 分`;
        }
        socket.emit('user status data', { isBanned: t.isBanned, isShadowBanned: t.isShadowBanned, muteStatus: m });
    });

    // メッセージ送信
    socket.on('chat message', async (data) => {
        const u = await User.findOne({ userId: data.userId }).lean();
        if (!u || u.isBanned) return;
        if (u.muteUntil && u.muteUntil > new Date()) return;

        // スパム検知
        const now = Date.now();
        const track = spamTrack.get(data.userId) || { count: 0, lastTime: now };
        if (now - track.lastTime < SPAM_INTERVAL) track.count++;
        else track.count = 1;
        track.lastTime = now;
        spamTrack.set(data.userId, track);

        if (track.count > SPAM_THRESHOLD) {
            const muteTime = new Date(now + AUTO_MUTE_MINUTES * 60000);
            await User.updateOne({ userId: data.userId }, { muteUntil: muteTime });
            socket.emit('system message', `連投により${AUTO_MUTE_MINUTES}分間自動ミュートしました。`);
            return;
        }

        let safeReply = null;
        if (data.replyTo) {
            safeReply = { id: data.replyTo.id, user: sanitize(data.replyTo.user), text: sanitize(data.replyTo.text) };
        }

        const msg = { 
            id: now, userId: data.userId, user: u.username, text: sanitize(data.text), 
            role: u.role, color: u.nameColor, replyTo: safeReply, isEdited: false
        };

        if (!u.isShadowBanned) {
            io.emit('chat message', msg);
            await new Message(msg).save();
        } else {
            socket.emit('chat message', msg);
        }
    });

    // 編集・削除
    socket.on('edit message', async (d) => {
        const msg = await Message.findOne({ id: d.msgId });
        if (msg && msg.userId === d.myId) {
            const safeText = sanitize(d.newText);
            await Message.updateOne({ id: d.msgId }, { text: safeText, isEdited: true });
            io.emit('update message', { id: d.msgId, text: safeText, isEdited: true });
        }
    });

    socket.on('delete my message', async (d) => {
        const msg = await Message.findOne({ id: d.msgId });
        if (msg && msg.userId === d.myId) {
            await Message.deleteOne({ id: d.msgId });
            io.emit('delete message', d.msgId);
        }
    });

    // --- 管理者コマンド (ADMIN / OWNER用) ---
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
        else if (d.type === 'unban') { // BAN解除追加
            await User.updateOne({ userId: d.targetId }, { isBanned: false });
        }
        else if (d.type === 'mute') {
            const dt = d.minutes ? new Date(Date.now() + d.minutes * 60000) : new Date(253402214400000);
            await User.updateOne({ userId: d.targetId }, { muteUntil: dt });
        }
        else if (d.type === 'unmute') { 
            await User.updateOne({ userId: d.targetId }, { muteUntil: null }); 
        }
        else if (d.type === 'promote') { 
            await User.updateOne({ userId: d.targetId }, { role: 'ADMIN' }); 
        }
        else if (d.type === 'demote') { 
            await User.updateOne({ userId: d.targetId }, { role: 'USER' }); 
        }
        else if (d.type === 'shadowban') { 
            await User.updateOne({ userId: d.targetId }, { isShadowBanned: true }); 
        }
        else if (d.type === 'unshadowban') { 
            await User.updateOne({ userId: d.targetId }, { isShadowBanned: false }); 
        }
    });

    // --- グローバル管理者コマンド (OWNER用) ---
    socket.on('admin global command', async (d) => {
        const o = await User.findOne({ userId: d.myId }).lean();
        if (o && o.role === 'OWNER') {
            if (d.type === 'clearall') { 
                await Message.deleteMany({}); 
                io.emit('clear all messages'); 
            }
            else if (d.type === 'kickall') { 
                io.emit('force logout'); 
            }
        }
    });

    socket.on('update color', async (data) => {
        await User.updateOne({ userId: data.userId }, { nameColor: data.color });
    });

    socket.on('disconnect', () => io.emit('online count', io.engine.clientsCount));
});

server.listen(process.env.PORT || 10000, () => console.log("🚀 Server Ready"));

