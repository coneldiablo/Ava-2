import { api } from './api';
import yaml from 'js-yaml';

export const cloneConfig = (config) => JSON.parse(JSON.stringify(config ?? {}));

export const fetchYamlConfig = async () => {
  const response = await api.get('/api/config/yaml');
  const content = response.data?.content || '';
  let parsed = {};
  if (content.trim()) {
    parsed = yaml.load(content) || {};
  }
  return {
    ...response.data,
    parsed,
  };
};

export const saveYamlConfig = async (configOrYaml) => {
  const content = typeof configOrYaml === 'string'
    ? configOrYaml
    : yaml.dump(configOrYaml || {}, {
      noRefs: true,
      sortKeys: false,
      lineWidth: -1,
    });
  const response = await api.post('/api/config/yaml', { content });
  return response.data;
};

export const getCoffeeCrmUrl = () => {
  const publicEnv = typeof process !== 'undefined' ? process.env : {};
  const configured =
    import.meta.env?.NEXT_PUBLIC_COFFEE_CRM_URL
    || publicEnv?.NEXT_PUBLIC_COFFEE_CRM_URL
    || import.meta.env?.NEXT_PUBLIC_CRM_URL
    || publicEnv?.NEXT_PUBLIC_CRM_URL
    || import.meta.env?.NEXT_PUBLIC_WHATSAPP_CRM_URL
    || publicEnv?.NEXT_PUBLIC_WHATSAPP_CRM_URL
    || import.meta.env?.VITE_WHATSAPP_CRM_URL;
  if (configured) {
    return configured;
  }
  if (typeof window === 'undefined') {
    return 'http://localhost:3000';
  }
  const host = window.location.hostname;
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (localHost) {
    return `${window.location.protocol}//${host}:3000`;
  }
  if (host.startsWith('ai.')) {
    return `${window.location.protocol}//wh.${host.slice(3)}`;
  }
  return `${window.location.protocol}//${host}:3011`;
};

export const getWhatsAppCrmUrl = getCoffeeCrmUrl;
