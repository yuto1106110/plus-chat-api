from flask import Flask, request, jsonify, session
from flask_socketio import SocketIO, emit
from flask_sqlalchemy import SQLAlchemy
from flask_cors import CORS
from datetime import datetime
import os

app = Flask(__name__)
app.config['SECRET_KEY'] = 'super-secret-key'

# 保存先をカレントディレクトリに固定
basedir = os.path.abspath(os.path.dirname(__file__))
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///' + os.path.join(basedir, 'chat_v2.db')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# CORS設定
CORS(app, supports_credentials=True, origins="*")

db = SQLAlchemy(app)
socketio = SocketIO(app, cors_allowed_origins="*", manage_session=False)

# ユーザーモデル
class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(20), unique=True, nullable=False)
    password = db.Column(db.String(20), nullable=False)

# 履歴（50件）
messages_log = []

# --- 修正ポイント：データベース作成をより安全に ---
def init_db():
    with app.app_context():
        db.create_all()

init_db()

@app.route('/')
def index():
    return "Chat API is running."

@app.route('/healthcheck')
def healthcheck():
    return 'OK', 200

@app.route('/api/auth', methods=['POST'])
def auth():
    try:
        # JSONが正しく届いているかチェック
        data = request.get_json()
        if not data:
            return jsonify({"success": False, "message": "データが空です"}), 400
            
        username = data.get('username')
        password = data.get('password')
        mode = data.get('mode')

        # データベース操作
        user = User.query.filter_by(username=username).first()

        if mode == 'register':
            if user:
                return jsonify({"success": False, "message": "この名前は既に存在します"}), 400
            new_user = User(username=username, password=password)
            db.session.add(new_user)
            db.session.commit()
            return jsonify({"success": True, "username": username})
        else:
            if user and user.password == password:
                return jsonify({"success": True, "username": username})
            return jsonify({"success": False, "message": "名前またはパスワードが違います"}), 401
            
    except Exception as e:
        db.session.rollback() # エラー時はロールバック
        print(f"DATABASE ERROR: {str(e)}")
        return jsonify({"success": False, "message": "サーバーエラーが発生しました"}), 500

@socketio.on('connect')
def handle_connect():
    emit('load_history', messages_log)

@socketio.on('send_message')
def handle_message(data):
    data['time'] = datetime.now().strftime("%H:%M")
    messages_log.append(data)
    if len(messages_log) > 50:
        messages_log.pop(0)
    emit('receive_message', data, broadcast=True)

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host='0.0.0.0', port=port)
