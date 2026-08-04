const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "OpenRGBBridge.js"), "utf8");

assert.match(source, /const DEFAULT_PORT = 6742;/, "the addon must connect directly to the OpenRGB SDK");
assert.match(source, /Number\(configuredPort\) === 9730/, "legacy proxy settings must migrate away from port 9730");
assert.match(source, /const MSI_RECOVERY_DELAY_MS = 30000;/, "MSI recovery must wait for SignalRGB startup to settle");
assert.match(source, /const MSI_RECOVERY_SETTLE_MS = 8000;/, "MSI recovery must wait for OpenRGB rescan completion");
assert.match(source, /MSI B450 TOMAHAWK/, "automatic recovery must be scoped to the affected motherboard");
assert.match(source, /MS-7C02/, "automatic recovery must recognize the motherboard model identifier");
assert.match(source, /renderRecoveryScheduled = true;/, "automatic recovery must run only once per plugin load");
assert.match(source, /client\.requestRescanDevices\(\)/, "startup recovery must use OpenRGB's official rescan command");
assert.match(source, /state\.lastFrameSignatures = \{\};/, "recovery must force the current color frame to be sent again");
assert.match(source, /state\.customModeSet = false;/, "recovery must restore OpenRGB direct mode after rescan");
assert.doesNotMatch(source, /startupRecoveryPending/, "discovery must not rescan before SignalRGB rendering starts");
assert.match(source, /this\.protocolVersion < 5/, "the client must reject rescan on older SDK versions");

console.log("OpenRGB startup-recovery validation passed.");
