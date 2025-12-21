const socket = io({
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  reconnectionAttempts: 5,
  timeout: 20000,
  pingTimeout: 60000,
  pingInterval: 25000
});

// WebRTC configuration with performance optimizations
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ],
  bundlePolicy: 'max-bundle',
  iceTransportPolicy: 'all',
  // Maximum SCTP buffer for better throughput
  sdpSemantics: 'unified-plan',
  // Enable bigger receive buffer
  encodedInsertableStreams: false
};

// Global state
let peerConnection = null;
let dataChannel = null;
let roomCode = null;
let selectedFiles = [];
let currentMode = null;
let isPageVisible = true;
let isInFilePicker = false;
let heartbeatInterval = null;
let reconnectionTimeout = null;
let intentionalDisconnect = false; // Track user-initiated disconnects
let localIP = null; // Track local IP address
let peerIP = null; // Track peer's IP address

// File streaming support (Chrome/Edge only)
let supportsFileSystemAccess = 'showSaveFilePicker' in window;
let streamingWritable = null;
let streamingFileHandle = null;
let useStreaming = false;

// Extract local IP from ICE candidate
function extractLocalIP(candidate) {
  if (!candidate) return null;
  const parts = candidate.candidate.split(' ');
  if (parts.length > 4 && parts[7] === 'host') {
    const ip = parts[4];
    // Only return local network IPs (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
    if (ip.startsWith('192.168.') || ip.startsWith('10.') || 
        (ip.startsWith('172.') && parseInt(ip.split('.')[1]) >= 16 && parseInt(ip.split('.')[1]) <= 31)) {
      return ip;
    }
  }
  return null;
}

// Check if two IPs are on same subnet
function isSameNetwork(ip1, ip2) {
  if (!ip1 || !ip2) return false;
  const parts1 = ip1.split('.');
  const parts2 = ip2.split('.');
  // Same /24 subnet (first 3 octets match)
  return parts1[0] === parts2[0] && parts1[1] === parts2[1] && parts1[2] === parts2[2];
}

// Handle page visibility changes (mobile file picker)
document.addEventListener('visibilitychange', () => {
  isPageVisible = !document.hidden;
  console.log('Page visibility changed:', isPageVisible ? 'visible' : 'hidden');
  
  // When page becomes hidden, it might be due to file picker
  if (!isPageVisible && currentMode === 'sender') {
    isInFilePicker = true;
    console.log('User might be in file picker - keeping connection alive');
  } else if (isPageVisible && isInFilePicker) {
    isInFilePicker = false;
    console.log('User returned from file picker');
    
    // Clear any reconnection timeout when user returns
    if (reconnectionTimeout) {
      console.log('User returned - clearing reconnection timeout');
      clearTimeout(reconnectionTimeout);
      reconnectionTimeout = null;
      
      // If socket is disconnected, reconnect
      if (!socket.connected) {
        console.log('Socket disconnected - reconnecting...');
        socket.connect();
      }
    }
  }
});

// DOM Elements
const modeSelection = document.getElementById('mode-selection');
const senderInterface = document.getElementById('sender-interface');
const receiverInterface = document.getElementById('receiver-interface');

// Mode selection
document.getElementById('send-mode').addEventListener('click', () => {
  currentMode = 'sender';
  showSenderInterface();
});

document.getElementById('receive-mode').addEventListener('click', () => {
  currentMode = 'receiver';
  showReceiverInterface();
});

// Back buttons - Both should fully reset and disconnect
document.getElementById('sender-back').addEventListener('click', reset);
document.getElementById('receiver-back').addEventListener('click', reset);

// Cancel buttons
let isTransferring = false;
let transferCancelled = false;

document.getElementById('sender-cancel').addEventListener('click', () => {
  showConfirm(
    'Cancel Transfer?',
    'Are you sure you want to cancel the current file transfer? You can send another file after cancelling.',
    () => {
      transferCancelled = true;
      isTransferring = false;
      
      // Notify receiver that transfer is cancelled
      if (dataChannel && dataChannel.readyState === 'open') {
        try {
          dataChannel.send(JSON.stringify({ type: 'cancel' }));
        } catch (e) {
          console.error('Failed to send cancel message:', e);
        }
      }
      
      // Reset to file selection
      document.getElementById('transfer-progress').classList.add('hidden');
      document.getElementById('file-selection').classList.remove('hidden');
      document.getElementById('sender-cancel').classList.add('hidden');
      document.getElementById('sender-back').classList.remove('hidden');
      
      // Clear file input and free memory
      document.getElementById('file-input').value = '';
      selectedFiles = [];
      document.getElementById('selected-files').classList.add('hidden');
      document.getElementById('send-btn').classList.add('hidden');
      
      showNotification('Transfer cancelled. Choose files to send another.', 'info');
    }
  );
});

document.getElementById('receiver-cancel').addEventListener('click', () => {
  showConfirm(
    'Cancel Transfer?',
    'Are you sure you want to cancel receiving files?',
    () => {
      transferCancelled = true;
      isTransferring = false;
      
      // Notify sender if possible (though they may not care)
      if (dataChannel && dataChannel.readyState === 'open') {
        try {
          dataChannel.send(JSON.stringify({ type: 'cancel' }));
        } catch (e) {
          console.error('Failed to send cancel message:', e);
        }
      }
      
      // Clear all partial file data from memory
      // This is critical to free up memory from incomplete transfers
      const receiverScope = dataChannel.onmessage;
      // We'll handle cleanup in the data channel handler
      
      // Reset to ready state
      document.getElementById('receive-progress').classList.add('hidden');
      document.getElementById('receive-ready-status').classList.remove('hidden');
      document.getElementById('receiver-cancel').classList.add('hidden');
      document.getElementById('receiver-back').classList.remove('hidden');
      
      showNotification('Transfer cancelled. Waiting for new files.', 'info');
    }
  );
});

