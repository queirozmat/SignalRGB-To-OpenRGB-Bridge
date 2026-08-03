'use strict';

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const LISTEN_HOST = process.env.OPENRGB_BRIDGE_LISTEN_HOST || '127.0.0.1';
const LISTEN_PORT = parsePort(process.env.OPENRGB_BRIDGE_LISTEN_PORT, 9730);
const OPENRGB_HOST = process.env.OPENRGB_HOST || '127.0.0.1';
const OPENRGB_PORT = parsePort(process.env.OPENRGB_PORT, 6742);
const MAX_PACKET_SIZE = 16 * 1024 * 1024;
const MAX_PENDING_SIZE = 2 * 1024 * 1024;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5000;

const stateDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'OpenRGBBridge');
const logPath = path.join(stateDir, 'bridge.log');
fs.mkdirSync(stateDir, { recursive: true });
rotateLog();

let upstream;
let upstreamConnected = false;
let upstreamBuffer = Buffer.alloc(0);
const downstreams = new Set();
let pendingPackets = [];
let pendingSize = 0;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer;
let protocolResponse;
let clientNameSent = false;
const customModeDevices = new Set();

function timestamp() {
  return new Date().toISOString();
}

function log(message) {
  const line = `${timestamp()} ${message}`;
  process.stdout.write(line + '\n');
  try {
    fs.appendFileSync(logPath, line + '\n');
  } catch (_) {
  }
}

function rotateLog() {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size >= 1024 * 1024) {
      fs.renameSync(logPath, logPath + '.old');
    }
  } catch (_) {
  }
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function packetLength(buffer) {
  if (buffer.length < 16) {
    return 0;
  }
  if (buffer.toString('ascii', 0, 4) !== 'ORGB') {
    return -1;
  }
  const payloadLength = buffer.readUInt32LE(12);
  if (payloadLength > MAX_PACKET_SIZE) {
    return -1;
  }
  return 16 + payloadLength;
}

function consumePackets(buffer, onPacket) {
  let remaining = buffer;
  while (remaining.length >= 16) {
    const length = packetLength(remaining);
    if (length < 0) {
      const nextMagic = remaining.indexOf('ORGB', 1, 'ascii');
      remaining = nextMagic >= 0 ? remaining.subarray(nextMagic) : Buffer.alloc(0);
      continue;
    }
    if (length === 0 || remaining.length < length) {
      break;
    }
    onPacket(remaining.subarray(0, length));
    remaining = remaining.subarray(length);
  }
  return Buffer.from(remaining);
}

function packetCommand(packet) {
  return packet.length >= 12 ? packet.readUInt32LE(8) : -1;
}

function packetDevice(packet) {
  return packet.length >= 8 ? packet.readUInt32LE(4) : 0;
}

function routeDownstreamPacket(packet, socket) {
  const command = packetCommand(packet);
  const deviceId = packetDevice(packet);

  // OpenRGB associates protocol negotiation with the lifetime of its TCP
  // session. SignalRGB restarts create a new downstream session while this
  // daemon deliberately keeps the upstream session alive. Replay the original
  // negotiation response locally instead of renegotiating the same connection.
  if (command === 40 && protocolResponse) {
    if (socket && !socket.destroyed) {
      socket.write(protocolResponse);
    }
    log('Replayed cached OpenRGB protocol response for a restarted SignalRGB client.');
    return;
  }

  // The client name is a connection-scoped property and only needs to be sent
  // once for the persistent upstream connection.
  if (command === 50 && clientNameSent) {
    return;
  }

  // Direct/custom mode is also sticky for the MSI controller. Reapplying it on
  // every SignalRGB plugin reload can leave older OpenRGB servers accepting
  // packets without updating the hardware.
  if (command === 1100 && customModeDevices.has(deviceId)) {
    log(`Ignored duplicate SetCustomMode for OpenRGB device ${deviceId}.`);
    return;
  }

  if (command === 50) {
    clientNameSent = true;
  } else if (command === 1100) {
    customModeDevices.add(deviceId);
  }

  queueForUpstream(packet);
}

