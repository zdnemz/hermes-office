(function () {
  'use strict';
  const form = document.getElementById('login-form');
  const input = document.getElementById('password');
  const err = document.getElementById('password-err');
  const btn = document.getElementById('submit');
  const toggle = document.getElementById('toggle-pw');

  toggle.addEventListener('click', function () {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Sembunyikan' : 'Tampilkan';
    toggle.setAttribute('aria-pressed', show ? 'true' : 'false');
    input.focus();
  });
  input.addEventListener('input', function () {
    if (input.value) { input.removeAttribute('aria-invalid'); err.textContent = ''; }
  });

  function setError(msg) {
    err.textContent = msg;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    input.select();
  }

  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    if (!input.value) { setError('Masukkan password admin.'); return; }
    btn.disabled = true;
    btn.classList.add('is-loading');
    btn.querySelector('span').textContent = 'Memeriksa';
    try {
      const res = await fetch('/api/login', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: input.value })
      });
      let data = {};
      try { data = await res.json(); } catch (e) { /* bukan JSON */ }
      if (res.ok && data.success) { window.location.replace('/'); return; }
      setError(res.status === 429
        ? (data.error || 'Terlalu banyak percobaan.') + '.'
        : (data.error ? data.error.charAt(0).toUpperCase() + data.error.slice(1) + '.' : 'Login gagal (HTTP ' + res.status + ').'));
    } catch (e) {
      setError('Server tidak bisa dihubungi. Periksa koneksi lalu coba lagi.');
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-loading');
      btn.querySelector('span').textContent = 'Masuk';
    }
  });
  input.focus();
}());
