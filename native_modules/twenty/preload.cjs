'use strict';

// Loaded only in Twenty's HTTP server process via NODE_OPTIONS. This keeps the
// official Community image intact: no EE source or licence path is touched.
require('./runtime-config.cjs').applyBootstrapContext(process.env);
const { NestFactory } = require('@nestjs/core');
const { install } = require('./install.cjs');

const create = NestFactory.create.bind(NestFactory);
NestFactory.create = async (...args) => {
  const app = await create(...args);
  // Twenty adds its body parsers in main.ts after NestFactory.create(). Delay
  // installation until listen: force app.init() first, then install before a
  // socket is bound. This gives the guard the complete route stack and parsed
  // GraphQL payloads without a race against bootstrap registration.
  let installed = false;
  // Nest 11 returns a Proxy whose set trap deliberately ignores writes. An
  // assignment to app.listen therefore appears to succeed but never changes
  // the method. Return our own read-intercepting proxy instead.
  return new Proxy(app, {
    get(target, property, receiver) {
      if (property !== 'listen') return Reflect.get(target, property, receiver);
      const listen = Reflect.get(target, property, receiver).bind(target);
      return async (...listenArgs) => {
        if (!installed) {
          await target.init();
          await install(target);
          installed = true;
        }
        return listen(...listenArgs);
      };
    },
  });
};
