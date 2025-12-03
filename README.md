# Fordward Cloud Backend - WebSocket Relay Server

Low-bandwidth control and telemetry relay for the Fordward robot. Coordinates multiple browser clients, enforces control locking, and routes commands to the robot's ROS2 stack via `cloud_bridge`.

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Browser 1   │     │  Browser 2   │     │  Browser N   │
│  (Operator)  │     │  (Viewer)    │     │  (Viewer)    │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       └────────────────────┼────────────────────┘
                            │ wss://.../ui
                   ┌────────▼────────┐
                   │                 │
                   │  Cloud Backend  │  ← Render.com
                   │   (this repo)   │
                   │                 │
                   └────────┬────────┘
                            │ wss://.../robot
                   ┌────────▼────────┐
                   │  cloud_bridge   │  ← On robot
                   │   (ROS2 node)   │
                   └────────┬────────┘
                            │
                   ┌────────▼────────┐
                   │   ROS2 Stack    │
                   │  (Nav2, SLAM)   │
                   └─────────────────┘
```

## What This Server Does

✅ **Coordinates multiple browser clients** per robot  
✅ **Enforces control locking** (one operator at a time)  
✅ **Validates and sanitizes commands** before forwarding  
✅ **Relays telemetry** (pose, battery, mode, nav state)  
✅ **Clamps velocity commands** for safety  

## What This Server Does NOT Do

❌ **Stream video** (too bandwidth-heavy; use direct connection or tunnel)  
❌ **Stream full maps** (occupancy grids are 100KB-10MB; use snapshots or direct)  
❌ **Run ROS nodes** (that's `cloud_bridge` on the robot)  

## Endpoints

### WebSocket: `/robot`
Robot's `cloud_bridge` connects here to send telemetry and receive commands.

### WebSocket: `/ui`
Browser clients connect here to subscribe to robots, send commands, and receive state.

### REST: `/` and `/health`
Health check endpoints.

### REST: `/robots`
Get list of all connected robots with their current state.

---

## Protocol Reference

### 1. Robot → Backend

#### Hello (on connect)
```json
{
  "type": "hello",
  "robotId": "fordward",
  "version": "0.1.0",
  "capabilities": ["pose", "battery", "mode", "nav", "maps", "pois"]
}
```

#### Telemetry (periodic, 2 Hz)
```json
{
  "type": "telemetry",
  "robotId": "fordward",
  "payload": {
    "mode": "nav",
    "pose": { "x": 12.3, "y": 4.5, "theta": 1.57 },
    "battery": { "percent": 78, "voltage": 7.6 },
    "nav": { "state": "idle", "currentGoalPoiId": null, "lastResult": null },
    "maps": { "active": "hallway-map", "available": ["hallway-map", "lab-map"] },
    "pois": [
      { "id": "dock", "name": "Dock", "x": 0.0, "y": 0.0, "theta": 0.0 },
      { "id": "grossing", "name": "Grossing", "x": 12.1, "y": 3.3, "theta": -1.57 }
    ]
  }
}
```

#### Command Result
```json
{
  "type": "command_result",
  "robotId": "fordward",
  "command": "set_mode",
  "success": true,
  "message": "Mode set to nav"
}
```

---

### 2. Frontend → Backend

#### Subscribe to Robot
```json
{
  "type": "subscribe",
  "robotId": "fordward",
  "clientName": "LabTablet"
}
```

#### Request Control
```json
{
  "type": "control",
  "robotId": "fordward",
  "payload": { "action": "request", "clientName": "LabTablet" }
}
```

#### Release Control
```json
{
  "type": "control",
  "robotId": "fordward",
  "payload": { "action": "release" }
}
```

#### Commands (require control for motion)
```json
// Teleop
{
  "type": "command",
  "robotId": "fordward",
  "payload": { "kind": "teleop", "linear_x": 0.15, "angular_z": 0.3 }
}

// Set Mode
{
  "type": "command",
  "robotId": "fordward",
  "payload": { "kind": "set_mode", "mode": "slam" }
}

