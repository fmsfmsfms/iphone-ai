import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import { startFrameLoader } from './lib/frames';
import { startLiveScreen } from './lib/live-screen';
import { ensureDefaultHash } from './lib/router';
import { startRealtime } from './lib/ws';
import { bootstrap } from './state/store';

ensureDefaultHash();
startFrameLoader();
void bootstrap();
startRealtime();
startLiveScreen();

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
