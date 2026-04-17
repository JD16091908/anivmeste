const USERNAME_STORAGE = 'username';

const CONFIG = window.AnivmesteConfig || {};
const SUPPORT_CONFIG = CONFIG.support || {};

function safeLocalStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function sanitizeUsername(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 30);
}

function generateRandomNickname() {
  const adj = ['Swift', 'Silent', 'Crimson', 'Shadow', 'Wild', 'Epic', 'Neon', 'Velvet'];
  const noun = ['Fox', 'Wolf', 'Dragon', 'Ninja', 'Hunter', 'Blade', 'Star', 'Ghost'];
  return `${adj[Math.floor(Math.random() * adj.length)]} ${noun[Math.floor(Math.random() * noun.length)]}`;
}

function getSavedUsername() {
  const saved = sanitizeUsername(safeLocalStorageGet(USERNAME_STORAGE));
  if (saved) return saved;

  const generated = generateRandomNickname();
  safeLocalStorageSet(USERNAME_STORAGE, generated);
  return generated;
}

function generateSecureToken(length = 24) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function buildRoomUrl(roomId, username) {
  const params = new URLSearchParams();
  if (username) params.set('username', username);
  const qs = params.toString();
  return qs ? `/room/${encodeURIComponent(roomId)}?${qs}` : `/room/${encodeURIComponent(roomId)}`;
}

function redirectToRoom(roomId, username) {
  const targetUrl = buildRoomUrl(roomId, username);
  window.location.assign(targetUrl);
}

function removeLegacyJoinControls() {
  const legacyJoinBtn = document.getElementById('joinRoomBtn');
  const legacyRoomInput = document.getElementById('roomId');

  if (legacyJoinBtn) legacyJoinBtn.remove();
  if (legacyRoomInput) {
    const wrapper = legacyRoomInput.closest('.form-group') || legacyRoomInput.parentElement;
    if (wrapper) wrapper.remove();
  }
}

function forceShowRevealBlocks() {
  const revealNodes = document.querySelectorAll('.reveal');
  revealNodes.forEach((node) => {
    node.classList.add('revealed', 'is-visible');
    node.style.opacity = '1';
    node.style.transform = 'none';
    node.style.visibility = 'visible';
  });
}

function openModal(modalEl) {
  if (!modalEl) return;
  modalEl.classList.remove('hidden', 'is-hiding');
  modalEl.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => modalEl.classList.add('is-visible'));
}

function closeModal(modalEl) {
  if (!modalEl || modalEl.classList.contains('hidden')) return;
  modalEl.classList.remove('is-visible');
  modalEl.classList.add('is-hiding');

  setTimeout(() => {
    modalEl.classList.add('hidden');
    modalEl.classList.remove('is-hiding');
    modalEl.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
  }, 220);
}

function setupModals() {
  const aboutModal = document.getElementById('aboutModal');
  const supportModal = document.getElementById('supportModal');

  const aboutServiceBtn = document.getElementById('aboutServiceBtn');
  const supportProjectBtn = document.getElementById('supportProjectBtn');

  const closeAboutModalBtn = document.getElementById('closeAboutModalBtn');
  const closeSupportModalBtn = document.getElementById('closeSupportModalBtn');

  const aboutModalBackdrop = document.getElementById('aboutModalBackdrop');
  const supportModalBackdrop = document.getElementById('supportModalBackdrop');

  const supportBoostyLink = document.getElementById('supportBoostyLink');
  const supportDonationAlertsLink = document.getElementById('supportDonationAlertsLink');
  const supportModalDescription = document.getElementById('supportModalDescription');
  const supportModalThanks = document.getElementById('supportModalThanks');

  if (supportBoostyLink) supportBoostyLink.href = SUPPORT_CONFIG.boostyUrl || '#';
  if (supportDonationAlertsLink) supportDonationAlertsLink.href = SUPPORT_CONFIG.donationAlertsUrl || '#';
  if (supportModalDescription) supportModalDescription.textContent = SUPPORT_CONFIG.description || '';
  if (supportModalThanks) supportModalThanks.textContent = SUPPORT_CONFIG.thanksText || '';

  aboutServiceBtn?.addEventListener('click', () => openModal(aboutModal));
  supportProjectBtn?.addEventListener('click', () => openModal(supportModal));

  closeAboutModalBtn?.addEventListener('click', () => closeModal(aboutModal));
  closeSupportModalBtn?.addEventListener('click', () => closeModal(supportModal));

  aboutModalBackdrop?.addEventListener('click', () => closeModal(aboutModal));
  supportModalBackdrop?.addEventListener('click', () => closeModal(supportModal));

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (aboutModal && !aboutModal.classList.contains('hidden')) closeModal(aboutModal);
    if (supportModal && !supportModal.classList.contains('hidden')) closeModal(supportModal);
  });
}

function setupHomeActions() {
  removeLegacyJoinControls();
  forceShowRevealBlocks();
  setupModals();

  const usernameInput = document.getElementById('username');
  const createRoomBtn = document.getElementById('createRoomBtn');
  const soloWatchBtn = document.getElementById('soloWatchBtn');

  if (!usernameInput || !createRoomBtn || !soloWatchBtn) return;

  usernameInput.value = getSavedUsername();

  const getUsername = () => {
    const value = sanitizeUsername(usernameInput.value) || generateRandomNickname();
    safeLocalStorageSet(USERNAME_STORAGE, value);
    return value;
  };

  const goCreateRoom = () => {
    const roomId = `r_${generateSecureToken(24)}`;
    redirectToRoom(roomId, getUsername());
  };

  const goSoloRoom = () => {
    redirectToRoom('solo', getUsername());
  };

  createRoomBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    goCreateRoom();
  });

  soloWatchBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    goSoloRoom();
  });

  usernameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      goCreateRoom();
    }
  });

  // Защитный delegated-handler в capture phase:
  // если где-то есть конфликт обработчиков/перекрытий, кнопки все равно выполнят переход.
  document.addEventListener('click', (event) => {
    const createTarget = event.target?.closest?.('#createRoomBtn');
    if (createTarget) {
      event.preventDefault();
      event.stopImmediatePropagation();
      goCreateRoom();
      return;
    }

    const soloTarget = event.target?.closest?.('#soloWatchBtn');
    if (soloTarget) {
      event.preventDefault();
      event.stopImmediatePropagation();
      goSoloRoom();
    }
  }, true);
}

document.addEventListener('DOMContentLoaded', setupHomeActions);