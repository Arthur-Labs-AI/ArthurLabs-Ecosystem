import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import { createDesktopQueryClient } from './lib/query-client.js';
import './styles.css';
import './sentry-theme.css';

const container = document.getElementById('root');
if (container === null) throw new Error('Renderer root element is missing');
const root = createRoot(container);
const queryClient = createDesktopQueryClient();
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
