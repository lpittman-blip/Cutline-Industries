const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request } = require('./api-client.js');
test('rejects successful HTML fallback instead of pretending signup worked', async () => {
  global.fetch = async () => new Response('<html>Home</html>', { status: 200 });
  await assert.rejects(request('/api/auth/signup', { method: 'POST', body: {} }), error => error.code === 503);
});
test('preserves missing-route status for a non-JSON 404', async () => {
  global.fetch = async () => new Response('NOT_FOUND', { status: 404 });
  await assert.rejects(request('/api/me'), error => error.code === 404);
});
test('calls the Artemis gateway with credentialed CORS and sends CSRF on authenticated writes', async () => {
  let captured;
  global.fetch = async (url, options) => { captured = { url, options }; return new Response(JSON.stringify({ ok: true })); };
  assert.deepEqual(await request('/api/settings', { method: 'PATCH', body: { retention_days: 30 } }, { csrf: 'test-csrf' }), { ok: true });
  assert.equal(captured.url, 'https://api.artemisai-bycutlineindustries.studio/api/settings');
  assert.equal(captured.options.method, 'PATCH');
  assert.equal(captured.options.credentials, 'include');
  assert.equal(captured.options.headers['X-CSRF-Token'], 'test-csrf');
  assert.equal(captured.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(captured.options.body), { retention_days: 30 });
});
test('sends no CSRF header on reads, but still includes credentials', async () => {
  let captured;
  global.fetch = async (url, options) => { captured = { url, options }; return new Response(JSON.stringify({ user: null })); };
  await request('/api/me', {}, { csrf: 'test-csrf' });
  assert.equal(captured.url, 'https://api.artemisai-bycutlineindustries.studio/api/me');
  assert.equal(captured.options.method, 'GET');
  assert.equal(captured.options.credentials, 'include');
  assert.equal('X-CSRF-Token' in captured.options.headers, false);
});
test('rejects a full-URL or protocol-relative endpoint before sending credentials', async () => {
  global.fetch = async () => { throw new Error('Fetch must not execute'); };
  await assert.rejects(request('//other.example/api/me'), /Invalid application endpoint/);
  await assert.rejects(request('https://other.example/api/me'), /Invalid application endpoint/);
});
test('preserves a server validation message', async () => {
  global.fetch = async () => new Response(JSON.stringify({ error: 'Invalid email' }), { status: 400 });
  await assert.rejects(request('/api/auth/signup'), error => error.code === 400 && error.message === 'Invalid email');
});
