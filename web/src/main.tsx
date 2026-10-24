import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { applyAppTheme, appTheme } from './readingPrefs';
import { flagTouchPrimary } from './device';
import { installBackGuard } from './backNav';
import './styles.css';

// Theme and device flags go on <html> BEFORE the first render: the stylesheet
// keys every colour off html[data-app-theme], and a late flip would paint one
// frame of the wrong palette at startup.
applyAppTheme(appTheme());
flagTouchPrimary();
// The hardware-back guard must be registered before react-router mounts its
// own popstate listener: it intercepts in the capture phase so an open overlay
// can consume a back press before the router navigates.
installBackGuard();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