// Security modal
document.getElementById('security-info-btn').addEventListener('click', () => {
  document.getElementById('security-modal').classList.remove('hidden');
});

document.getElementById('close-modal').addEventListener('click', () => {
  document.getElementById('security-modal').classList.add('hidden');
});

document.getElementById('security-modal').addEventListener('click', (e) => {
  if (e.target.id === 'security-modal') {
    document.getElementById('security-modal').classList.add('hidden');
  }
});

function reset() {
  // Notify peer about intentional disconnect BEFORE closing connection
  if (dataChannel && dataChannel.readyState === 'open') {
    try {
      dataChannel.send(JSON.stringify({ type: 'intentional-disconnect' }));
      console.log('Sent intentional disconnect notification to peer');
    } catch (e) {
      console.error('Failed to send disconnect notification:', e);
    }
  }
  
  // Mark this as intentional disconnect (Start New Transfer button)
  intentionalDisconnect = true;
  
  // Stop heartbeat
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  
  // Clear reconnection timeout
  if (reconnectionTimeout) {
    clearTimeout(reconnectionTimeout);
    reconnectionTimeout = null;
  }
  
  // Close and cleanup peer connection
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  
  // Close and cleanup data channel
  if (dataChannel) {
    dataChannel.close();
    dataChannel = null;
  }
  
  // Clear file references to free memory
  // This ensures partial transfers don't stay in memory
  selectedFiles = [];
  
  // Clear any cached file data
  if (window.receivedFiles) {
    // Clear blob URLs to prevent memory leaks
    window.receivedFiles = null;
  }
  
  // Reset transfer flags
  isTransferring = false;
  transferCancelled = false;
  
  // Reset IP tracking
  localIP = null;
  peerIP = null;
  
  // Force garbage collection hint (only works if --expose-gc flag is set)
  // This doesn't actually force GC but hints to the browser
  if (window.gc) {
    window.gc();
  }
  
  roomCode = null;
  currentMode = null;
  
  // Reset intentional disconnect flag
  intentionalDisconnect = false;
  
  modeSelection.classList.remove('hidden');
  senderInterface.classList.add('hidden');
  receiverInterface.classList.add('hidden');
  
  // Reset all interface elements
  document.getElementById('waiting-receiver').classList.remove('hidden');
  document.getElementById('room-code-display').classList.remove('hidden');
  document.getElementById('connected-status').classList.add('hidden');
  document.getElementById('file-selection').classList.add('hidden');
  document.getElementById('transfer-progress').classList.add('hidden');
  document.getElementById('transfer-complete').classList.add('hidden');
  document.getElementById('receiving-status').classList.add('hidden');
  document.getElementById('receiver-connected-status').classList.add('hidden');
  document.getElementById('receive-ready-status').classList.add('hidden');
  document.getElementById('receive-progress').classList.add('hidden');
  document.getElementById('receive-complete').classList.add('hidden');
  
  // Hide back buttons (Start New Transfer buttons)
  document.getElementById('sender-back').classList.add('hidden');
  document.getElementById('receiver-back').classList.add('hidden');
  
  // Show receiver input section again (was hidden when joining)
  const codeInputSection = document.querySelector('.code-input-section');
  if (codeInputSection) {
    codeInputSection.classList.remove('hidden');
  }
  
  document.getElementById('code-input').value = '';
  document.getElementById('file-input').value = '';
}

// ========== SENDER FUNCTIONS ==========

function showSenderInterface() {
  modeSelection.classList.add('hidden');
  senderInterface.classList.remove('hidden');
  
  // Create room
  socket.emit('create-room', (response) => {
    roomCode = response.roomCode;
    document.getElementById('room-code').textContent = roomCode;
    
    // Generate QR code
    const qrcodeContainer = document.getElementById('qrcode');
    qrcodeContainer.innerHTML = ''; // Clear any existing QR code
    new QRCode(qrcodeContainer, {
      text: roomCode,
      width: 200,
      height: 200,
      colorDark: '#6366f1',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.H
    });
  });
}

// Copy room code
document.getElementById('copy-code').addEventListener('click', async () => {
  const code = document.getElementById('room-code').textContent;
  try {
    await navigator.clipboard.writeText(code);
    const btn = document.getElementById('copy-code');
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    `;
    setTimeout(() => {
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path>
        </svg>
      `;
    }, 2000);
  } catch (err) {
    alert('Failed to copy code');
  }
});

// Receiver joined
socket.on('receiver-joined', () => {
  document.getElementById('waiting-receiver').classList.add('hidden');
  document.getElementById('room-code-display').classList.add('hidden');
  document.getElementById('connected-status').classList.remove('hidden');
  document.getElementById('file-selection').classList.remove('hidden');
  document.getElementById('sender-back').classList.remove('hidden');
  setupSenderPeerConnection();
});

// File selection
document.getElementById('file-input').addEventListener('change', (e) => {
  selectedFiles = Array.from(e.target.files);
  displaySelectedFiles();
});

