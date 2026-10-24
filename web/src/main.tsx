import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { applyAppTheme, appTheme } from './readingPrefs';
import { flagTouchPrimary } from './device';
import './styles.css';

// Theme and device flags go on <html> BEFORE the first render: the stylesheet
// keys every colour off html[data-app-theme], and a late flip would paint one
// frame of the wrong palette at startup.
applyAppTheme(appTheme());
flagTouchPrimary();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
