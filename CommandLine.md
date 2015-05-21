cd mpegts_stream/server
node stream-server.js live

ffmpeg -re -i <filename> -f mpegts -tune zerolatency -fflags nobuffer -vcodec copy -an udp://224.0.0.1:6785

Open in browser: websocket_mpegts_demo.html
