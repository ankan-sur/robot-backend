import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 8080;

// =============================================================================
// CONFIGURATION
// =============================================================================
const CONFIG = {
  // Safety limits for teleop commands
  maxLinearVelocity: 0.5,    // m/s
  maxAngularVelocity: 1.5,   // rad/s
  
  // Control lock settings
  controlIdleTimeoutMs: 60000,  // Auto-release control after 60s of no commands
  
  // Connection settings
  robotTimeoutMs: 60000,        // Mark robot offline after 60s no telemetry
  pingIntervalMs: 30000,        // WebSocket ping interval
  
  // Valid modes
  validModes: ['idle', 'slam', 'nav', 'localization'],
};

// =============================================================================
// STATE MANAGEMENT
// =============================================================================

/**
 * Robot state structure:
 * {
 *   ws: WebSocket,
 *   clientId: string,
 *   lastSeen: number,
 *   version: string,
 *   capabilities: string[],
 *   telemetry: { mode, pose, battery, nav, maps, pois },
 *   control: { ownerClientId, ownerName, since, lastCommandAt }
 * }
 */
const robots = new Map();

/**
 * UI Client structure:
 * {
 *   ws: WebSocket,
 *   clientId: string,
 *   clientName: string,
 *   subscribedRobots: Set<string>,
 *   connectedAt: number
 * }
 */
