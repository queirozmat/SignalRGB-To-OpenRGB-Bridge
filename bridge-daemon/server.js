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
let downstream;
let downstreamBuffer = Buffer.alloc(0);
let pendingPackets = [];
let pendingSize = 0;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer;

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
    log(`Persistent OpenRGB connection established at ${OPENRGB_HOST}:${OPENRGB_PORT}.`);
    flushPending();
  });

  upstream.on('data', (chunk) => {
    upstreamBuffer = Buffer.concat([upstreamBuffer, chunk]);
    upstreamBuffer = consumePackets(upstreamBuffer, (packet) => {
      if (downstream && !downstream.destroyed) {
        downstream.write(packet);
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
  if (downstream && !downstream.destroyed) {
    log('Replacing the previous SignalRGB client connection.');
    downstream.destroy();
  }

  downstream = socket;
  downstreamBuffer = Buffer.alloc(0);
  pendingPackets = [];
  pendingSize = 0;
  socket.setNoDelay(true);
  log(`SignalRGB connected from ${socket.remoteAddress}:${socket.remotePort}.`);

  socket.on('data', (chunk) => {
    downstreamBuffer = Buffer.concat([downstreamBuffer, chunk]);
    downstreamBuffer = consumePackets(downstreamBuffer, queueForUpstream);
  });

  socket.on('error', (error) => {
    log(`SignalRGB connection error: ${error.code || error.message}.`);
  });

  socket.on('close', () => {
    if (downstream === socket) {
      downstream = undefined;
      downstreamBuffer = Buffer.alloc(0);
      pendingPackets = [];
      pendingSize = 0;
    }
    log('SignalRGB disconnected; persistent OpenRGB connection kept alive.');
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
  if (downstream) downstream.destroy();
  if (upstream) upstream.destroy();
  setTimeout(() => process.exit(0), 100).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
