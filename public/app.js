const $ = id => document.getElementById(id);
const fileInput = $('ipa-input');
const dropZone = $('drop-zone');
const uploadButton = $('upload-button');
const uploadLabel = $('upload-button-label');
const selectedFile = $('selected-file');
const errorBox = $('error-message');
const progressPanel = $('upload-progress');
const resultPanel = $('result-panel');
let selected = null;
let busy = false;
let config = {maxIpaBytes: 4 * 1024 ** 3, maxIpaLabel: '4 GB', urlTtlSeconds: 86400, urlTtlLabel: '24 hours'};

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
function setError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}
function setProgress(percent, loaded = 0, total = 0, state = 'Uploading') {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  $('progress-percent').textContent = `${Math.round(pct)}%`;
  $('progress-bar').style.width = `${pct}%`;
  $('progress-bytes').textContent = total > 0 ? `${formatBytes(loaded)} / ${formatBytes(total)}` : `${formatBytes(loaded)} uploaded`;
  $('progress-state').textContent = state;
}
function resetProgress() {
  progressPanel.hidden = true;
  $('progress-bar').style.width = '0%';
  $('progress-percent').textContent = '0%';
  $('progress-bytes').textContent = 'Preparing upload';
  $('progress-state').textContent = 'Live progress';
}
function refreshSelection() {
  const valid = selected && selected.name.toLowerCase().endsWith('.ipa') && selected.size > 0 && selected.size <= config.maxIpaBytes;
  selectedFile.hidden = !selected;
  if (selected) {
    $('selected-name').textContent = selected.name;
    $('selected-size').textContent = formatBytes(selected.size);
    $('drop-title').textContent = selected.name;
    $('drop-title').title = selected.name;
    $('upload-button-label').textContent = valid ? 'Upload IPA and create URL' : 'Choose a valid IPA';
    if (!selected.name.toLowerCase().endsWith('.ipa')) setError('Only .ipa files are accepted.');
    else if (selected.size > config.maxIpaBytes) setError(`This file exceeds the ${config.maxIpaLabel} upload limit.`);
    else if (selected.size === 0) setError('This file is empty. Choose a non-empty IPA.');
    else setError('');
  } else {
    $('drop-title').textContent = 'Drop your .ipa file here';
    $('drop-title').removeAttribute('title');
    $('upload-button-label').textContent = 'Choose an IPA to begin';
  }
  uploadButton.disabled = busy || !valid;
}
function chooseFile(file) {
  if (!file) return;
  selected = file;
  resultPanel.hidden = true;
  resetProgress();
  refreshSelection();
}
function humanExpiry(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Link expires soon';
  return `Expires ${date.toLocaleString()}`;
}
function showResult(data) {
  resultPanel.hidden = false;
  $('ipa-url').value = data.ipaUrl || data.url || '';
  $('result-file').textContent = `${data.fileName || selected?.name || 'app.ipa'} · ${data.fileSizeFormatted || formatBytes(data.fileSize || selected?.size || 0)}`;
  $('result-expires').textContent = humanExpiry(data.expiresAt);
  resultPanel.scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest'});
  const previous = $('copy-url').textContent;
  navigator.clipboard?.writeText($('ipa-url').value).catch(() => {});
  uploadLabel.textContent = previous;
}
function uploadFile() {
  if (busy || !selected) return;
  const form = new FormData();
  form.append('ipa', selected, selected.name);
  busy = true;
  setError('');
  resultPanel.hidden = true;
  progressPanel.hidden = false;
  $('progress-label').textContent = 'Uploading to Tigris…';
  setProgress(0, 0, selected.size, 'Connecting');
  uploadButton.disabled = true;
  uploadLabel.textContent = 'Uploading IPA…';
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/uploads');
  xhr.responseType = 'json';
  xhr.upload.addEventListener('progress', event => {
    if (event.lengthComputable) setProgress(event.loaded / event.total * 100, event.loaded, event.total, 'Uploading');
    else setProgress(0, event.loaded, selected.size, 'Uploading');
  });
  xhr.upload.addEventListener('load', () => {
    $('progress-label').textContent = 'Finalizing secure link…';
    setProgress(100, selected.size, selected.size, 'Finalizing');
  });
  xhr.addEventListener('load', () => {
    const data = xhr.response || {};
    if (xhr.status < 200 || xhr.status >= 300 || data.success !== true || !(data.ipaUrl || data.url)) {
      setError(data.error || `Upload failed (HTTP ${xhr.status}). Please try again.`);
      return finish(false);
    }
    setProgress(100, selected.size, selected.size, 'Complete');
    $('progress-label').textContent = 'Upload complete';
    showResult(data);
    finish(true);
  });
  xhr.addEventListener('error', () => { setError('Network error during upload. Your browser connection may have been interrupted; try again.'); finish(false); });
  xhr.addEventListener('abort', () => { setError('Upload cancelled.'); finish(false); });
  xhr.addEventListener('timeout', () => { setError('Upload timed out. Please retry with a stable connection.'); finish(false); });
  xhr.timeout = 0;
  xhr.send(form);
  function finish(success) {
    busy = false;
    uploadButton.disabled = !selected || selected.size > config.maxIpaBytes || !selected.name.toLowerCase().endsWith('.ipa');
    uploadLabel.textContent = success ? 'Upload another IPA' : 'Retry upload';
    if (success) uploadButton.disabled = true;
    refreshSelection();
    if (success) uploadLabel.textContent = 'Upload another IPA';
  }
}