const uiClients = new Map(); // clientId -> client object

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function generateClientId() {
  return randomUUID().slice(0, 8);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getRobotState(robotId) {
  const robot = robots.get(robotId);
  if (!robot) return null;
  
  return {
    robotId,
    online: true,
    lastSeen: robot.lastSeen,
    version: robot.version,
    capabilities: robot.capabilities,
    ...robot.telemetry,
    control: {
      ownerClientId: robot.control?.ownerClientId || null,
      ownerName: robot.control?.ownerName || null,
      since: robot.control?.since || null,
    }
  };
}

function broadcastToRobotSubscribers(robotId, message) {
  const payload = JSON.stringify(message);
  let sent = 0;
  
  uiClients.forEach((client) => {
    if (client.ws.readyState === client.ws.OPEN && 
        client.subscribedRobots.has(robotId)) {
      client.ws.send(payload);
      sent++;
    }
  });
  
  if (sent > 0) {
    console.log(`[BROADCAST] ${robotId}: sent to ${sent} subscribers`);
  }
}

function broadcastToAll(message) {
  const payload = JSON.stringify(message);
  uiClients.forEach((client) => {
    if (client.ws.readyState === client.ws.OPEN) {
      client.ws.send(payload);
    }
  });
}

// =============================================================================
// REST API ENDPOINTS
// =============================================================================

// Health check
app.get('/', (req, res) => {
  const robotList = Array.from(robots.entries()).map(([id, robot]) => ({
    robotId: id,
    online: true,
    lastSeen: robot.lastSeen,
    mode: robot.telemetry?.mode || 'unknown',
    hasControl: !!robot.control?.ownerClientId,
  }));
  
  res.json({
    status: 'ok',
    service: 'fordward-cloud-backend',
    robots: robotList,
    uiClients: uiClients.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Get all robots with full state
app.get('/robots', (req, res) => {
  const robotList = Array.from(robots.keys()).map(id => getRobotState(id));
  res.json({ robots: robotList, timestamp: new Date().toISOString() });
});

// Get specific robot state
app.get('/robots/:robotId', (req, res) => {
  const state = getRobotState(req.params.robotId);
  if (!state) {
    return res.status(404).json({ error: 'Robot not found' });
  }
  res.json(state);
});

const server = createServer(app);

// =============================================================================
// WEBSOCKET SERVERS
// =============================================================================

const robotWss = new WebSocketServer({ noServer: true });
const uiWss = new WebSocketServer({ noServer: true });

// =============================================================================
// HTTP UPGRADE HANDLER
// =============================================================================

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

// =============================================================================
// ROBOT WEBSOCKET HANDLER (cloud_bridge connects here)
// =============================================================================

robotWss.on('connection', (ws) => {
  console.log('[ROBOT] New robot connection');
  
  let robotId = null;

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      // Handle "hello" (new protocol) or "register" (legacy)
      if (message.type === 'hello' || message.type === 'register') {
        robotId = message.robotId || message.robot_id || 'fordward';
        
        // Check if robot already connected (reconnection)
        if (robots.has(robotId)) {
          const existing = robots.get(robotId);
          // Close old connection
          try { existing.ws.terminate(); } catch {}
          console.log(`[ROBOT] ${robotId} reconnected, closing old connection`);
        }
        
        robots.set(robotId, {
          ws,
          clientId: generateClientId(),
          lastSeen: Date.now(),
          version: message.version || '0.0.0',
          capabilities: message.capabilities || ['pose', 'battery', 'mode'],
          telemetry: {},
          control: { ownerClientId: null, ownerName: null, since: null, lastCommandAt: null }
        });
        
        console.log(`[ROBOT] Registered: ${robotId} (v${message.version || '?'})`);
        
        // Send acknowledgment
        ws.send(JSON.stringify({
          type: 'welcome',
          robotId,
          serverTime: new Date().toISOString(),
          config: {
            telemetryRateHz: 2,
            maxLinearVelocity: CONFIG.maxLinearVelocity,
            maxAngularVelocity: CONFIG.maxAngularVelocity,
          }
        }));
        
        // Notify all UI clients about robot coming online
        broadcastToAll({
          type: 'event',
          robotId,
          payload: { kind: 'robot_online', version: message.version }
        });
        
      } else if (message.type === 'telemetry') {
        robotId = message.robotId || message.robot_id || robotId;
        
        if (robotId && robots.has(robotId)) {
          const robot = robots.get(robotId);
          robot.lastSeen = Date.now();
          
          // Store telemetry (normalize structure)
          robot.telemetry = message.payload || {
            mode: message.mode || message.state || 'unknown',
            pose: message.pose,
            battery: message.battery ? {
              percent: message.battery.percent ?? message.battery,
              voltage: message.battery.voltage ?? message.battery_voltage
            } : null,
            nav: message.nav || { state: 'idle', currentGoalPoiId: null, lastResult: null },
            maps: message.maps || { active: message.map, available: message.available_maps || [] },
            pois: message.pois || []
          };
          
          // Broadcast state update to subscribers
          broadcastToRobotSubscribers(robotId, {
            type: 'state',
            robotId,
            payload: {
              ...robot.telemetry,
              control: {
                ownerClientId: robot.control?.ownerClientId || null,
                ownerName: robot.control?.ownerName || null,
              },
              online: true
            }
          });
        }
        
      } else if (message.type === 'command_result') {
        // Forward command result to UI
        const targetRobotId = message.robotId || message.robot_id || robotId;
        broadcastToRobotSubscribers(targetRobotId, {
          type: 'event',
          robotId: targetRobotId,
          payload: {
            kind: 'command_result',
            command: message.command,
            success: message.success,
            message: message.message,
            timestamp: message.timestamp
          }
        });
        console.log(`[ROBOT] Command result from ${targetRobotId}: ${message.command} -> ${message.success ? 'OK' : 'FAIL'}`);
        
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
      broadcastToAll({
        type: 'event',
        robotId,
        payload: { kind: 'robot_offline', reason: 'disconnected' }
      });
    }
  });

  ws.on('error', (error) => {
    console.error('[ROBOT] WebSocket error:', error.message);
  });

  // Ping to keep connection alive
  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    }
  }, CONFIG.pingIntervalMs);

  ws.on('close', () => clearInterval(pingInterval));
});

// =============================================================================
// UI WEBSOCKET HANDLER (Frontend connects here)
// =============================================================================