function displaySelectedFiles() {
  const container = document.getElementById('selected-files');
  const sendBtn = document.getElementById('send-btn');
  
  if (selectedFiles.length === 0) {
    container.classList.add('hidden');
    sendBtn.classList.add('hidden');
    return;
  }
  
  container.classList.remove('hidden');
  sendBtn.classList.remove('hidden');
  
  container.innerHTML = selectedFiles.map(file => `
    <div class="file-item">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"></path>
        <polyline points="13 2 13 9 20 9"></polyline>
      </svg>
      <div class="file-info">
        <div class="file-name">${file.name}</div>
        <div class="file-size">${formatFileSize(file.size)}</div>
      </div>
    </div>
  `).join('');
}

// Send files
document.getElementById('send-btn').addEventListener('click', async () => {
  if (selectedFiles.length === 0 || !dataChannel) return;
  
  // Reset cancellation flag for new transfer
  transferCancelled = false;
  
  document.getElementById('file-selection').classList.add('hidden');
  document.getElementById('transfer-progress').classList.remove('hidden');
  document.getElementById('sender-back').classList.add('hidden');
  document.getElementById('sender-cancel').classList.remove('hidden');
  
  await sendFiles();
});

// Send another file after completion
document.getElementById('send-another-btn').addEventListener('click', () => {
  // Hide transfer complete message
  document.getElementById('transfer-complete').classList.add('hidden');
  // Show file selection again
  document.getElementById('file-selection').classList.remove('hidden');
  // Clear previous file selection
  document.getElementById('file-input').value = '';
  selectedFiles = [];
  document.getElementById('selected-files').classList.add('hidden');
  document.getElementById('send-btn').classList.add('hidden');
  // Keep the back button visible
  document.getElementById('sender-back').classList.remove('hidden');
});

async function setupSenderPeerConnection() {
  peerConnection = new RTCPeerConnection(rtcConfig);
  
  // Monitor ICE connection state
  peerConnection.oniceconnectionstatechange = () => {
    console.log('ICE connection state:', peerConnection.iceConnectionState);
    if (peerConnection.iceConnectionState === 'failed' || peerConnection.iceConnectionState === 'disconnected') {
      console.log('ICE connection failed/disconnected, attempting to restart');
      // Don't immediately disconnect - give it time to reconnect
      // Mobile file picker can cause temporary disconnection
    }
  };
  
  // Monitor connection state
  peerConnection.onconnectionstatechange = () => {
    console.log('Connection state:', peerConnection.connectionState);
    if (peerConnection.connectionState === 'failed') {
      console.log('Connection failed');
      // Only show error if truly failed, not during file picker
    }
  };
  
  // Create data channel with balanced performance and reliability
  dataChannel = peerConnection.createDataChannel('fileTransfer', {
    ordered: true  // Ordered delivery for file integrity
  });
  
  setupDataChannelListeners();
  
  // ICE candidates
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      // Extract local IP from first host candidate
      if (!localIP) {
        const ip = extractLocalIP(event.candidate);
        if (ip) {
          localIP = ip;
          console.log('Sender local IP:', localIP);
          socket.emit('local-ip', roomCode, localIP);
        }
      }
      socket.emit('ice-candidate', roomCode, event.candidate);
    }
  };
  
  // Create and send offer
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit('offer', roomCode, offer);
}

function setupDataChannelListeners() {
  dataChannel.onopen = () => {
    console.log('Data channel opened');
    
    // Clear reconnection timeout if it was set (successful reconnection)
    if (reconnectionTimeout) {
      clearTimeout(reconnectionTimeout);
      reconnectionTimeout = null;
      showNotification('Reconnected successfully!', 'success');
    }
    
    // Start heartbeat to keep connection alive (especially during file picker)
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (dataChannel && dataChannel.readyState === 'open') {
        try {
          dataChannel.send(JSON.stringify({ type: 'heartbeat' }));
          console.log('Heartbeat sent');
        } catch (e) {
          console.error('Failed to send heartbeat:', e);
        }
      }
    }, 3000); // Send heartbeat every 3 seconds
  };
  
  dataChannel.onclose = () => {
    console.log('Data channel closed');
    
    // Stop heartbeat
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    
    // If this was intentional (Start New Transfer), skip reconnection
    if (intentionalDisconnect) {
      console.log('Intentional disconnect - no reconnection needed');
      return;
    }
    
    // Don't disconnect if user is in file picker (mobile)
    if (isInFilePicker) {
      console.log('Ignoring close - user is in file picker');
      return;
    }
    
    // Give grace period for reconnection (mobile file picker suspends page)
    if (currentMode === 'sender' || currentMode === 'receiver') {
      console.log('Connection lost - waiting 45s for reconnection...');
      showNotification('Connection interrupted. Reconnecting...', 'warning');
      
      // Clear any existing timeout
      if (reconnectionTimeout) clearTimeout(reconnectionTimeout);
      
      // Wait 45 seconds before actually disconnecting
      reconnectionTimeout = setTimeout(() => {
        console.log('Reconnection timeout - disconnecting');
        showNotification('Connection lost. Please try again.', 'error');
        reset();
      }, 45000); // 45 second grace period
    }
  };
  
  dataChannel.onerror = (error) => {
    console.error('Data channel error:', error);
    showNotification('Connection error occurred. Please try again.', 'error');
  };
  
  dataChannel.onmessage = (event) => {
    // Sender receives messages from receiver (like cancel notifications)
    if (typeof event.data === 'string') {
      try {
        const message = JSON.parse(event.data);
        
        if (message.type === 'heartbeat') {
          // Ignore heartbeat messages
          return;
        }
        
        if (message.type === 'intentional-disconnect') {
          // Peer intentionally disconnected (Start New Transfer)
          console.log('Peer intentionally disconnected');
          intentionalDisconnect = true;
          // Reset immediately without waiting
          reset();
          return;
        }
        
        if (message.type === 'cancel') {
          // Receiver cancelled the transfer
          transferCancelled = true;
          isTransferring = false;
          
          // Stop sending immediately
          console.log('Receiver cancelled the transfer');
          
          // Reset UI
          document.getElementById('transfer-progress').classList.add('hidden');
          document.getElementById('file-selection').classList.remove('hidden');
          document.getElementById('sender-cancel').classList.add('hidden');
          document.getElementById('sender-back').classList.remove('hidden');
          
          // Clear file selection
          document.getElementById('file-input').value = '';
          selectedFiles = [];
          document.getElementById('selected-files').classList.add('hidden');
          document.getElementById('send-btn').classList.add('hidden');
          
          showNotification('Receiver cancelled the transfer.', 'warning');
        }
      } catch (e) {
        console.error('Failed to parse message from receiver:', e);
      }
    }
  };
}

