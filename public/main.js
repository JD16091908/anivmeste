const usernameInput = document.getElementById('username');
const roomIdInput = document.getElementById('roomId');

const USERNAME_STORAGE = 'username';

const savedUsername = localStorage.getItem(USERNAME_STORAGE);
if (savedUsername && usernameInput) {
  usernameInput.value = savedUsername;
}

function sanitizeUsername(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 30);
}

function getUsername() {
  const username = sanitizeUsername(usernameInput?.value) || 'Гость';
  localStorage.setItem(USERNAME_STORAGE, username);
  return username;
}

document.getElementById('createRoomBtn')?.addEventListener('click', () => {
  const username = getUsername();
  const roomId = 'room-' + Math.random().toString(36).slice(2, 8);
  window.location.href = `/room/${roomId}?username=${encodeURIComponent(username)}`;
});

document.getElementById('joinRoomBtn')?.addEventListener('click', () => {
  const username = getUsername();
  const roomId = roomIdInput?.value.trim();

  if (!roomId) {
    alert('Введите ID комнаты');
    return;
  }

  window.location.href = `/room/${roomId}?username=${encodeURIComponent(username)}`;
});

document.getElementById('soloWatchBtn')?.addEventListener('click', () => {
  const username = getUsername();
  window.location.href = `/room/solo?username=${encodeURIComponent(username)}`;
});

const aboutServiceBtn = document.getElementById('aboutServiceBtn');
const aboutModal = document.getElementById('aboutModal');
const aboutModalBackdrop = document.getElementById('aboutModalBackdrop');
const closeAboutModalBtn = document.getElementById('closeAboutModalBtn');

function openAboutModal() {
  if (!aboutModal) return;
  aboutModal.classList.remove('hidden');
  aboutModal.classList.add('is-visible');
  aboutModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
}

function closeAboutModal() {
  if (!aboutModal) return;
  aboutModal.classList.remove('is-visible');
  aboutModal.classList.add('is-hiding');

  setTimeout(() => {
    aboutModal.classList.add('hidden');
    aboutModal.classList.remove('is-hiding');
    aboutModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
  }, 220);
}

aboutServiceBtn?.addEventListener('click', openAboutModal);
aboutModalBackdrop?.addEventListener('click', closeAboutModal);
closeAboutModalBtn?.addEventListener('click', closeAboutModal);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && aboutModal && !aboutModal.classList.contains('hidden')) {
    closeAboutModal();
  }
});

window.addEventListener('load', () => {
  document.querySelectorAll('.reveal').forEach((el) => {
    el.classList.add('is-visible');
  });
});