uiWss.on('connection', (ws) => {
  const clientId = generateClientId();
  console.log(`[UI] New client connected: ${clientId}`);
  
  const client = {
    ws,
    clientId,
    clientName: `Client-${clientId}`,
    subscribedRobots: new Set(),
    connectedAt: Date.now()
  };
  
  uiClients.set(clientId, client);

  // Send welcome with available robots
  const robotList = Array.from(robots.keys()).map(id => getRobotState(id));
  ws.send(JSON.stringify({
    type: 'welcome',
    clientId,
    robots: robotList,
    timestamp: new Date().toISOString()
  }));

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      // =========== SUBSCRIBE ===========
      if (message.type === 'subscribe') {
        const robotId = message.robotId || 'fordward';
        client.subscribedRobots.add(robotId);
        if (message.clientName) {
          client.clientName = message.clientName;
        }
        
        console.log(`[UI] ${client.clientName} subscribed to ${robotId}`);
        
        // Send current state snapshot
        const state = getRobotState(robotId);
        ws.send(JSON.stringify({
          type: 'state',
          robotId,
          payload: state ? {
            ...state,
            online: true
          } : {
            online: false,
            mode: 'unknown',
            control: { ownerClientId: null, ownerName: null }
          }
        }));
        
      // =========== UNSUBSCRIBE ===========
      } else if (message.type === 'unsubscribe') {
        const robotId = message.robotId;
        client.subscribedRobots.delete(robotId);
        console.log(`[UI] ${client.clientName} unsubscribed from ${robotId}`);
        
      // =========== CONTROL LOCK ===========
      } else if (message.type === 'control') {
        const robotId = message.robotId || 'fordward';
        const action = message.payload?.action;
        
        if (!robots.has(robotId)) {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'ROBOT_OFFLINE',
            message: `Robot ${robotId} is not connected`
          }));
          return;
        }
        
        const robot = robots.get(robotId);
        
        if (action === 'request') {
          // Request control
          if (!robot.control.ownerClientId) {
            // Grant control
            robot.control = {
              ownerClientId: clientId,
              ownerName: message.payload?.clientName || client.clientName,
              since: Date.now(),
              lastCommandAt: Date.now()
            };
            console.log(`[CONTROL] ${robot.control.ownerName} acquired control of ${robotId}`);
            
            // Notify all subscribers
            broadcastToRobotSubscribers(robotId, {
              type: 'event',
              robotId,
              payload: {
                kind: 'control_acquired',
                ownerClientId: clientId,
                ownerName: robot.control.ownerName
              }
            });
            
          } else if (robot.control.ownerClientId === clientId) {
            // Already have control, refresh
            robot.control.lastCommandAt = Date.now();
            ws.send(JSON.stringify({
              type: 'event',
              robotId,
              payload: { kind: 'control_confirmed' }
            }));
            
          } else {
            // Someone else has control
            ws.send(JSON.stringify({
              type: 'error',
              code: 'CONTROL_DENIED',
              message: `Control held by ${robot.control.ownerName}`,
              holder: robot.control.ownerName
            }));
          }
          
        } else if (action === 'release') {
          // Release control
          if (robot.control.ownerClientId === clientId) {
            console.log(`[CONTROL] ${robot.control.ownerName} released control of ${robotId}`);
            robot.control = { ownerClientId: null, ownerName: null, since: null, lastCommandAt: null };
            
            broadcastToRobotSubscribers(robotId, {
              type: 'event',
              robotId,
              payload: { kind: 'control_released' }
            });
          }
          
        } else if (action === 'force') {
          // Force take control (for admin/emergency)
          const previousOwner = robot.control.ownerName;
          robot.control = {
            ownerClientId: clientId,
            ownerName: message.payload?.clientName || client.clientName,
            since: Date.now(),
            lastCommandAt: Date.now()
          };
          console.log(`[CONTROL] ${robot.control.ownerName} FORCE acquired control of ${robotId} (was: ${previousOwner})`);
          
          broadcastToRobotSubscribers(robotId, {
            type: 'event',
            robotId,
            payload: {
              kind: 'control_forced',
              ownerClientId: clientId,
              ownerName: robot.control.ownerName,
              previousOwner
            }
          });
        }
        
      // =========== COMMAND ===========
      } else if (message.type === 'command') {
        const robotId = message.robotId || 'fordward';
        const payload = message.payload || {};
        const kind = payload.kind;
        
        if (!robots.has(robotId)) {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'ROBOT_OFFLINE',
            message: `Robot ${robotId} is not connected`
          }));
          return;
        }
        
        const robot = robots.get(robotId);
        
        // === CONTROL LOCK CHECK (for motion commands) ===
        const motionCommands = ['teleop', 'goto_poi', 'dock', 'navigate'];
        if (motionCommands.includes(kind)) {
          if (robot.control.ownerClientId !== clientId) {
            ws.send(JSON.stringify({
              type: 'error',
              code: 'NO_CONTROL',
              message: 'You must acquire control before sending motion commands'
            }));
            return;
          }
          // Update last command time
          robot.control.lastCommandAt = Date.now();
        }
        
        // === VALIDATE & SANITIZE COMMANDS ===
        let robotCommand = null;
        
        switch (kind) {
          case 'teleop':
            // Clamp velocities
            const linear_x = clamp(Number(payload.linear_x) || 0, -CONFIG.maxLinearVelocity, CONFIG.maxLinearVelocity);
            const angular_z = clamp(Number(payload.angular_z) || 0, -CONFIG.maxAngularVelocity, CONFIG.maxAngularVelocity);
            robotCommand = { type: 'command', command: 'teleop', linear_x, angular_z };
            break;
            
          case 'stop':
            robotCommand = { type: 'command', command: 'stop' };
            break;
            
          case 'set_mode':
            const mode = payload.mode;
            if (!CONFIG.validModes.includes(mode)) {
              ws.send(JSON.stringify({
                type: 'error',
                code: 'INVALID_MODE',
                message: `Invalid mode: ${mode}. Valid: ${CONFIG.validModes.join(', ')}`
              }));
              return;
            }
            robotCommand = { type: 'command', command: 'set_mode', mode };
            break;
            
          case 'load_map':
            const mapName = payload.mapName || payload.map_name;
            if (!mapName) {
              ws.send(JSON.stringify({ type: 'error', code: 'MISSING_PARAM', message: 'mapName required' }));
              return;
            }
            robotCommand = { type: 'command', command: 'load_map', map_name: mapName };
            break;
            
          case 'save_map':
            const saveMapName = payload.mapName || payload.map_name;
            if (!saveMapName) {
              ws.send(JSON.stringify({ type: 'error', code: 'MISSING_PARAM', message: 'mapName required' }));
              return;
            }
            robotCommand = { type: 'command', command: 'stop_slam', map_name: saveMapName };
            break;
            
          case 'goto_poi':
            const poiId = payload.poiId || payload.poi_id;
            if (!poiId) {
              ws.send(JSON.stringify({ type: 'error', code: 'MISSING_PARAM', message: 'poiId required' }));
              return;
            }
            // Optionally validate POI exists
            const knownPois = robot.telemetry?.pois || [];
            const poiExists = knownPois.some(p => p.id === poiId || p.name === poiId);
            if (knownPois.length > 0 && !poiExists) {
              ws.send(JSON.stringify({
                type: 'error',
                code: 'UNKNOWN_POI',
                message: `POI "${poiId}" not found`,
                availablePois: knownPois.map(p => p.id || p.name)
              }));
              return;
            }
            robotCommand = { type: 'command', command: 'go_to_poi', poi_id: poiId };
            break;
            
          case 'cancel_nav':
            robotCommand = { type: 'command', command: 'cancel_nav' };
            break;
            
          case 'start_slam':
            robotCommand = { type: 'command', command: 'start_slam' };
            break;
            
          case 'restart':
            robotCommand = { type: 'command', command: 'restart' };
            break;
            
          default:
            ws.send(JSON.stringify({
              type: 'error',
              code: 'UNKNOWN_COMMAND',
              message: `Unknown command kind: ${kind}`
            }));
            return;
        }
        
        // Forward to robot
        if (robotCommand && robot.ws.readyState === robot.ws.OPEN) {
          robot.ws.send(JSON.stringify(robotCommand));
          console.log(`[UI] ${client.clientName} -> ${robotId}: ${kind}`);
        }
        
      // =========== PING ===========
      } else if (message.type === 'ping') {
        ws.send(JSON.stringify({
          type: 'pong',
          timestamp: new Date().toISOString()
        }));
        
      } else {
        console.log(`[UI] Unknown message type from ${client.clientName}:`, message.type);
      }
    } catch (error) {
      console.error('[UI] Error parsing message:', error);
    }
  });

  ws.on('close', () => {
    // Auto-release control on any robot this client owned
    robots.forEach((robot, robotId) => {
      if (robot.control.ownerClientId === clientId) {
        console.log(`[CONTROL] Auto-releasing ${robotId} (${client.clientName} disconnected)`);
        robot.control = { ownerClientId: null, ownerName: null, since: null, lastCommandAt: null };
        
        broadcastToRobotSubscribers(robotId, {
          type: 'event',
          robotId,
          payload: { kind: 'control_released', reason: 'owner_disconnected' }
        });
      }
    });
    
    uiClients.delete(clientId);
    console.log(`[UI] Client disconnected: ${client.clientName}`);
  });

  ws.on('error', (error) => {
    console.error('[UI] WebSocket error:', error.message);
  });

  // Ping to keep connection alive
  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    }
  }, CONFIG.pingIntervalMs);

  ws.on('close', () => clearInterval(pingInterval));
});

