# Robot Cloud Backend - WebSocket Relay Server

Simple Node.js WebSocket relay server that routes messages between robots and UI clients.

## Architecture

```
Robot (ROS2) ←→ Backend (/robot) ←→ Backend (/ui) ←→ Web UI (React)
```

## Endpoints

### `/robot` - Robot WebSocket Connection
- Robots connect here to send telemetry and receive commands
- Persistent connection from robot to cloud

### `/ui` - UI Client WebSocket Connection  
- Web UI clients connect here to view telemetry and send commands
- Multiple UI clients can connect simultaneously

### `/` - Health Check (HTTP)
- Returns server status and connected clients info

## Message Protocol

### Robot → Backend (Registration)
```json
{
  "type": "register",
  "robot_id": "mentorpi"
}
```

### Robot → Backend (Telemetry)
```json
{
  "type": "telemetry",
  "robot_id": "mentorpi",
  "pose": { "x": 0.0, "y": 0.0, "theta": 0.0 },
  "battery": 72,
  "state": "IDLE",
  "map": "hf_hallway",
  "timestamp": "2025-12-01T12:00:00Z"
}
```

### UI → Backend → Robot (Command)
```json
{
  "type": "command",
  "robot_id": "mentorpi",
  "command": "go_to_poi",
  "poi_id": "LAB_A_DOOR"
}
```

### Robot → Backend → UI (Command Result)
```json
{
  "type": "command_result",
  "robot_id": "mentorpi",
  "command": "go_to_poi",
  "success": true,
  "message": "Navigating to LAB_A_DOOR"
}
```

## Setup

### Local Development

```bash
npm install
npm run dev
```

Server runs on `http://localhost:8080`

### Production (Render.com)

1. Push to GitHub
2. Create new Web Service on Render.com
3. Connect repository
4. Set build command: `npm install`
5. Set start command: `npm start`
6. Deploy!

## Environment Variables

- `PORT` - Server port (default: 8080)

## Testing

### Test with wscat

```bash
npm install -g wscat

# Connect as robot
wscat -c ws://localhost:8080/robot

# Send registration
{"type":"register","robot_id":"testbot"}

# Send telemetry
{"type":"telemetry","robot_id":"testbot","battery":75,"state":"IDLE"}

# Connect as UI (separate terminal)
wscat -c ws://localhost:8080/ui

# Send command
{"type":"command","robot_id":"testbot","command":"go_to_poi","poi_id":"TEST"}
```

## Features

- ✅ Bidirectional communication
- ✅ Multiple UI clients supported
- ✅ Automatic stale connection cleanup
- ✅ Health check endpoint
- ✅ No database required
- ✅ Stateless (can scale horizontally)
- ✅ Auto-reconnect friendly

## Deployment

See `docs/CLOUD_DEPLOYMENT.md` for full deployment guide.
