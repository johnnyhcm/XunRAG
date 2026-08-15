import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './i18n';
import AntdProvider from './AntdProvider';
import App from './App';
import './styles/index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AntdProvider>
        <App />
      </AntdProvider>
    </BrowserRouter>
  </React.StrictMode>,
);