const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "OpenRGBBridge.js"), "utf8");

assert.match(source, /const DEFAULT_PORT = 6742;/, "the addon must connect directly to the OpenRGB SDK");
assert.match(source, /Number\(configuredPort\) === 9730/, "legacy proxy settings must migrate away from port 9730");
assert.match(source, /this\.startupRecoveryPending = true;/, "startup recovery must begin armed");
assert.match(source, /client\.protocolVersion >= 5/, "automatic rescan must be restricted to SDK v5+");
assert.match(source, /self\.startupRecoveryPending = false;/, "automatic rescan must disarm before sending");
assert.match(source, /client\.requestRescanDevices\(\)/, "startup recovery must use OpenRGB's official rescan command");
assert.match(source, /setTimeout\(readControllers, STARTUP_RESCAN_SETTLE_MS\)/, "controller discovery must wait for rescan completion");
assert.match(source, /if \(self\.startupRescanInProgress\)/, "device-list notifications must not trigger a rescan loop");
assert.match(source, /this\.protocolVersion < 5/, "the client must reject rescan on older SDK versions");

console.log("OpenRGB startup-recovery validation passed.");
