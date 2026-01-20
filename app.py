from flask import Flask, request, jsonify, session
from flask_socketio import SocketIO, emit
from flask_sqlalchemy import SQLAlchemy
from flask_cors import CORS
from datetime import datetime
import os

app = Flask(__name__)
app.config['SECRET_KEY'] = 'super-secret-key'
# データベースの設定
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///chat_v2.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# Vercelなどのフロントエンドからの接続を許可する設定
CORS(app, supports_credentials=True)

db = SQLAlchemy(app)
socketio = SocketIO(app, cors_allowed_origins="*", manage_session=False)

# ユーザーデータベースの定義
class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(20), unique=True, nullable=False)
    password = db.Column(db.String(20), nullable=False)

# メッセージ履歴（最新50件）
messages_log = []

# データベースの自動作成
with app.app_context():
    db.create_all()

# --- ここからが足りなかったルート設定 ---

@app.route('/')
def index():
    return "Chat API is running."

@app.route('/healthcheck')
def healthcheck():
    return 'OK', 200

# --- ログイン・登録機能 ---

@app.route('/api/auth', methods=['POST'])
def auth():
    data = request.json
    username = data.get('username')
    password = data.get('password')
    mode = data.get('mode') # 'login' か 'register'

    user = User.query.filter_by(username=username).first()

    if mode == 'register':
        if user:
            return jsonify({"success": False, "message": "この名前は既に存在します"}), 400
        new_user = User(username=username, password=password)
        db.session.add(new_user)
        db.session.commit()
        return jsonify({"success": True, "username": username})

    else: # login
        if user and user.password == password:
            return jsonify({"success": True, "username": username})
        return jsonify({"success": False, "message": "名前またはパスワードが違います"}), 401

# --- Socket.IO (チャット本体) ---

@socketio.on('connect')
def handle_connect():
    emit('load_history', messages_log)

@socketio.on('send_message')
def handle_message(data):
    # タイムスタンプを追加
    data['time'] = datetime.now().strftime("%H:%M")
    
    messages_log.append(data)
    # 50件制限
    if len(messages_log) > 50:
        messages_log.pop(0)
    
    emit('receive_message', data, broadcast=True)

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host='0.0.0.0', port=port)