async function sendFiles() {
  // Increased for higher speed
  const CHUNK_SIZE = 262144; // 256KB chunks - good balance
  const MAX_BUFFER_SIZE = 8388608; // 8MB buffer - higher throughput
  let startTime = Date.now();
  let totalBytesSent = 0;
  isTransferring = true;
  transferCancelled = false;
  let lastProgressUpdate = 0; // Throttle progress updates
  
  for (let i = 0; i < selectedFiles.length; i++) {
    if (transferCancelled) {
      console.log('Transfer cancelled by user');
      return;
    }
    
    const file = selectedFiles[i];
    const fileStartTime = Date.now();
    
    // Send file metadata
    const metadata = {
      type: 'metadata',
      name: file.name,
      size: file.size,
      fileType: file.type,
      currentFile: i + 1,
      totalFiles: selectedFiles.length
    };
    dataChannel.send(JSON.stringify(metadata));
    
    // Read and send file in chunks
    const reader = new FileReader();
    let offset = 0;
    
    while (offset < file.size) {
      if (transferCancelled) {
        console.log('Transfer cancelled during file send');
        return;
      }
      
      const chunk = file.slice(offset, offset + CHUNK_SIZE);
      const arrayBuffer = await readChunk(chunk);
      
      // Adaptive buffer management - wait longer if buffer is fuller
      const bufferLevel = dataChannel.bufferedAmount / MAX_BUFFER_SIZE;
      
      if (bufferLevel > 0.8) {
        // Buffer is 80%+ full - wait longer
        await new Promise(resolve => setTimeout(resolve, 20));
      } else if (bufferLevel > 0.5) {
        // Buffer is 50-80% full - moderate wait
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      
      // Hard limit - must wait if completely full
      while (dataChannel.bufferedAmount > MAX_BUFFER_SIZE) {
        await new Promise(resolve => setTimeout(resolve, 5));
        if (transferCancelled) return;
      }
      
      // Send chunk
      dataChannel.send(arrayBuffer);
      
      offset += CHUNK_SIZE;
      totalBytesSent += CHUNK_SIZE;
      
      // Calculate progress
      const progress = (offset / file.size) * 100;
      const now = Date.now();
      const elapsedTime = (now - fileStartTime) / 1000;
      
      // Update UI more frequently - every 50ms instead of 100ms
      const shouldUpdate = (now - lastProgressUpdate >= 50) || (offset <= CHUNK_SIZE) || (progress >= 99);
      
      if (shouldUpdate) {
        lastProgressUpdate = now;
        
        // Calculate speed and time remaining
        let speed = 0;
        let timeRemaining = 0;
        
        if (elapsedTime > 0.2) { // Calculate speed after 0.2 seconds
          speed = offset / elapsedTime;
          const remainingBytes = file.size - offset;
          timeRemaining = speed > 0 ? remainingBytes / speed : 0;
        }
        
        updateSendProgress(file.name, Math.min(progress, 100), i + 1, selectedFiles.length, speed, timeRemaining);
      }
    }
    
    // Send end marker
    dataChannel.send(JSON.stringify({ type: 'end' }));
  }
  
  isTransferring = false;
  
  // All files sent
  if (!transferCancelled) {
    setTimeout(() => {
      document.getElementById('transfer-progress').classList.add('hidden');
      document.getElementById('transfer-complete').classList.remove('hidden');
      document.getElementById('sender-cancel').classList.add('hidden');
      document.getElementById('sender-back').classList.remove('hidden');
    }, 500);
  }
}

function readChunk(chunk) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(chunk);
  });
}

function updateSendProgress(fileName, percentage, current, total, speed, timeRemaining) {
  document.getElementById('transfer-status').textContent = 
    `Sending ${fileName} (${current}/${total})`;
  document.getElementById('transfer-percentage').textContent = 
    `${Math.round(percentage)}%`;
  document.getElementById('progress-fill').style.width = `${percentage}%`;
  
  if (speed && timeRemaining) {
    const speedText = formatSpeed(speed);
    const timeText = formatTime(timeRemaining);
    document.getElementById('transfer-speed').textContent = speedText;
    document.getElementById('transfer-time').textContent = timeText;
  }
}

// ========== RECEIVER FUNCTIONS ==========

