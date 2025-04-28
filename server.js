const WebSocket = require('ws');
const http = require('http');
require('dotenv').config();
const fetch = require('node-fetch');

const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_LIVE_API_BASE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY not set in environment');
  process.exit(1);
}

function safeClose(ws, code, reason) {
  // Validate close code: must be integer between 1000 and 4999, excluding 1005, 1006, 1015
  const invalidCodes = [1005, 1006, 1015];
  let validCode = 1000; // Normal closure default

  if (typeof code === 'number' && code >= 1000 && code <= 4999 && !invalidCodes.includes(code)) {
    validCode = code;
  }

  // Ensure reason is a string
  let validReason = '';
  if (typeof reason === 'string') {
    validReason = reason;
  } else if (Buffer.isBuffer(reason)) {
    validReason = reason.toString('utf8');
  } else if (reason) {
    validReason = String(reason);
  }

  try {
    ws.close(validCode, validReason);
  } catch (err) {
    console.error('Error closing WebSocket:', err);
    // fallback: close without params
    try {
      ws.close();
    } catch {}
  }
}

const server = http.createServer();
const wss = new WebSocket.Server({ server });

server.listen(PORT, () => {

async function listModels(apiKey) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
  const data = await response.json();
  console.log('Available models:', data.models.map(m => m.name));
}

listModels(process.env.GEMINI_API_KEY);
  console.log(`Proxy server listening on ws://localhost:${PORT}`);
});

wss.on('connection', (clientWs) => {
  console.log('Client connected');

  // Connect to Google Gemini Live API with API key
  const googleWs = new WebSocket(`${GOOGLE_LIVE_API_BASE_URL}?key=${GEMINI_API_KEY}`);

  // Queue to hold messages from client until googleWs is open
  const messageQueue = [];

  // Flag to track if googleWs is ready
  let googleWsReady = false;
  
  // Flag to track if this is an intentional disconnection
  let isIntentionalDisconnect = false;

  googleWs.on('open', () => {
    console.log('Connected to Google Live API');
    googleWsReady = true;

    // Flush queued messages
    while (messageQueue.length > 0) {
      const msg = messageQueue.shift();
      googleWs.send(msg);
    }
  });

  googleWs.on('message', (data) => {
    // Forward messages from Google to client
    if (clientWs.readyState === WebSocket.OPEN && !isIntentionalDisconnect) {
      clientWs.send(data);
    }
  });

  googleWs.on('close', (code, reason) => {
    console.log(`Google WS closed: ${code} ${reason}`);
    if (clientWs.readyState === WebSocket.OPEN) {
      console.log('Closing client WS with code:', code, 'and reason:', reason);
      safeClose(clientWs, code, reason);
    }
  });

  googleWs.on('error', (err) => {
    console.error('Google WS error:', err);
    if (clientWs.readyState === WebSocket.OPEN) {
      safeClose(clientWs, 1011, 'Google WS error');
    }
  });

  clientWs.on('message', (msg) => {
    // Check if this is a disconnect command from the client
    try {
      const jsonMsg = JSON.parse(msg);
      if (jsonMsg.type === 'disconnect') {
        isIntentionalDisconnect = true;
        console.log('Client requested disconnect');
        
        // Clear message queue
        messageQueue.length = 0;
        
        // Close the Google connection with normal closure code
        safeClose(googleWs, 1000, 'Client requested disconnect');
        return;
      }
    } catch (e) {
      // Not JSON or doesn't have the expected format, proceed as normal
    }
    
    if (googleWsReady && googleWs.readyState === WebSocket.OPEN && !isIntentionalDisconnect) {
      googleWs.send(msg);
    } else if (!isIntentionalDisconnect) {
      // Queue messages until googleWs is open
      messageQueue.push(msg);
    }
  });

  clientWs.on('close', (code, reason) => {
    console.log(`Client WS closed: ${code} ${reason}`);
    
    // Clear any queued messages
    messageQueue.length = 0;
    
    // Mark as intentional disconnect if code is 1000 (normal closure)
    if (code === 1000) {
      isIntentionalDisconnect = true;
    }
    
    if (googleWs.readyState === WebSocket.OPEN) {
      console.log('Closing Google WS with code:', isIntentionalDisconnect ? 1000 : code, 'and reason:', isIntentionalDisconnect ? 'Client disconnected normally' : reason);
      // Use 1000 (normal closure) if this was an intentional disconnect
      safeClose(googleWs, isIntentionalDisconnect ? 1000 : code, isIntentionalDisconnect ? 'Client disconnected normally' : reason);
    }
  });

  clientWs.on('error', (err) => {
    console.error('Client WS error:', err);
    if (googleWs.readyState === WebSocket.OPEN) {
      safeClose(googleWs, 1011, 'Client WS error');
    }
  });
});
