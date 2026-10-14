// Renders the splash or the start-up error from the URL fragment:
//   #starting                     -> "Starting iPhone AI…"
//   #error=<encodeURIComponent(JSON)> -> { title, message, log, lines[] }
// Everything is inserted with textContent (never as HTML).
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const starting = $('starting');
  const failed = $('failed');
  const status = $('starting-status');
  let slowTimer = 0;

  function readError() {
    const hash = window.location.hash.slice(1);
    if (!hash.startsWith('error=')) return null;
    try {
      const value = JSON.parse(decodeURIComponent(hash.slice('error='.length)));
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  function render() {
    window.clearTimeout(slowTimer);
    const error = readError();
    starting.hidden = error !== null;
    failed.hidden = error === null;

    if (error === null) {
      status.textContent = 'Starting iPhone AI…';
      slowTimer = window.setTimeout(() => {
        status.textContent = 'Still starting… connecting to iPhone Mirroring can take a moment.';
      }, 8000);
      return;
    }

    $('error-title').textContent = typeof error.title === 'string' ? error.title : 'iPhone AI couldn’t start';
    $('error-message').textContent =
      typeof error.message === 'string' ? error.message : 'The iPhone AI backend could not be started.';
    $('error-log').textContent = typeof error.log === 'string' ? error.log : '';
    const lines = Array.isArray(error.lines) ? error.lines.filter((line) => typeof line === 'string') : [];
    $('error-output-box').hidden = lines.length === 0;
    $('error-output').textContent = lines.join('\n');
    $('retry').focus();
  }

  window.addEventListener('hashchange', render);
  render();
})();
