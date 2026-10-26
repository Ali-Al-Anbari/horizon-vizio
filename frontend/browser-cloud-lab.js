(function () {
  "use strict";
  var base = window.HorizonBrowserCore, cloud = window.HorizonCloudBrowserCore;
  var $ = function (id) { return document.getElementById(id); };
  var toolbar = $('toolbar'), address = $('address'), viewport = $('viewport'), image = $('frame');
  var cursorEl = $('cursor'), statusEl = $('status'), modeEl = $('mode');
  var controls = Array.prototype.slice.call(toolbar.querySelectorAll('button,input'));
  controls.push($('start'), document.querySelector('.exit'));
  var selected = controls.indexOf(address), mode = 'toolbar', keyboardTarget = null;
  var active = false, busy = false, seq = 0, stateVersion = 0;
  var cursor = { x: 300, y: 220, lastKey: '', streak: 0 };
  var imageUrl = null, samples = [], pairTimer = null, pendingPair = false;
  var remoteText = document.createElement('input'); remoteText.type = 'text'; remoteText.maxLength = 160;

  function clock() { return window.performance && performance.now ? performance.now() : Date.now(); }
  function state(text) { statusEl.textContent = text; }
  function setMode(value) {
    mode = value; modeEl.textContent = value === 'cursor' ? 'Cursor mode · Back returns to toolbar'
      : value === 'scroll' ? 'Scroll mode · Back returns to toolbar'
        : value === 'keyboard' ? 'Keyboard mode · Back cancels' : 'Toolbar mode';
    cursorEl.hidden = value !== 'cursor' && value !== 'scroll';
    if (value === 'toolbar' && !$('browser-panel').hidden) {
      try { controls[selected].focus({ preventScroll: true }); } catch (_error) { controls[selected].focus(); }
    }
    renderCursor();
  }
  function renderCursor() { cursorEl.style.transform = 'translate3d(' + cursor.x + 'px,' + cursor.y + 'px,0)'; }
  function errorCode(value) { return value && value.code ? String(value.code).replace(/_/g, ' ') : 'request failed'; }

  function noteTiming(start, responseAt, bodyAt, displayAt, response) {
    var ms = Math.max(0, Math.round(displayAt - start));
    samples.push(ms); if (samples.length > 40) samples.shift();
    if (location.search.indexOf('timing=1') >= 0) {
      $('timing').textContent = 'Action→image load ' + ms + ' ms; response headers '
        + Math.round(responseAt - start) + ' ms; image transfer ' + Math.round(bodyAt - responseAt)
        + ' ms; image load ' + Math.round(displayAt - bodyAt) + ' ms; remote action '
        + (response.headers.get('X-Browser-Action-Ms') || '?') + ' ms; capture '
        + (response.headers.get('X-Browser-Capture-Ms') || '?') + ' ms; DO queue '
        + (response.headers.get('X-Browser-Queue-Ms') || '?') + ' ms';
    }
  }
  function showFrame(response, start, responseAt) {
    return response.blob().then(function (blob) {
      var bodyAt = clock();
      if (blob.type !== 'image/jpeg' || blob.size > 1500000) throw new Error('invalid image');
      var next = URL.createObjectURL(blob);
      return new Promise(function (resolve, reject) {
        image.onload = function () {
          if (imageUrl) URL.revokeObjectURL(imageUrl);
          imageUrl = next;
          $('placeholder').hidden = true;
          noteTiming(start, responseAt || bodyAt, bodyAt, clock(), response);
          resolve();
        };
        image.onerror = function () { URL.revokeObjectURL(next); reject(new Error('image decode failed')); };
        image.src = next;
      });
    });
  }
  function write(path, data, action) {
    return fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Horizon-Action': action || 'browser' },
      body: JSON.stringify(data) });
  }
  function getJson(response) { return response.json().catch(function () { return {}; }).then(function (value) {
    if (!response.ok) throw new Error(errorCode(value)); return value;
  }); }
  function command(path, payload) {
    if (!active || busy) return Promise.resolve();
    stateVersion++;
    busy = true; state('Sending browser command…');
    var start = clock();
    // The sequence is spent locally before sending. An uncertain click is never retried.
    seq += 1; payload.seq = seq;
    return write(path, payload).then(function (response) {
      var responseAt = clock();
      if (!response.ok) return getJson(response);
      var returned = Number(response.headers.get('X-Browser-Seq'));
      if (returned !== seq) throw new Error('out of sequence response');
      return showFrame(response, start, responseAt).then(function () { state('Browser ready'); syncStatus(); });
    }).catch(function (error) {
      state('Command not confirmed: ' + error.message + '. Refresh status before another command.');
      return syncStatus();
    }).finally(function () { busy = false; });
  }
  function syncStatus() {
    var requestedVersion = stateVersion;
    return fetch('/api/browser/status', { credentials: 'same-origin', cache: 'no-store' })
      .then(getJson).then(function (value) {
        if (requestedVersion !== stateVersion) return value;
        if (!value.active || (value.seq || 0) >= seq) {
          active = value.active === true;
          seq = active ? Math.max(seq, value.seq || 0) : 0;
          if (value.url) address.value = value.url;
          if (!active) state('No active browser. Start a session.');
        }
        return value;
      }).catch(function (error) { state('Status unavailable: ' + error.message); });
  }
  function start() {
    if (busy) return;
    stateVersion++;
    busy = true; state('Starting Cloudflare browser…'); var started = clock();
    write('/api/browser/session', {}).then(function (response) {
      var responseAt = clock();
      if (!response.ok) return getJson(response);
      return showFrame(response, started, responseAt).then(function () {
        active = true; seq = Number(response.headers.get('X-Browser-Seq')) || 0;
        address.value = location.origin + '/browser-cloud-fixture.html';
        state('Browser ready · fixture loaded');
        selected = controls.indexOf(toolbar.querySelector('[data-action="cursor"]'));
        setMode('toolbar');
      });
    }).catch(function (error) { state('Browser start failed: ' + error.message); })
      .finally(function () { busy = false; });
  }
  function end() {
    if (busy) return; busy = true; stateVersion++;
    fetch('/api/browser/session', { method: 'DELETE', credentials: 'same-origin',
      headers: { 'X-Horizon-Action': 'browser' } }).then(getJson)
      .then(function () { active = false; seq = 0; state('Session ended');
        image.removeAttribute('src'); $('placeholder').hidden = false; setMode('toolbar'); })
      .catch(function (error) { state('End session failed: ' + error.message); })
      .finally(function () { busy = false; });
  }
  function navigate(text) {
    if (!active) { state('Start a browser session first'); return; }
    var result = base.resolveInput(text);
    if (result.kind === 'empty') return;
    if (!result.url) { state('Invalid address or search'); return; }
    address.value = result.url;
    command('/api/browser/navigate', { url: result.url });
  }
  var keyboard = new window.HorizonTVKeyboard($('keyboard'), $('keyboard-preview'), $('keyboard-grid'),
    function (_input, submitted) {
      var target = keyboardTarget; keyboardTarget = null; setMode('toolbar');
      if (!submitted) { state('Keyboard canceled'); return; }
      if (target === 'address') navigate(address.value);
      else if (target === 'page' && remoteText.value) {
        command('/api/browser/input', { type: 'text', text: remoteText.value }); remoteText.value = '';
      }
    });
  function openKeyboard(target) {
    if (busy) return;
    keyboardTarget = target;
    if (target === 'page') remoteText.value = '';
    keyboard.open(target === 'address' ? address : remoteText);
    setMode('keyboard');
  }
  function activate(action) {
    if (action === 'edit') openKeyboard('address');
    else if (action === 'type') openKeyboard('page');
    else if (action === 'go') navigate(address.value);
    else if (action === 'cursor' || action === 'scroll') { if (active) setMode(action); }
    else if (action === 'home') navigate(location.origin + '/browser-cloud-fixture.html');
    else if (action === 'end') end();
    else if (action === 'start') start();
    else if (action === 'exit') location.href = '/index.html';
    else if (action === 'back' || action === 'forward' || action === 'refresh')
      command('/api/browser/input', { type: action });
  }
  toolbar.addEventListener('click', function (event) {
    var action = event.target && event.target.getAttribute('data-action');
    if (action) { selected = controls.indexOf(event.target); activate(action); }
  });
  address.addEventListener('click', function () { selected = controls.indexOf(address); openKeyboard('address'); });
  $('start').setAttribute('data-action', 'start');
  document.querySelector('.exit').setAttribute('data-action', 'exit');
  $('start').addEventListener('click', function () { selected = controls.indexOf($('start')); start(); });
  $('diagnostics').addEventListener('click', function () {
    $('timing').textContent = samples.length ? 'Action→image callback: n=' + samples.length
      + ', p50 ' + cloud.percentile(samples, .5) + ' ms, p95 ' + cloud.percentile(samples, .95)
      + ' ms, max ' + Math.max.apply(null, samples) + ' ms. Display pixels may appear later.'
      : 'No timing samples yet.';
  });
  viewport.addEventListener('click', function (event) {
    if (mode !== 'cursor') return;
    var point = cloud.mapPoint(event.clientX, event.clientY, image.getBoundingClientRect());
    if (point) command('/api/browser/input', { type: 'click', x: point.x, y: point.y });
  });
  document.addEventListener('keydown', function (event) {
    var key = base.keyName(event);
    if (['OK','Back','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].indexOf(key) < 0) return;
    if (!$('pair-panel').hidden) {
      event.preventDefault(); event.stopPropagation();
      if (key === 'OK') $('pair-start').click();
      return;
    }
    // Own the remote before browser default focus scrolling or back navigation.
    event.preventDefault(); event.stopPropagation();
    if (mode === 'keyboard') {
      if (key === 'Back') keyboard.close(false);
      else if (key === 'OK') keyboard.press();
      else keyboard.move(key);
      return;
    }
    if (key === 'Back') { setMode('toolbar'); return; }
    if (mode === 'cursor' || mode === 'scroll') {
      if (key === 'OK' && mode === 'cursor') {
        var rect = image.getBoundingClientRect();
        var point = cloud.mapPoint(rect.left + cursor.x, rect.top + cursor.y, rect);
        if (point) command('/api/browser/input', { type: 'click', x: point.x, y: point.y });
      } else if (mode === 'scroll' && (key === 'ArrowUp' || key === 'ArrowDown')) {
        command('/api/browser/input', { type: 'scroll', deltaY: key === 'ArrowDown' ? 350 : -350 });
      } else if (key.indexOf('Arrow') === 0) {
        cursor = base.moveCursor(cursor, key, event.repeat === true, clock(), viewport.clientWidth, viewport.clientHeight);
        renderCursor();
      }
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowUp') selected = (selected + controls.length - 1) % controls.length;
    else if (key === 'ArrowRight' || key === 'ArrowDown') selected = (selected + 1) % controls.length;
    else if (key === 'OK') {
      var item = controls[selected], action = item.getAttribute('data-action');
      if (action) activate(action); else openKeyboard('address');
      return;
    }
    try { controls[selected].focus({ preventScroll: true }); } catch (_error) { controls[selected].focus(); }
  }, true);

  function checkPairing() {
    return fetch('/api/pair/session', { credentials: 'same-origin', cache: 'no-store' }).then(function (response) {
      $('pair-panel').hidden = response.ok; $('browser-panel').hidden = !response.ok;
      if (response.ok) {
        selected = controls.indexOf($('start'));
        setMode('toolbar');
        return syncStatus().then(function (current) {
          if (current && current.active) {
            selected = controls.indexOf(address); setMode('toolbar');
          }
          if (current && current.active) return fetch('/api/browser/frame', { credentials: 'same-origin', cache: 'no-store' })
            .then(function (frameResponse) { var at = clock(); return frameResponse.ok ? showFrame(frameResponse, at, at) : getJson(frameResponse); })
            .catch(function () { state('Session exists, but screenshot is unavailable.'); });
        });
      }
      $('pair-start').focus();
      state('Pairing required');
    }).catch(function () { $('pair-panel').hidden = false; state('Pairing service unavailable'); });
  }
  function pollPair() {
    if (!pendingPair) return;
    write('/api/pair/status', {}, 'pair').then(getJson).then(function (value) {
      if (value.state === 'paired') { pendingPair = false; $('pair-code').textContent = ''; return checkPairing(); }
      if (value.state !== 'pending') { pendingPair = false; $('pair-code').textContent = ''; state('Pairing expired or rejected'); return; }
      pairTimer = setTimeout(pollPair, 2000);
    }).catch(function () { pairTimer = setTimeout(pollPair, 3000); });
  }
  $('pair-start').addEventListener('click', function () {
    if (pendingPair) return;
    write('/api/pair/start', {}, 'pair').then(getJson).then(function (value) {
      $('pair-code').textContent = value.code;
      $('pair-url').textContent = 'On your phone or Mac, open ' + value.pairingUrl + ' and approve this code.';
      pendingPair = true; pollPair();
    }).catch(function (error) { $('pair-code').textContent = 'Pairing unavailable: ' + error.message; });
  });
  window.addEventListener('beforeunload', function () {
    if (pairTimer) clearTimeout(pairTimer);
    if (imageUrl) URL.revokeObjectURL(imageUrl);
  });
  checkPairing();
})();
