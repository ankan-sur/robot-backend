import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

const app = express();
const PORT = process.env.PORT || 8080;

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'robot-cloud-backend',
    robots: Array.from(robots.keys()),
    ui_clients: uiClients.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

const server = createServer(app);

// Create WebSocket servers
const robotWss = new WebSocketServer({ noServer: true });
const uiWss = new WebSocketServer({ noServer: true });

// State management
const robots = new Map(); // robot_id -> { ws, lastSeen, telemetry }
const uiClients = new Set(); // Set of UI client websockets

// Handle HTTP upgrade for WebSocket connections
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

  if (pathname === '/robot') {
    robotWss.handleUpgrade(request, socket, head, (ws) => {
      robotWss.emit('connection', ws, request);
    });
  } else if (pathname === '/ui') {
    uiWss.handleUpgrade(request, socket, head, (ws) => {
      uiWss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Robot WebSocket connections
robotWss.on('connection', (ws) => {
  console.log('[ROBOT] New robot connection');
  
  let robotId = null;

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.type === 'register') {
        // Robot registration
        robotId = message.robot_id || 'unknown';
        robots.set(robotId, {
          ws,
          lastSeen: Date.now(),
          telemetry: {}
        });
        console.log(`[ROBOT] Registered: ${robotId}`);
        
        // Send acknowledgment
        ws.send(JSON.stringify({
          type: 'registered',
          robot_id: robotId,
          timestamp: new Date().toISOString()
        }));
        
      } else if (message.type === 'telemetry') {
        // Robot telemetry update
        robotId = message.robot_id || robotId;
        
        if (robotId && robots.has(robotId)) {
          const robot = robots.get(robotId);
          robot.lastSeen = Date.now();
          robot.telemetry = message;
          
          // Broadcast to all UI clients
          broadcastToUI({
            type: 'telemetry',
            robot_id: robotId,
            ...message
          });
        }
        
      } else if (message.type === 'command_result') {
        // Robot command execution result
        broadcastToUI(message);
        console.log(`[ROBOT] Command result from ${robotId}:`, message.success ? 'SUCCESS' : 'FAILED');
        
      } else {
        console.log(`[ROBOT] Unknown message type from ${robotId}:`, message.type);
      }
    } catch (error) {
      console.error('[ROBOT] Error parsing message:', error);
    }
  });

  ws.on('close', () => {
    if (robotId && robots.has(robotId)) {
      robots.delete(robotId);
      console.log(`[ROBOT] Disconnected: ${robotId}`);
      
      // Notify UI clients
      broadcastToUI({
        type: 'robot_disconnected',
        robot_id: robotId,
        timestamp: new Date().toISOString()
      });
    }
  });

  ws.on('error', (error) => {
    console.error('[ROBOT] WebSocket error:', error);
  });

  // Send ping every 30 seconds
  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    }
  }, 30000);

  ws.on('close', () => clearInterval(pingInterval));
});

// UI WebSocket connections
uiWss.on('connection', (ws) => {
  console.log('[UI] New UI client connection');
  uiClients.add(ws);

  // Send current robot status
  const robotStatus = Array.from(robots.entries()).map(([id, robot]) => ({
    robot_id: id,
    connected: true,
    lastSeen: robot.lastSeen,
    telemetry: robot.telemetry
  }));

  ws.send(JSON.stringify({
    type: 'init',
    robots: robotStatus,
    timestamp: new Date().toISOString()
  }));

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.type === 'command') {
        // Forward command to robot
        const robotId = message.robot_id || 'mentorpi'; // Default robot
        
        if (robots.has(robotId)) {
          const robot = robots.get(robotId);
          robot.ws.send(JSON.stringify(message));
          console.log(`[UI] Command forwarded to ${robotId}:`, message.command);
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            error: `Robot ${robotId} not connected`,
            timestamp: new Date().toISOString()
          }));
          console.log(`[UI] Robot ${robotId} not found for command:`, message.command);
        }
        
      } else if (message.type === 'ping') {
        // Health check from UI
        ws.send(JSON.stringify({
          type: 'pong',
          timestamp: new Date().toISOString()
        }));
        
      } else {
        console.log('[UI] Unknown message type:', message.type);
      }
    } catch (error) {
      console.error('[UI] Error parsing message:', error);
    }
  });

  ws.on('close', () => {
    uiClients.delete(ws);
    console.log('[UI] Client disconnected');
  });

  ws.on('error', (error) => {
    console.error('[UI] WebSocket error:', error);
  });

  // Send ping every 30 seconds
  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    }
  }, 30000);

  ws.on('close', () => clearInterval(pingInterval));
});

// Broadcast message to all UI clients
function broadcastToUI(message) {
  const payload = JSON.stringify(message);
  let sent = 0;
  
  uiClients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(payload);
      sent++;
    }
  });
  
  if (sent > 0) {
    console.log(`[BROADCAST] Sent to ${sent} UI clients`);
  }
}

// Cleanup stale robot connections
setInterval(() => {
  const now = Date.now();
  const timeout = 60000; // 60 seconds
  
  robots.forEach((robot, robotId) => {
    if (now - robot.lastSeen > timeout) {
      console.log(`[CLEANUP] Removing stale robot: ${robotId}`);
      robot.ws.terminate();
      robots.delete(robotId);
      
      broadcastToUI({
        type: 'robot_timeout',
        robot_id: robotId,
        timestamp: new Date().toISOString()
      });
    }
  });
}, 30000);

// Start server
server.listen(PORT, () => {
  console.log(`\n🚀 Robot Cloud Backend running on port ${PORT}`);
  console.log(`   Robot endpoint:  ws://localhost:${PORT}/robot`);
  console.log(`   UI endpoint:     ws://localhost:${PORT}/ui`);
  console.log(`   Health check:    http://localhost:${PORT}/\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
