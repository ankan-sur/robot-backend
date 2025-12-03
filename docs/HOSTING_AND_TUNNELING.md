# Hosting & Tunneling Options for Video/Map Streaming

## The Problem

Your Render backend is perfect for **low-bandwidth control + telemetry** but cannot handle:
- **Video stream**: 500KB-5MB/s (MJPEG)  
- **Map stream**: 100KB-10MB per update

This document analyzes alternatives for getting video and map data to remote users.

---

## Part 1: Alternative Server Hosting (CAN Handle Video/Maps)

### Option A: Fly.io (⭐ Recommended for Your Use Case)

**Why it's good for robotics:**
- **Edge deployment**: Run servers close to users globally
- **Persistent WebSockets**: First-class support
- **No cold starts**: Unlike serverless
- **Generous bandwidth**: 160GB/month free tier
- **Pay for what you use**: ~$0.02/GB after free tier

**Pricing:**
| Tier | Bandwidth | Cost |
|------|-----------|------|
| Free | 160 GB/mo | $0 |
| Usage | +$0.02/GB | Pay as you go |

**For your video stream (1 Mbps = 0.125 MB/s):**
- 1 hour viewing = 450 MB
- 10 hours/month = 4.5 GB ✅ Well within free tier

**Verdict:** ✅ Could host your entire backend here AND relay video if needed.

---

### Option B: Railway.app

**Pros:**
- Simple deployment (like Render)
- WebSocket support
- No cold starts
- $5/month gives you 100GB egress

**Cons:**
- Slightly more expensive than Fly
- Less edge presence

**Verdict:** ⚠️ Viable but Fly.io is better for this use case.

---

### Option C: DigitalOcean App Platform / Droplet

**Pros:**
- Predictable pricing
- Full control with Droplet
- 1TB bandwidth included on $6/mo Droplet

**Cons:**
- More setup work
- You manage the server

**Verdict:** ⚠️ Good if you want full control, overkill for relay.

---

### Option D: Self-Hosted (VPS + Nginx)

**Pros:**
- Cheapest at scale
- Full control
- Can run on a $5/mo VPS

**Cons:**
- You manage everything
- Security burden

**Verdict:** ⚠️ Only if you're comfortable with DevOps.

---

## Part 2: Tunneling Solutions (Expose Robot Directly)

These let you expose the robot's ports to the internet **without a relay server**.

### Option 1: Cloudflare Tunnel (⭐⭐ Best Overall)

**How it works:**
```
Browser → Cloudflare Edge → Tunnel → Robot (web_video_server:8080)
```

**Pros:**
- **FREE unlimited bandwidth**
- **DDoS protection** included
- **HTTPS** automatic
- Works behind NAT/firewalls
- No port forwarding needed

**Cons:**
- Requires Cloudflare account
- Slight latency (~50ms added)

**Setup on robot:**
```bash
# Install cloudflared
curl -L https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-archive-keyring.gpg] https://pkg.cloudflare.com/cloudflared focal main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install cloudflared

# Login (one time)
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create fordward-robot

# Run tunnel (expose video server)
cloudflared tunnel --url http://localhost:8080 --name fordward-video

# Run tunnel (expose rosbridge)
cloudflared tunnel --url http://localhost:9090 --name fordward-rosbridge
```

**Result:**
- Video: `https://fordward-video.yourdomain.com/stream?topic=/camera/image`
- Rosbridge: `wss://fordward-rosbridge.yourdomain.com`

**Verdict:** ✅✅ **Best for your use case.** Free, secure, fast.

---

### Option 2: Tailscale (⭐ Best for Private Access)

**How it works:**
```
Your Laptop ← Tailscale VPN → Robot
```

**Pros:**
- **FREE for 100 devices**
- Zero-config VPN
- Works anywhere
- Private (not public internet)
- Sub-10ms latency

**Cons:**
- Not for public access (only authorized devices)
- Need to install Tailscale on each viewing device

**Setup on robot:**
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

**Result:**
- Robot gets a Tailscale IP like `100.x.y.z`
- Access video at `http://100.x.y.z:8080/stream?topic=/camera/image`
- Access rosbridge at `ws://100.x.y.z:9090`

**Verdict:** ✅ **Perfect for your team/demo access.** Not for public users.

---

### Option 3: ngrok

**How it works:**
```
Browser → ngrok Edge → Tunnel → Robot
```

**Pros:**
- Simple setup
- Temporary URLs great for demos

