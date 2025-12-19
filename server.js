const express = require('express');
const https = require('https');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const os = require('os');
const fs = require('fs');

const app = express();

// Try to use HTTPS if certificates exist, fallback to HTTP
let server;
let protocol = 'http';
try {
  const options = {
    key: fs.readFileSync(path.join(__dirname, 'server.key')),
    cert: fs.readFileSync(path.join(__dirname, 'server.cert'))
  };
  server = https.createServer(options, app);
  protocol = 'https';
  console.log('✅ HTTPS enabled - Encrypted signaling connection');
} catch (err) {
  server = http.createServer(app);
  console.log('⚠️  Using HTTP - Run setup for HTTPS encryption');
}

const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Serve static files
app.use(express.static('public'));

// Store active rooms
const rooms = new Map();

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Create or join a room
  socket.on('create-room', (callback) => {
    const roomCode = generateRoomCode();
    socket.join(roomCode);
    rooms.set(roomCode, { sender: socket.id, receiver: null });
    console.log(`Room created: ${roomCode}`);
    callback({ roomCode });
  });

  socket.on('join-room', (roomCode, callback) => {
    const room = rooms.get(roomCode);
    if (room && !room.receiver) {
      socket.join(roomCode);
      room.receiver = socket.id;
      console.log(`Client joined room: ${roomCode}`);
      
      // Notify sender that receiver has joined
      io.to(room.sender).emit('receiver-joined');
      callback({ success: true });
    } else {
      callback({ success: false, error: 'Room not found or already full' });
    }
  });

  // WebRTC signaling
  socket.on('offer', (roomCode, offer) => {
    socket.to(roomCode).emit('offer', offer);
  });

  socket.on('answer', (roomCode, answer) => {
    socket.to(roomCode).emit('answer', answer);
  });

  socket.on('ice-candidate', (roomCode, candidate) => {
    socket.to(roomCode).emit('ice-candidate', candidate);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    // Wait a bit before notifying peer disconnection (mobile file picker grace period)
    setTimeout(() => {
      // Clean up rooms
      for (const [roomCode, room] of rooms.entries()) {
        if (room.sender === socket.id || room.receiver === socket.id) {
          // Only emit if room still exists (user didn't reconnect)
          if (rooms.has(roomCode)) {
            io.to(roomCode).emit('peer-disconnected');
            rooms.delete(roomCode);
          }
        }
      }
    }, 5000); // 5 second delay before notifying
  });
});

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Get local IP address
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log('\n🚀 P2P File Share Server Running!\n');
  console.log(`Local:   ${protocol}://localhost:${PORT}`);
  console.log(`Network: ${protocol}://${localIP}:${PORT}`);
  
  console.log('\n🔒 SECURITY STATUS:');
  console.log(`   Signaling: ${protocol === 'https' ? '✅ ENCRYPTED (HTTPS/WSS)' : '⚠️  UNENCRYPTED (HTTP/WS)'}`);
  console.log(`   File Transfer: ✅ ENCRYPTED (WebRTC DTLS)`);
  console.log(`   Connection: ✅ Peer-to-Peer (Files never touch server)`);
  
  console.log('\n📱 To access from mobile:');
  console.log(`   1. Make sure mobile is on same WiFi`);
  console.log(`   2. Open: ${protocol}://${localIP}:${PORT}`);
  if (protocol === 'https') {
    console.log(`   3. Accept security warning (self-signed certificate)`);
  }
  console.log('\n💡 If mobile can\'t connect, check firewall:');
  console.log('   macOS: System Settings → Network → Firewall → Allow Node.js\n');
});
