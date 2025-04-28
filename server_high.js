// WebSocket proxy server for Multimodal Live API Console
const WebSocket = require('ws');
const http = require('http');
require('dotenv').config(); // Use dotenv for local development

const PORT = process.env.PORT || 8080; // Port for your proxy server
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // Load key securely
const GOOGLE_LIVE_API_BASE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';

// Connection status tracking
const CLIENT_STATES = {
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTING: 'disconnecting',
  DISCONNECTED: 'disconnected'
};

// WebSocket close codes
const WS_CLOSE_CODES = {
  NORMAL_CLOSURE: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  POLICY_VIOLATION: 1008,
  MESSAGE_TOO_BIG: 1009,
  INTERNAL_ERROR: 1011,
  SERVICE_RESTART: 1012,
  TRY_AGAIN_LATER: 1013
};

// Session resumption storage (in-memory for simplicity)
const sessions = new Map();

if (!GEMINI_API_KEY) {
  console.error('FATAL ERROR: GEMINI_API_KEY environment variable not set.');
  process.exit(1);
}

// Create a simple HTTP server to upgrade connections to WebSocket
const server = http.createServer((req, res) => {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

const wss = new WebSocket.Server({ server });

console.log(`WebSocket proxy server listening on port ${PORT}`);

// Logging utility
function logMessage(direction, type, data, details = '') {
  const timestamp = new Date().toISOString();
  let logData = typeof data === 'object' ? JSON.stringify(data).substring(0, 150) : data;
  if (logData.length > 150) logData += '...';
  
  console.log(`[${timestamp}] ${direction} | ${type} | ${logData} ${details ? '| ' + details : ''}`);
}

wss.on('connection', (clientWs, req) => {
  // Generate a unique identifier for this connection
  const connectionId = Math.random().toString(36).substring(2, 10);
  let clientState = CLIENT_STATES.CONNECTING;
  let sessionHandle = null;
  let pingInterval = null;
  
  logMessage('CLIENT', 'CONNECT', `Client ${connectionId} connected from ${req.socket.remoteAddress}`);

  // Construct the target Google API URL with the secure API key
  const targetUrl = `${GOOGLE_LIVE_API_BASE_URL}?key=${GEMINI_API_KEY}`;
  let googleWs = null;

  // Setup ping interval to keep connection alive
  pingInterval = setInterval(() => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.ping();
      logMessage('CLIENT', 'PING', `Sent ping to client ${connectionId}`);
    }
  }, 30000); // 30 second ping interval

  try {
    console.log('`Attempting connection to Google Live API using url', targetUrl.slice(0, -20));
    googleWs = new WebSocket(targetUrl);
    logMessage('GOOGLE', 'CONNECTING', `Attempting connection to Google Live API for client ${connectionId}`);
  } catch (error) {
    logMessage('GOOGLE', 'ERROR', `Failed to create WebSocket: ${error.message}`);
    clientWs.close(WS_CLOSE_CODES.INTERNAL_ERROR, 'Failed to connect to backend service');
    clearInterval(pingInterval);
    return;
  }

  // --- Parse and process messages ---
  function parseMessage(message) {
    try {
      if (typeof message === 'string') {
        return JSON.parse(message);
      }
      return null;
    } catch (error) {
      logMessage('PROXY', 'ERROR', `Failed to parse message: ${error.message}`);
      return null;
    }
  }

  // Check for session resumption
  function checkForSessionResumption(message) {
    const parsedMessage = parseMessage(message);
    if (!parsedMessage) return false;
    
    // Check if this is a setup message with session resumption
    if (parsedMessage.setup && parsedMessage.setup.sessionResumption && parsedMessage.setup.sessionResumption.handle) {
      sessionHandle = parsedMessage.setup.sessionResumption.handle;
      logMessage('PROXY', 'SESSION', `Detected session resumption request for handle: ${sessionHandle}`);
      
      // Check if we have stored session data
      if (sessions.has(sessionHandle)) {
        logMessage('PROXY', 'SESSION', `Found stored session data for handle: ${sessionHandle}`);
        return true;
      }
    }
    
    // Check for setup message to extract model info for logging
    if (parsedMessage.setup && parsedMessage.setup.model) {
      logMessage('PROXY', 'CONFIG', `Client ${connectionId} requested model: ${parsedMessage.setup.model}`);
    }
    
    return false;
  }

  // Check for session update messages from Google
  function checkSessionUpdate(message) {
    try {
      const data = JSON.parse(message);
      if (data.sessionResumptionUpdate) {
        const update = data.sessionResumptionUpdate;
        if (update.resumable && update.newHandle) {
          sessionHandle = update.newHandle;
          // Store session information for later resumption
          sessions.set(sessionHandle, {
            timestamp: Date.now(),
            // Any other session state you want to preserve
          });
          logMessage('PROXY', 'SESSION', `Stored session handle: ${sessionHandle}`);
          return true;
        }
      }
      
      // Check for GoAway message
      if (data.goAway) {
        logMessage('PROXY', 'GOAWAY', `Google sending GoAway with timeLeft: ${data.goAway.timeLeft}ms`);
        // Forward as-is to client
        return true;
      }
      
      return false;
    } catch (error) {
      return false;
    }
  }

  // --- Relay messages from Client to Google ---
  clientWs.on('message', (message) => {
    if (googleWs && googleWs.readyState === WebSocket.OPEN) {
      // Check for session resumption request
      checkForSessionResumption(message);
      
      // Log message type if possible
      try {
        const data = JSON.parse(message);
        const messageType = Object.keys(data)[0]; // First key usually indicates message type
        logMessage('CLIENT→GOOGLE', messageType, `${message.toString().substring(0, 100)}...`, `Length: ${message.length}`);
      } catch (e) {
        logMessage('CLIENT→GOOGLE', 'BINARY', `Binary data of length ${message.length}`);
      }
      
      googleWs.send(message);
    } else {
      logMessage('PROXY', 'ERROR', 'Google WS not open, cannot forward message from client.');
      clientWs.close(WS_CLOSE_CODES.SERVICE_RESTART, 'Backend connection unavailable, please reconnect');
    }
  });

  clientWs.on('pong', () => {
    logMessage('CLIENT', 'PONG', `Received pong from client ${connectionId}`);
  });

  clientWs.on('close', (code, reason) => {
    clientState = CLIENT_STATES.DISCONNECTED;
    logMessage('CLIENT', 'DISCONNECT', `Client ${connectionId} disconnected: ${code} - ${reason || 'No reason'}`);
    
    if (googleWs) {
      logMessage('GOOGLE', 'CLOSING', `Closing Google connection due to client disconnect`);
      googleWs.close(code, reason);
    }
    
    clearInterval(pingInterval);
  });

  clientWs.on('error', (error) => {
    logMessage('CLIENT', 'ERROR', `Client ${connectionId} error: ${error.message}`);
    
    if (googleWs) {
      googleWs.close(WS_CLOSE_CODES.INTERNAL_ERROR, 'Client connection error');
    }
    
    clearInterval(pingInterval);
  });

  // --- Relay messages from Google to Client ---
  googleWs.on('open', () => {
    clientState = CLIENT_STATES.CONNECTED;
    logMessage('GOOGLE', 'CONNECTED', `Connected to Google Live API for client ${connectionId}`);
  });

  googleWs.on('message', (message) => {
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
      // Check for special messages like session updates
      const isSessionUpdate = checkSessionUpdate(message.toString());
      
      // Log message type if possible
      try {
        const data = JSON.parse(message);
        const messageType = Object.keys(data)[0]; // First key indicates message type
        
        // Special handling for different message types
        if (messageType === 'serverContent') {
          if (data.serverContent.interrupted) {
            logMessage('GOOGLE→CLIENT', 'INTERRUPTED', 'Model generation interrupted');
          } else if (data.serverContent.turnComplete) {
            logMessage('GOOGLE→CLIENT', 'TURN_COMPLETE', 'Turn complete');
          } else if (data.serverContent.generationComplete) {
            logMessage('GOOGLE→CLIENT', 'GENERATION_COMPLETE', 'Generation complete');
          } else if (data.serverContent.modelTurn) {
            const parts = data.serverContent.modelTurn.parts || [];
            const partTypes = parts.map(p => {
              if (p.text) return 'text';
              if (p.inlineData) return `${p.inlineData.mimeType}`;
              if (p.executableCode) return 'code';
              return 'unknown';
            }).join(',');
            
            logMessage('GOOGLE→CLIENT', 'MODEL_TURN', `Parts: [${partTypes}]`, `Length: ${message.length}`);
          }
        } else if (messageType === 'toolCall') {
          const functionCalls = data.toolCall.functionCalls || [];
          const functions = functionCalls.map(f => f.name).join(',');
          logMessage('GOOGLE→CLIENT', 'TOOL_CALL', `Functions: [${functions}]`);
        } else if (messageType === 'toolCallCancellation') {
          logMessage('GOOGLE→CLIENT', 'TOOL_CANCELLATION', `IDs: [${data.toolCallCancellation.ids.join(',')}]`);
        } else if (messageType === 'setupComplete') {
          logMessage('GOOGLE→CLIENT', 'SETUP_COMPLETE', 'Setup complete');
        } else if (messageType === 'usageMetadata') {
          logMessage('GOOGLE→CLIENT', 'USAGE_METADATA', `Tokens: ${data.usageMetadata.totalTokenCount || 'unknown'}`);
        } else {
          logMessage('GOOGLE→CLIENT', messageType, `${message.toString().substring(0, 100)}...`, `Length: ${message.length}`);
        }
      } catch (e) {
        // Binary data or non-JSON message
        logMessage('GOOGLE→CLIENT', 'DATA', `Data of length ${message.length}`);
      }
      
      clientWs.send(message);
    } else {
      logMessage('PROXY', 'DROP', 'Client disconnected, dropping message from Google');
    }
  });

  googleWs.on('close', (code, reason) => {
    const reasonStr = reason ? reason.toString() : 'No reason';
    logMessage('GOOGLE', 'DISCONNECT', `Google disconnected from proxy: ${code} - ${reasonStr}`);
    
    // Store session handle if available for potential resumption
    if (sessionHandle) {
      logMessage('PROXY', 'SESSION', `Storing session handle ${sessionHandle} for potential resumption`);
      // Here we could store additional state if needed
      sessions.set(sessionHandle, {
        timestamp: Date.now(),
        // Any other session metadata
      });
    }
    
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
      // If Google sends a GoAway, use SERVICE_RESTART to indicate client should try again
      const clientCode = code === WS_CLOSE_CODES.GOING_AWAY ? WS_CLOSE_CODES.SERVICE_RESTART : code;
      const clientReason = code === WS_CLOSE_CODES.GOING_AWAY ? 
        'Backend service restarting, please reconnect' : reasonStr;
      
      logMessage('CLIENT', 'CLOSING', `Closing client connection: ${clientCode} - ${clientReason}`);
      clientWs.close(clientCode, clientReason);
    }
    
    clearInterval(pingInterval);
  });

  googleWs.on('error', (error) => {
    logMessage('GOOGLE', 'ERROR', `Google WebSocket error: ${error.message}`);
    
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
      logMessage('CLIENT', 'CLOSING', 'Closing client connection due to Google error');
      clientWs.close(WS_CLOSE_CODES.INTERNAL_ERROR, 'Backend service error');
    }
    
    clearInterval(pingInterval);
  });
});

// Session cleanup - remove old session handles periodically
setInterval(() => {
  const now = Date.now();
  const expiredTime = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
  
  let expiredCount = 0;
  for (const [handle, data] of sessions.entries()) {
    if (now - data.timestamp > expiredTime) {
      sessions.delete(handle);
      expiredCount++;
    }
  }
  
  if (expiredCount > 0) {
    console.log(`[${new Date().toISOString()}] Cleaned up ${expiredCount} expired session handles. Active: ${sessions.size}`);
  }
}, 60 * 60 * 1000); // Clean up every hour

server.listen(PORT, () => {
  console.log(`HTTP server for WebSocket upgrades listening on port ${PORT}`);
});

// Basic signal handling
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
}); 