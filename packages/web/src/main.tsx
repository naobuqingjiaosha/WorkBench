import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './design.css';
import './home.css';
import './compact.css';
import './desktop.css';
import './pages/library-pages.css';
import './work-management.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