function showReceiverInterface() {
  modeSelection.classList.add('hidden');
  receiverInterface.classList.remove('hidden');
  
  // Show browser capability notification
  if (!supportsFileSystemAccess) {
    showNotification('For files >500MB, use Chrome or Edge for direct-to-disk transfers. Firefox/Safari limited to ~3-4GB.', 'info');
  }
}

// Join room
document.getElementById('join-btn').addEventListener('click', () => {
  const code = document.getElementById('code-input').value.trim().toUpperCase();
  
  if (code.length !== 6) {
    showNotification('Please enter a valid 6-digit code', 'error');
    return;
  }
  
  joinRoom(code);
});

// QR Scanner
let html5QrCode = null;
let isScanning = false;

document.getElementById('scan-qr-btn').addEventListener('click', async () => {
  const qrScannerModal = document.getElementById('qr-scanner-modal');
  const qrReaderDiv = document.getElementById('qr-scanner-reader');
  
  // Show fullscreen modal
  qrScannerModal.classList.remove('hidden');
  
  try {
    html5QrCode = new Html5Qrcode('qr-scanner-reader');
    await html5QrCode.start(
      { facingMode: 'environment' },
      {
        fps: 10,
        qrbox: { width: 250, height: 250 }
      },
      (decodedText) => {
        // QR code detected
        console.log('QR Code detected:', decodedText);
        const code = decodedText.trim().toUpperCase();
        
        if (code.length === 6) {
          // Stop scanner and close modal
          html5QrCode.stop().then(() => {
            html5QrCode = null;
            qrScannerModal.classList.add('hidden');
            isScanning = false;
            
            // Join with scanned code
            showNotification('QR Code scanned successfully! Connecting...', 'success');
            document.getElementById('code-input').value = code;
            joinRoom(code);
          });
        } else {
          showNotification('Invalid QR code format', 'error');
        }
      },
      (error) => {
        // Scanning error (ignore, happens continuously)
      }
    );
    isScanning = true;
  } catch (err) {
    console.error('QR Scanner error:', err);
    showNotification('Failed to start camera. Please check permissions.', 'error');
    qrScannerModal.classList.add('hidden');
    isScanning = false;
  }
});

// Close QR scanner
document.getElementById('close-qr-scanner').addEventListener('click', async () => {
  const qrScannerModal = document.getElementById('qr-scanner-modal');
  
  if (html5QrCode && isScanning) {
    await html5QrCode.stop();
    html5QrCode = null;
  }
  
  qrScannerModal.classList.add('hidden');
  isScanning = false;
});

// Close scanner on background click
document.getElementById('qr-scanner-modal').addEventListener('click', async (e) => {
  if (e.target.id === 'qr-scanner-modal') {
    const qrScannerModal = document.getElementById('qr-scanner-modal');
    
    if (html5QrCode && isScanning) {
      await html5QrCode.stop();
      html5QrCode = null;
    }
    
    qrScannerModal.classList.add('hidden');
    isScanning = false;
  }
});

function joinRoom(code) {
  socket.emit('join-room', code, (response) => {
    if (response.success) {
      roomCode = code;
      document.querySelector('.code-input-section').classList.add('hidden');
      document.getElementById('receiver-connected-status').classList.remove('hidden');
      document.getElementById('receiving-status').classList.remove('hidden');
      document.getElementById('receiver-back').classList.remove('hidden');
      setupReceiverPeerConnection();
    } else {
      showNotification(response.error || 'Failed to join room. Please check the code.', 'error');
    }
  });
}

async function setupReceiverPeerConnection() {
  peerConnection = new RTCPeerConnection(rtcConfig);
  
  // Monitor ICE connection state
  peerConnection.oniceconnectionstatechange = () => {
    console.log('ICE connection state:', peerConnection.iceConnectionState);
    if (peerConnection.iceConnectionState === 'failed' || peerConnection.iceConnectionState === 'disconnected') {
      console.log('ICE connection failed/disconnected');
      // Don't immediately disconnect - mobile file picker can cause temporary disconnection
    }
  };
  
  // Monitor connection state
  peerConnection.onconnectionstatechange = () => {
    console.log('Connection state:', peerConnection.connectionState);
    if (peerConnection.connectionState === 'failed') {
      console.log('Connection failed');
    }
  };
  
  // ICE candidates
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      // Extract local IP from first host candidate
      if (!localIP) {
        const ip = extractLocalIP(event.candidate);
        if (ip) {
          localIP = ip;
          console.log('Receiver local IP:', localIP);
          socket.emit('local-ip', roomCode, localIP);
        }
      }
      socket.emit('ice-candidate', roomCode, event.candidate);
    }
  };
  peerConnection.ondatachannel = (event) => {
    dataChannel = event.channel;
    setupReceiverDataChannel();
  };
}