dropZone.addEventListener('click', () => { if (!busy) fileInput.click(); });
dropZone.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && !busy) { event.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => { chooseFile(fileInput.files?.[0]); fileInput.value = ''; });
for (const name of ['dragenter', 'dragover']) dropZone.addEventListener(name, event => { event.preventDefault(); if (!busy) dropZone.classList.add('is-dragging'); });
for (const name of ['dragleave', 'drop']) dropZone.addEventListener(name, event => { event.preventDefault(); dropZone.classList.remove('is-dragging'); });
dropZone.addEventListener('drop', event => { if (!busy) chooseFile(event.dataTransfer?.files?.[0]); });
$('remove-file').addEventListener('click', () => { if (busy) return; selected = null; resultPanel.hidden = true; setError(''); resetProgress(); refreshSelection(); });
uploadButton.addEventListener('click', () => { if (!busy && resultPanel.hidden) uploadFile(); else if (!busy && !resultPanel.hidden) { selected = null; resultPanel.hidden = true; resetProgress(); refreshSelection(); fileInput.click(); } });
$('upload-another').addEventListener('click', () => { if (busy) return; selected = null; resultPanel.hidden = true; setError(''); resetProgress(); refreshSelection(); fileInput.click(); });
$('copy-url').addEventListener('click', async () => {
  const input = $('ipa-url');
  try {
    await navigator.clipboard.writeText(input.value);
    $('copy-url').textContent = 'Copied!';
  } catch {
    input.focus(); input.select();
    const copied = document.execCommand('copy');
    $('copy-url').textContent = copied ? 'Copied!' : 'Select URL';
  }
  setTimeout(() => $('copy-url').textContent = 'Copy URL', 1800);
});
const logo = document.querySelector('.brand-icon');
logo.addEventListener('error', () => { logo.hidden = true; document.querySelector('.brand-fallback').hidden = false; });
$('year').textContent = new Date().getFullYear();
fetch('/api/config', {headers: {accept: 'application/json'}, cache: 'no-store'}).then(response => response.ok ? response.json() : null).then(data => {
  if (!data) return;
  config = {...config, ...data};
  $('max-size').textContent = data.maxIpaLabel;
  $('max-size-side').textContent = data.maxIpaLabel;
  $('url-lifetime').textContent = data.urlTtlLabel;
  refreshSelection();
}).catch(() => {});
refreshSelection();
