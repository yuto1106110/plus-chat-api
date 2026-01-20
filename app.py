import os
import time
from datetime import datetime, timedelta, timezone
from flask import Flask, request, jsonify
from flask_socketio import SocketIO, emit
from flask_sqlalchemy import SQLAlchemy
from flask_cors import CORS

# タイムゾーンを日本時間に設定
os.environ['TZ'] = 'Asia/Tokyo'
if hasattr(time, 'tzset'):
    time.tzset()

app = Flask(__name__)
app.config['SECRET_KEY'] = 'super-secret-key'

# データベースの保存先（Renderで許可される/tmpを使用）
db_path = os.path.join('/tmp', 'chat_v2.db')
app.config['SQLALCHEMY_DATABASE_URI'] = f'sqlite:///{db_path}'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

CORS(app, supports_credentials=True, origins="*")

db = SQLAlchemy(app)
socketio = SocketIO(app, cors_allowed_origins="*", manage_session=False)

# ユーザーモデル
class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(20), unique=True, nullable=False)
    password = db.Column(db.String(20), nullable=False)

# メッセージ履歴
messages_log = []

with app.app_context():
    db.create_all()

@app.route('/')
def index():
    return "Chat API is running (Security Enhanced)."


@app.route('/healthcheck')

def healthcheck():

    return 'OK', 200

@app.route('/api/auth', methods=['POST'])
def auth():
    try:
        data = request.get_json()
        if not data:
            return jsonify({"success": False, "message": "データが空です"}), 400
            
        username = data.get('username', '').strip()
        password = data.get('password', '').strip()
        mode = data.get('mode')

        # 【強化】バリデーション
        if len(username) < 2:
            return jsonify({"success": False, "message": "名前は2文字以上にしてください"}), 400
        if len(password) < 4:
            return jsonify({"success": False, "message": "パスワードは4文字以上にしてください"}), 400

        user = User.query.filter_by(username=username).first()

        if mode == 'register':
            if user:
                return jsonify({"success": False, "message": "この名前は既に使われています"}), 400
            new_user = User(username=username, password=password)
            db.session.add(new_user)
            db.session.commit()
            return jsonify({"success": True, "username": username})
        else:
            if user and user.password == password:
                return jsonify({"success": True, "username": username})
            return jsonify({"success": False, "message": "名前またはパスワードが違います"}), 401
    except Exception as e:
        db.session.rollback()
        return jsonify({"success": False, "message": "サーバーエラー"}), 500

@socketio.on('connect')
def handle_connect():
    emit('load_history', messages_log)

@socketio.on('send_message')
def handle_message(data):
    # 日本時間でタイムスタンプ作成
    jst = timezone(timedelta(hours=+9))
    data['time'] = datetime.now(jst).strftime("%H:%M")
    
    messages_log.append(data)
    if len(messages_log) > 50:
        messages_log.pop(0)
    emit('receive_message', data, broadcast=True)

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host='0.0.0.0', port=port)