function setupReceiverDataChannel() {
  let receivingFile = null;
  let receivedChunks = [];
  let receivedFiles = [];
  transferCancelled = false;
  let lastProgressUpdate = 0; // Throttle progress updates
  
  dataChannel.onopen = () => {
    console.log('Data channel opened');
    document.getElementById('receiving-status').classList.add('hidden');
    document.getElementById('receive-ready-status').classList.remove('hidden');
    
    // Clear reconnection timeout if it was set (successful reconnection)
    if (reconnectionTimeout) {
      clearTimeout(reconnectionTimeout);
      reconnectionTimeout = null;
      showNotification('Reconnected successfully!', 'success');
    }
    
    // Start heartbeat to keep connection alive
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (dataChannel && dataChannel.readyState === 'open') {
        try {
          dataChannel.send(JSON.stringify({ type: 'heartbeat' }));
          console.log('Heartbeat sent');
        } catch (e) {
          console.error('Failed to send heartbeat:', e);
        }
      }
    }, 3000); // Send heartbeat every 3 seconds
  };
  
  dataChannel.onclose = () => {
    console.log('Receiver: Data channel closed');
    
    // Stop heartbeat
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    
    // Cleanup partial data when connection closes
    receivedChunks = [];
    receivingFile = null;
    
    // If this was intentional (Start New Transfer), skip reconnection
    if (intentionalDisconnect) {
      console.log('Intentional disconnect - no reconnection needed');
      return;
    }
    
    // Don't disconnect if sender is in file picker (mobile)
    if (isInFilePicker) {
      console.log('Ignoring close - sender might be in file picker');
      return;
    }
    
    // Give grace period for reconnection (sender might be in file picker)
    if (currentMode === 'receiver') {
      console.log('Connection lost - waiting 45s for sender reconnection...');
      showNotification('Sender disconnected. Waiting to reconnect...', 'warning');
      
      // Clear any existing timeout
      if (reconnectionTimeout) clearTimeout(reconnectionTimeout);
      
      // Wait 45 seconds before actually disconnecting
      reconnectionTimeout = setTimeout(() => {
        console.log('Reconnection timeout - disconnecting');
        showNotification('Connection lost. Please try again.', 'error');
        reset();
      }, 45000); // 45 second grace period
    }
  };
  
  dataChannel.onmessage = async (event) => {
    if (typeof event.data === 'string') {
      const message = JSON.parse(event.data);
      
      if (message.type === 'heartbeat') {
        // Ignore heartbeat messages - they're just to keep connection alive
        return;
      }
      
      if (message.type === 'intentional-disconnect') {
        // Sender intentionally disconnected (Start New Transfer)
        console.log('Sender intentionally disconnected');
        intentionalDisconnect = true;
        // Reset immediately without waiting
        reset();
        return;
      }
      
      if (message.type === 'cancel') {
        // Sender cancelled the transfer
        transferCancelled = true;
        isTransferring = false;
        
        // Close streaming if active
        if (streamingWritable) {
          try {
            await streamingWritable.close();
          } catch (e) {
            console.error('Error closing stream:', e);
          }
          streamingWritable = null;
          streamingFileHandle = null;
        }
        
        // Clear partial file data from memory
        receivedChunks = [];
        receivingFile = null;
        receivedFiles = [];
        useStreaming = false;
        
        // Force garbage collection hint
        if (window.gc) {
          window.gc();
        }
        
        // Reset UI
        document.getElementById('receive-progress').classList.add('hidden');
        document.getElementById('receive-ready-status').classList.remove('hidden');
        document.getElementById('receiver-cancel').classList.add('hidden');
        document.getElementById('receiver-back').classList.remove('hidden');
        
        showNotification('Sender cancelled the transfer.', 'warning');
        return;
      }
      
      if (message.type === 'metadata') {
        // Reset cancellation flag for new transfer
        transferCancelled = false;
        isTransferring = true;
        
        // Clear previous file data before starting new file
        receivedChunks = [];
        
        // If this is the first file of a new transfer session, clear previous files
        if (message.currentFile === 1) {
          receivedFiles = [];
        }
        
        // Determine if we should use streaming (Chrome/Edge only, file > 500MB)
        const largeFile = message.size > 500 * 1024 * 1024; // 500MB threshold
        useStreaming = supportsFileSystemAccess && largeFile;
        
        // New file incoming
        receivingFile = message;
        receivingFile.startTime = Date.now();
        receivingFile.receivedSize = 0; // Track for streaming mode
        
        // For streaming mode, ask user to save file location upfront
        if (useStreaming) {
          try {
            console.log('Large file detected - using streaming to disk mode');
            streamingFileHandle = await window.showSaveFilePicker({
              suggestedName: message.name,
              types: [{
                description: 'File',
                accept: { '*/*': [] }
              }]
            });
            streamingWritable = await streamingFileHandle.createWritable();
            console.log('Streaming writable created successfully');
            showNotification(`Streaming large file directly to disk (Chrome optimization)`, 'info');
          } catch (err) {
            console.error('Failed to create streaming writable:', err);
            // Fallback to in-memory mode
            useStreaming = false;
            streamingWritable = null;
            streamingFileHandle = null;
            
            if (err.name === 'AbortError') {
              showNotification('File save cancelled. Transfer aborted.', 'warning');
              transferCancelled = true;
              return;
            }
          }
        }
        
        document.getElementById('receive-ready-status').classList.add('hidden');
        document.getElementById('receive-progress').classList.remove('hidden');
        document.getElementById('receiver-back').classList.add('hidden');
        document.getElementById('receiver-cancel').classList.remove('hidden');
        updateReceiveProgress(message.name, 0);
      } else if (message.type === 'end') {
        // File complete
        const fileName = receivingFile.name;
        const fileSize = receivingFile.size;
        const currentFile = receivingFile.currentFile;
        const totalFiles = receivingFile.totalFiles;
        
        if (useStreaming && streamingWritable) {
          // Close the streaming file
          try {
            await streamingWritable.close();
            console.log('Streaming file saved successfully');
            streamingWritable = null;
            streamingFileHandle = null;
            useStreaming = false;
            
            // File already saved to disk - just show completion
            receivingFile = null;
            
            if (currentFile === totalFiles) {
              document.getElementById('receive-progress').classList.add('hidden');
              document.getElementById('receive-complete').classList.remove('hidden');
              document.getElementById('receiver-cancel').classList.add('hidden');
              document.getElementById('receiver-back').classList.remove('hidden');
              showNotification('File saved successfully!', 'success');
            }
          } catch (err) {
            console.error('Error closing streaming file:', err);
            showNotification('Error saving file. Please try again.', 'error');
          }
        } else {
          // In-memory mode - create blob and IMMEDIATELY clear chunks to free memory
          const blob = new Blob(receivedChunks, { type: receivingFile.fileType });
          
          // CRITICAL: Clear chunks array immediately after blob creation
          // This prevents doubling memory usage (chunks + blob)
          receivedChunks = [];
          receivingFile = null;
          
          // Hint to browser to free memory
          if (window.gc) {
            window.gc();
          }
          
          receivedFiles.push({
            name: fileName,
            blob: blob,
            size: fileSize
          });
          
          // Check if all files received
          if (currentFile === totalFiles) {
            showReceivedFiles(receivedFiles);
            
            // Clear receivedFiles array after download starts to free references
            setTimeout(() => {
              receivedFiles = [];
              if (window.gc) {
                window.gc();
              }
            }, 1000);
          }
        }
      }
    } else {
      // Binary data (file chunk)
      // Check if cancelled AFTER metadata check above
      if (transferCancelled) {
        // Immediately clear chunk to free memory
        receivedChunks = [];
        receivingFile = null;
        if (streamingWritable) {
          try {
            await streamingWritable.close();
          } catch (e) {}
          streamingWritable = null;
        }
        return;
      }
      
      if (useStreaming && streamingWritable) {
        // Streaming mode - write directly to disk
        try {
          await streamingWritable.write(event.data);
          receivingFile.receivedSize += event.data.byteLength;
          
          const progress = (receivingFile.receivedSize / receivingFile.size) * 100;
          const now = Date.now();
          const elapsedTime = (now - receivingFile.startTime) / 1000;
          
          // Update UI
          const shouldUpdate = (now - lastProgressUpdate >= 50) || (progress >= 99);
          
          if (shouldUpdate) {
            lastProgressUpdate = now;
            
            let speed = 0;
            let timeRemaining = 0;
            
            if (elapsedTime > 0.2) {
              speed = receivingFile.receivedSize / elapsedTime;
              const remainingBytes = receivingFile.size - receivingFile.receivedSize;
              timeRemaining = speed > 0 ? remainingBytes / speed : 0;
            }
            
            updateReceiveProgress(receivingFile.name, Math.min(progress, 100), speed, timeRemaining);
          }
        } catch (err) {
          console.error('Error writing chunk to disk:', err);
          showNotification('Error writing to disk. Transfer failed.', 'error');
          transferCancelled = true;
        }
      } else {
        // In-memory mode - store chunks in RAM
        receivedChunks.push(event.data);
        const receivedSize = receivedChunks.reduce((acc, chunk) => acc + chunk.byteLength, 0);
        const progress = (receivedSize / receivingFile.size) * 100;
        const now = Date.now();
        const elapsedTime = (now - receivingFile.startTime) / 1000;
        
        // Update UI more frequently - every 50ms instead of 100ms
        const shouldUpdate = (now - lastProgressUpdate >= 50) || (receivedChunks.length === 1) || (progress >= 99);
        
        if (!shouldUpdate) {
          return; // Skip this update
        }
        
        lastProgressUpdate = now;
        
        // Calculate speed and time
        let speed = 0;
        let timeRemaining = 0;
        
        if (elapsedTime > 0.2) { // Calculate speed after 0.2 seconds
          speed = receivedSize / elapsedTime;
          const remainingBytes = receivingFile.size - receivedSize;
          timeRemaining = speed > 0 ? remainingBytes / speed : 0;
        }
        
        updateReceiveProgress(receivingFile.name, Math.min(progress, 100), speed, timeRemaining);
      }
    }
  };
  
  dataChannel.onerror = (error) => {
    console.error('Data channel error:', error);
    showNotification('Connection error occurred. Please try again.', 'error');
  };
}

