from flask import Flask
from flask_socketio import SocketIO, emit

app = Flask(__name__)
# CORSを許可して、Vercelなどの外部サイトからの接続を受け入れる
socketio = SocketIO(app, cors_allowed_origins="*")

@socketio.on('send_message')
def handle_message(data):
    # 受け取ったメッセージを全員にそのまま転送
    emit('receive_message', data, broadcast=True)

if __name__ == '__main__':
    # Renderのポートに合わせて起動
    import os
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host='0.0.0.0', port=port)

@app.route('/healthcheck')
def healthcheck():
    return 'OK', 200