**Cons:**
- **Free tier limited to 1GB/mo** ❌
- URLs change on restart (unless paid)
- $8/mo for stable URLs

**Setup:**
```bash
ngrok http 8080
# Gives you: https://abc123.ngrok.io
```

**Verdict:** ⚠️ Good for quick demos, too expensive for regular use.

---

### Option 4: Rathole / FRP (Self-Hosted Tunnel)

**How it works:**
- Run a relay on a cheap VPS
- Robot connects outbound to your VPS
- VPS exposes robot's ports

**Pros:**
- Cheapest at scale
- Full control
- No third-party dependency

**Cons:**
- Need to manage a VPS
- More setup work

**Verdict:** ⚠️ Good if you want to avoid third-party services.

---

## Part 3: Recommendation for Fordward

### Immediate (Phase 1): Tailscale for Your Team

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Your Mac   │     │ Lab Tablet  │     │ Demo Laptop │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │ Tailscale VPN
                  ┌────────▼────────┐
                  │  Fordward Robot │
                  │  100.x.y.z      │
                  │                 │
                  │  :8080 video    │
                  │  :9090 rosbridge│
                  └─────────────────┘
```

**Why:**
- Install Tailscale on robot + your devices
- Instant private network
- Video/rosbridge accessible from anywhere
- Your Render backend still handles coordination

---

### Future (Phase 2): Cloudflare Tunnel for Public Demo

```
┌─────────────────────────────────────────────────────────────────┐
│                         INTERNET                                 │
└─────────────────────────────────────────────────────────────────┘
         │                      │                      │
         ▼                      ▼                      ▼
  fordward.vercel.app    api.render.com      video.fordward.dev
  (Frontend)             (Control/Telemetry)  (Cloudflare Tunnel)
         │                      │                      │
         │                      │                      │
         └──────────────────────┼──────────────────────┘
                                │
                       ┌────────▼────────┐
                       │  Fordward Robot │
                       │  (behind NAT)   │
                       │                 │
                       │  cloud_bridge   │
                       │  cloudflared    │
                       └─────────────────┘
```

**Why:**
- Public users get video via Cloudflare (free)
- Control still goes through Render (validated)
- No relay bandwidth costs

---

## Quick Comparison

| Solution | Cost | Bandwidth | Public Access | Setup |
|----------|------|-----------|---------------|-------|
| **Cloudflare Tunnel** | Free | Unlimited | ✅ Yes | Medium |
| **Tailscale** | Free | Unlimited | ❌ Team only | Easy |
| **Fly.io (relay)** | $0-20/mo | 160GB+ | ✅ Yes | Medium |
| **ngrok** | $8/mo | 1GB free | ✅ Yes | Easy |
| **Self-hosted VPS** | $5-10/mo | 1TB+ | ✅ Yes | Hard |

---

## My Recommendation

1. **Now:** Install **Tailscale** on the robot and your devices. This gives you and your team instant access to video/rosbridge from anywhere.

2. **For demos:** Add **Cloudflare Tunnel** when you need to show the robot to external people without them installing anything.

3. **Keep Render:** Your control/telemetry backend stays on Render. It's perfect for what it does.

---

## Implementation Checklist

### Tailscale (Do This First)

- [ ] Create Tailscale account at https://tailscale.com
- [ ] Install on robot: `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`
- [ ] Install on your laptop/phone
- [ ] Test: `ping 100.x.y.z` (robot's Tailscale IP)
- [ ] Access video: `http://100.x.y.z:8080/stream?topic=/camera/image`

### Cloudflare Tunnel (Phase 2)

- [ ] Create Cloudflare account
- [ ] Add a domain (or use Cloudflare's free subdomain)
- [ ] Install cloudflared on robot
- [ ] Create tunnel: `cloudflared tunnel create fordward`
- [ ] Configure tunnel for video server
- [ ] Add to robot's systemd for auto-start

---

## Summary

**Don't try to relay video through your Node.js backend.** Instead:

| Data Type | Path |
|-----------|------|
| Commands, Telemetry, Control Lock | Frontend → Render → cloud_bridge |
| Video Stream | Frontend → Cloudflare/Tailscale → web_video_server |
| Map (if needed) | Frontend → Cloudflare/Tailscale → rosbridge |

This architecture gives you:
- ✅ Reliable control (Render handles coordination)
- ✅ Low-latency video (direct tunnel to robot)
- ✅ Works behind NAT/firewalls
- ✅ Free or very cheap