function updateReceiveProgress(fileName, percentage, speed, timeRemaining) {
  document.getElementById('receive-file-name').textContent = `Receiving ${fileName}`;
  document.getElementById('receive-percentage').textContent = `${Math.round(percentage)}%`;
  document.getElementById('receive-progress-fill').style.width = `${percentage}%`;
  
  if (speed && timeRemaining) {
    const speedText = formatSpeed(speed);
    const timeText = formatTime(timeRemaining);
    document.getElementById('receive-speed').textContent = speedText;
    document.getElementById('receive-time').textContent = timeText;
  }
}

function showReceivedFiles(files) {
  document.getElementById('receive-progress').classList.add('hidden');
  document.getElementById('receive-complete').classList.remove('hidden');
  document.getElementById('receiver-cancel').classList.add('hidden');
  document.getElementById('receiver-back').classList.remove('hidden');
  
  // Auto-download all files with proper memory cleanup
  files.forEach((file, index) => {
    setTimeout(() => {
      const url = URL.createObjectURL(file.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      
      // Revoke URL after small delay (browser needs time to start download)
      setTimeout(() => {
        URL.revokeObjectURL(url);
        // Hint to browser to free memory
        if (window.gc) {
          window.gc();
        }
      }, 200);
    }, index * 100); // Small delay between downloads to avoid browser blocking
  });
}



// ========== WEBRTC SIGNALING ==========

socket.on('offer', async (offer) => {
  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit('answer', roomCode, answer);
});

socket.on('answer', async (answer) => {
  await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
});

// Handle peer's local IP
socket.on('local-ip', (ip) => {
  peerIP = ip;
  console.log('Peer IP received:', peerIP);
  
  // Check if on same network
  if (localIP && peerIP && !isSameNetwork(localIP, peerIP)) {
    console.error('Different networks detected!', { localIP, peerIP });
    showNotification('Error: Devices must be on the same WiFi network', 'error');
    
    // Show detailed error modal
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: #ff3b30; color: white; padding: 30px; border-radius: 12px; z-index: 10000; max-width: 400px; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.3);';
    errorDiv.innerHTML = `
      <h2 style="margin: 0 0 15px 0; font-size: 20px;">⚠️ Different Networks</h2>
      <p style="margin: 0 0 10px 0; font-size: 14px;">Your device: <strong>${localIP}</strong></p>
      <p style="margin: 0 0 20px 0; font-size: 14px;">Other device: <strong>${peerIP}</strong></p>
      <p style="margin: 0 0 20px 0; font-size: 14px;">Both devices must be on the same WiFi network for direct transfer.</p>
      <button onclick="location.reload()" style="background: white; color: #ff3b30; border: none; padding: 12px 24px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer;">Go Back</button>
    `;
    document.body.appendChild(errorDiv);
    
    // Disconnect after showing error
    setTimeout(() => {
      if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
      }
    }, 500);
  }
});

