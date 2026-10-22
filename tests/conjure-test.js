const lastKey = document.querySelector('#last-key');
const rawKey = document.querySelector('#raw-key');
const eventCount = document.querySelector('#event-count');
const latency = document.querySelector('#input-latency');
const fps = document.querySelector('#fps');
const keyCells = [...document.querySelectorAll('.key-cell')];
let count = 0;
let flashTimer;
let frameCount = 0;
let sampleStart = performance.now();

function displayName(event) {
  switch (event.key) {
    case 'ArrowUp': return 'Up';
    case 'ArrowDown': return 'Down';
    case 'ArrowLeft': return 'Left';
    case 'ArrowRight': return 'Right';
    case 'Enter': return 'OK';
    case 'Escape':
    case 'Backspace':
    case 'BrowserBack': return 'Back';
    case 'Home': return 'Home';
    default: return event.key || 'Unknown';
  }
}

window.addEventListener('keydown', (event) => {
  const receivedAt = performance.now();
  const name = displayName(event);
  count += 1;
  lastKey.textContent = name;
  rawKey.textContent = `Raw key: ${event.key || 'Unknown'} · code: ${event.code || '—'} · keyCode: ${event.keyCode}`;
  eventCount.textContent = `Events: ${count}`;

  keyCells.forEach((cell) => cell.classList.toggle('is-active', cell.dataset.key === name));
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => keyCells.forEach((cell) => cell.classList.remove('is-active')), 350);
  if (name === 'Back' || name === 'Home') {
    document.querySelector(`#${name.toLowerCase()}-state`).textContent = `${name}: received`;
    document.querySelector(`#${name.toLowerCase()}-state`).classList.add('received');
  }
  requestAnimationFrame(() => { latency.textContent = (performance.now() - receivedAt).toFixed(1); });

  if (['Up', 'Down', 'Left', 'Right', 'OK', 'Back'].includes(name)) event.preventDefault();
});

function measureFrames(now) {
  frameCount += 1;
  if (now - sampleStart >= 1000) {
    fps.textContent = Math.round(frameCount * 1000 / (now - sampleStart));
    frameCount = 0;
    sampleStart = now;
  }
  requestAnimationFrame(measureFrames);
}
requestAnimationFrame(measureFrames);