// =============================================================================
// PERIODIC TASKS
// =============================================================================

// Cleanup stale robot connections
setInterval(() => {
  const now = Date.now();
  
  robots.forEach((robot, robotId) => {
    if (now - robot.lastSeen > CONFIG.robotTimeoutMs) {
      console.log(`[CLEANUP] Robot timeout: ${robotId}`);
      robot.ws.terminate();
      robots.delete(robotId);
      
      broadcastToAll({
        type: 'event',
        robotId,
        payload: { kind: 'robot_offline', reason: 'timeout' }
      });
    }
  });
}, 30000);

// Auto-release idle control locks
setInterval(() => {
  const now = Date.now();
  
  robots.forEach((robot, robotId) => {
    if (robot.control.ownerClientId && 
        robot.control.lastCommandAt && 
        now - robot.control.lastCommandAt > CONFIG.controlIdleTimeoutMs) {
      console.log(`[CONTROL] Auto-releasing ${robotId} (idle timeout)`);
      const previousOwner = robot.control.ownerName;
      robot.control = { ownerClientId: null, ownerName: null, since: null, lastCommandAt: null };
      
      broadcastToRobotSubscribers(robotId, {
        type: 'event',
        robotId,
        payload: { kind: 'control_released', reason: 'idle_timeout', previousOwner }
      });
    }
  });
}, 10000);

// =============================================================================
// SERVER STARTUP
// =============================================================================

server.listen(PORT, () => {
  console.log(`
🤖 Fordward Cloud Backend v1.0.0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Robot endpoint:   ws://localhost:${PORT}/robot
  UI endpoint:      ws://localhost:${PORT}/ui
  Health check:     http://localhost:${PORT}/
  Robots API:       http://localhost:${PORT}/robots
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Max linear vel:   ${CONFIG.maxLinearVelocity} m/s
  Max angular vel:  ${CONFIG.maxAngularVelocity} rad/s
  Control timeout:  ${CONFIG.controlIdleTimeoutMs / 1000}s
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  
  // Notify all clients
  broadcastToAll({
    type: 'event',
    payload: { kind: 'server_shutdown' }
  });
  
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
