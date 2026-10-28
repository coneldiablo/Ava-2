import axios from 'axios';

export const api = axios.create({
  baseURL: '/',
});

api.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export const storeToken = (token) => {
  localStorage.setItem('ava_token', token);
};

export const getStoredToken = () => {
  return localStorage.getItem('ava_token');
};

export const clearStoredToken = () => {
  localStorage.removeItem('ava_token');
};

export const downloadBlob = async (url) => {
  return await api.get(url, { responseType: 'blob' });
};