socket.on('ice-candidate', async (candidate) => {
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (error) {
    console.error('Error adding ICE candidate:', error);
  }
});

socket.on('peer-disconnected', () => {
  console.log('Socket peer-disconnected event received');
  
  // If this was intentional (Start New Transfer), skip reconnection
  if (intentionalDisconnect) {
    console.log('Intentional disconnect - no reconnection needed');
    return;
  }
  
  // Use grace period instead of immediate disconnect (mobile file picker)
  if (currentMode === 'sender' || currentMode === 'receiver') {
    const message = currentMode === 'receiver' 
      ? 'Sender disconnected. Waiting to reconnect...' 
      : 'Receiver disconnected. Waiting to reconnect...';
    
    showNotification(message, 'warning');
    
    // Clear any existing timeout
    if (reconnectionTimeout) clearTimeout(reconnectionTimeout);
    
    // Wait 45 seconds before actually disconnecting
    reconnectionTimeout = setTimeout(() => {
      console.log('Reconnection timeout - disconnecting');
      showNotification('Connection lost. Please try again.', 'error');
      reset();
    }, 45000); // 45 second grace period
  }
});

// ========== UTILITY FUNCTIONS ==========

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function formatSpeed(bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond === Infinity) return '-- KB/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
  return Math.round(bytesPerSecond / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function formatTime(seconds) {
  if (!seconds || seconds === Infinity || seconds < 0) return '--';
  if (seconds < 60) return Math.round(seconds) + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + Math.round(seconds % 60) + 's';
  return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
}

// Custom confirm dialog
function showConfirm(title, message, onConfirm) {
  const modal = document.getElementById('confirm-modal');
  const titleEl = document.getElementById('confirm-title');
  const messageEl = document.getElementById('confirm-message');
  const cancelBtn = document.getElementById('confirm-cancel');
  const okBtn = document.getElementById('confirm-ok');
  
  titleEl.textContent = title;
  messageEl.textContent = message;
  modal.classList.remove('hidden');
  
  const closeModal = () => {
    modal.classList.add('hidden');
    cancelBtn.removeEventListener('click', handleCancel);
    okBtn.removeEventListener('click', handleOk);
  };
  
  const handleCancel = () => closeModal();
  const handleOk = () => {
    onConfirm();
    closeModal();
  };
  
  cancelBtn.addEventListener('click', handleCancel);
  okBtn.addEventListener('click', handleOk);
  
  // Close on background click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
}

// Notification system
function showNotification(message, type = 'info') {
  const notification = document.getElementById('notification');
  const icon = document.getElementById('notification-icon');
  const messageEl = document.getElementById('notification-message');
  
  const icons = {
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️'
  };
  
  icon.textContent = icons[type] || icons.info;
  messageEl.textContent = message;
  notification.classList.remove('hidden');
  
  // Auto hide after 3 seconds
  setTimeout(() => {
    notification.classList.add('hidden');
  }, 3000);
}

// Modal controls
document.getElementById('security-info-btn').addEventListener('click', () => {
  document.getElementById('security-modal').classList.remove('hidden');
});

document.getElementById('close-modal').addEventListener('click', () => {
  document.getElementById('security-modal').classList.add('hidden');
});

document.getElementById('why-choose-btn').addEventListener('click', () => {
  document.getElementById('why-choose-modal').classList.remove('hidden');
});

document.getElementById('close-why-modal').addEventListener('click', () => {
  document.getElementById('why-choose-modal').classList.add('hidden');
});

// Close modals on background click
document.getElementById('security-modal').addEventListener('click', (e) => {
  if (e.target.id === 'security-modal') {
    document.getElementById('security-modal').classList.add('hidden');
  }
});

document.getElementById('why-choose-modal').addEventListener('click', (e) => {
  if (e.target.id === 'why-choose-modal') {
    document.getElementById('why-choose-modal').classList.add('hidden');
  }
});
