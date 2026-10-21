'use strict';

const { EventEmitter } = require('events');

// Process-wide bus. utils.log/warn publish here, and lib/runner.js emits
// structured job events. The web server subscribes and streams to the UI.
const bus = new EventEmitter();
bus.setMaxListeners(50);

module.exports = bus;