function queueForUpstream(packet) {
  if (upstreamConnected && upstream && !upstream.destroyed) {
    upstream.write(packet);
    return;
  }
  if (pendingSize + packet.length > MAX_PENDING_SIZE) {
    pendingPackets = [];
    pendingSize = 0;
    log('Pending queue reset after reaching its safety limit.');
  }
  pendingPackets.push(Buffer.from(packet));
  pendingSize += packet.length;
}

function flushPending() {
  if (!upstreamConnected || !upstream) {
    return;
  }
  for (const packet of pendingPackets) {
    upstream.write(packet);
  }
  if (pendingPackets.length) {
    log(`Forwarded ${pendingPackets.length} queued packet(s) to OpenRGB.`);
  }
  pendingPackets = [];
  pendingSize = 0;
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectUpstream();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

function connectUpstream() {
  if (upstream && !upstream.destroyed) {
    return;
  }

  upstream = net.createConnection({ host: OPENRGB_HOST, port: OPENRGB_PORT });
  upstream.setNoDelay(true);

  upstream.on('connect', () => {
    upstreamConnected = true;
    reconnectDelay = RECONNECT_MIN_MS;
    protocolResponse = undefined;
    clientNameSent = false;
    customModeDevices.clear();
    log(`Persistent OpenRGB connection established at ${OPENRGB_HOST}:${OPENRGB_PORT}.`);
    flushPending();
  });

  upstream.on('data', (chunk) => {
    upstreamBuffer = Buffer.concat([upstreamBuffer, chunk]);
    upstreamBuffer = consumePackets(upstreamBuffer, (packet) => {
      if (packetCommand(packet) === 40) {
        protocolResponse = Buffer.from(packet);
      }
      for (const socket of downstreams) {
        if (!socket.destroyed) {
          socket.write(packet);
        }
      }
    });
  });

  upstream.on('error', (error) => {
    log(`OpenRGB connection error: ${error.code || error.message}.`);
  });

  upstream.on('close', () => {
    upstreamConnected = false;
    upstream = undefined;
    upstreamBuffer = Buffer.alloc(0);
    log('OpenRGB connection closed; retrying without affecting SignalRGB startup.');
    scheduleReconnect();
  });
}

const server = net.createServer((socket) => {
  downstreams.add(socket);
  let socketBuffer = Buffer.alloc(0);
  socket.setNoDelay(true);
  log(`SignalRGB connected from ${socket.remoteAddress}:${socket.remotePort} (${downstreams.size} active client(s)).`);

  socket.on('data', (chunk) => {
    socketBuffer = Buffer.concat([socketBuffer, chunk]);
    socketBuffer = consumePackets(socketBuffer, (packet) => routeDownstreamPacket(packet, socket));
  });

  socket.on('error', (error) => {
    log(`SignalRGB connection error: ${error.code || error.message}.`);
  });

  socket.on('close', () => {
    downstreams.delete(socket);
    socketBuffer = Buffer.alloc(0);
    if (downstreams.size === 0) {
      pendingPackets = [];
      pendingSize = 0;
    }
    log(`SignalRGB disconnected; ${downstreams.size} active client(s), persistent OpenRGB connection kept alive.`);
  });
});

server.on('error', (error) => {
  log(`Bridge listener error: ${error.code || error.message}.`);
  process.exitCode = 1;
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`Bridge listening for SignalRGB at ${LISTEN_HOST}:${LISTEN_PORT}.`);
  log(`Log file: ${logPath}`);
  connectUpstream();
});

function shutdown(signal) {
  log(`Received ${signal}; shutting down.`);
  server.close();
  for (const socket of downstreams) socket.destroy();
  downstreams.clear();
  if (upstream) upstream.destroy();
  setTimeout(() => process.exit(0), 100).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
