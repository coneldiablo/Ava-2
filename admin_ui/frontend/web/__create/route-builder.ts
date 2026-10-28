import { Hono } from 'hono';
import type { Handler } from 'hono/types';
import updatedFetch from '../src/__create/fetch';

const API_BASENAME = '/api';
const api = new Hono();
const routeLoaders = import.meta.glob('../src/app/api/**/route.js');

if (globalThis.fetch) {
  globalThis.fetch = updatedFetch;
}

function getHonoPath(routeFile: string): string {
  const relativePath = routeFile.replace('../src/app/api', '');
  const parts = relativePath.split('/').filter(Boolean);
  const routeParts = parts.slice(0, -1);

  if (routeParts.length === 0) {
    return '/';
  }

  return `/${routeParts
    .map((segment) => {
      const match = segment.match(/^\[(\.{3})?([^\]]+)\]$/);
      if (!match) {
        return segment;
      }

      const [, dots, param] = match;
      return dots === '...' ? `:${param}{.+}` : `:${param}`;
    })
    .join('/')}`;
}

async function registerRoutes() {
  const routeFiles = Object.keys(routeLoaders).sort((a, b) => b.length - a.length);

  api.routes = [];

  for (const routeFile of routeFiles) {
    const loadRoute = routeLoaders[routeFile];
    if (!loadRoute) {
      continue;
    }

    try {
      const route = await loadRoute();

      for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
        if (!route[method]) {
          continue;
        }

        const honoPath = getHonoPath(routeFile);
        const handler: Handler = async (c) => {
          const params = c.req.param();
          const currentRoute = import.meta.env.DEV ? await loadRoute() : route;
          return currentRoute[method](c.req.raw, { params });
        };

        switch (method.toLowerCase()) {
          case 'get':
            api.get(honoPath, handler);
            break;
          case 'post':
            api.post(honoPath, handler);
            break;
          case 'put':
            api.put(honoPath, handler);
            break;
          case 'delete':
            api.delete(honoPath, handler);
            break;
          case 'patch':
            api.patch(honoPath, handler);
            break;
          default:
            break;
        }
      }
    } catch (error) {
      console.error(`Error importing route file ${routeFile}:`, error);
    }
  }
}

const registerRoutesPromise = registerRoutes();

if (import.meta.env.DEV) {
  import.meta.glob('../src/app/api/**/route.js', {
    eager: true,
  });

  if (import.meta.hot) {
    import.meta.hot.accept(() => {
      registerRoutes().catch((error) => {
        console.error('Error reloading routes:', error);
      });
    });
  }
}

export { api, API_BASENAME, registerRoutes, registerRoutesPromise };
