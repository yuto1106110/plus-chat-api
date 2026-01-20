from flask import Flask
from flask_socketio import SocketIO, emit

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

# 過去のメッセージを保存するリスト
messages_log = []

@socketio.on('connect')
def handle_connect():
    # 新しく接続した人にだけ、これまでのログをすべて送る
    emit('load_history', messages_log)

@socketio.on('send_message')
def handle_message(data):
    # ログにメッセージを追加（最大100件とかに制限すると軽い）
    messages_log.append(data)
    if len(messages_log) > 100:
        messages_log.pop(0)
        
    # 全員にメッセージを転送
    emit('receive_message', data, broadcast=True)

if __name__ == '__main__':
    import os
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host='0.0.0.0', port=port)