// Go to POI
{
  "type": "command",
  "robotId": "fordward",
  "payload": { "kind": "goto_poi", "poiId": "grossing" }
}

// Load Map
{
  "type": "command",
  "robotId": "fordward",
  "payload": { "kind": "load_map", "mapName": "hallway-map" }
}

// Save Map (stop SLAM and save)
{
  "type": "command",
  "robotId": "fordward",
  "payload": { "kind": "save_map", "mapName": "new-map" }
}

// Stop (emergency stop)
{
  "type": "command",
  "robotId": "fordward",
  "payload": { "kind": "stop" }
}

// Cancel Navigation
{
  "type": "command",
  "robotId": "fordward",
  "payload": { "kind": "cancel_nav" }
}
```

---

### 3. Backend → Frontend

#### State Update (on telemetry)
```json
{
  "type": "state",
  "robotId": "fordward",
  "payload": {
    "mode": "nav",
    "pose": { "x": 12.3, "y": 4.5, "theta": 1.57 },
    "battery": { "percent": 78, "voltage": 7.6 },
    "nav": { "state": "idle", "currentGoalPoiId": null, "lastResult": null },
    "maps": { "active": "hallway-map", "available": ["hallway-map"] },
    "pois": [...],
    "control": { "ownerClientId": "abc123", "ownerName": "LabTablet" },
    "online": true
  }
}
```

#### Events
```json
// Control acquired
{ "type": "event", "robotId": "fordward", "payload": { "kind": "control_acquired", "ownerName": "LabTablet" } }

// Control released
{ "type": "event", "robotId": "fordward", "payload": { "kind": "control_released", "reason": "idle_timeout" } }

// Robot online/offline
{ "type": "event", "robotId": "fordward", "payload": { "kind": "robot_online", "version": "0.1.0" } }
{ "type": "event", "robotId": "fordward", "payload": { "kind": "robot_offline", "reason": "timeout" } }

// Command result
{ "type": "event", "robotId": "fordward", "payload": { "kind": "command_result", "command": "set_mode", "success": true } }
```

#### Errors
```json
{ "type": "error", "code": "CONTROL_DENIED", "message": "Control held by LabTablet", "holder": "LabTablet" }
{ "type": "error", "code": "NO_CONTROL", "message": "You must acquire control before sending motion commands" }
{ "type": "error", "code": "ROBOT_OFFLINE", "message": "Robot fordward is not connected" }
{ "type": "error", "code": "INVALID_MODE", "message": "Invalid mode: foo. Valid: idle, slam, nav, localization" }
```

---

## Control Lock Rules

1. **Request**: If no one has control → granted. If someone else → denied.
2. **Release**: Only owner can release.
3. **Auto-release on disconnect**: If the controlling client disconnects.
4. **Idle timeout**: If no commands sent for 60 seconds.
5. **Force**: Admin can force-take control (for emergencies).

---

## Safety Limits

| Parameter | Limit |
|-----------|-------|
| Max linear velocity | ±0.5 m/s |
| Max angular velocity | ±1.5 rad/s |
| Control idle timeout | 60 seconds |

Commands are clamped server-side before forwarding to robot.

---

## Setup

### Local Development
```bash
npm install
npm run dev
```

### Production (Render.com)
1. Push to GitHub
2. Create Web Service on Render
3. Build: `npm install`
4. Start: `npm start`

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8080 | Server port |

---

## Testing

```bash
npm install -g wscat

# Terminal 1: Connect as robot
wscat -c ws://localhost:8080/robot
> {"type":"hello","robotId":"fordward","version":"0.1.0"}
> {"type":"telemetry","robotId":"fordward","payload":{"mode":"idle","battery":{"percent":80}}}

# Terminal 2: Connect as UI
wscat -c ws://localhost:8080/ui
> {"type":"subscribe","robotId":"fordward","clientName":"TestClient"}
> {"type":"control","robotId":"fordward","payload":{"action":"request"}}
> {"type":"command","robotId":"fordward","payload":{"kind":"set_mode","mode":"slam"}}
```
