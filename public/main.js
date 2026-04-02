const USERNAME_STORAGE = 'username';
const MANUAL_USERNAME_STORAGE = 'saved_username_manual';

const CONFIG = window.AnivmesteConfig || {};
const SUPPORT_CONFIG = CONFIG.support || {};
const BOOSTY_URL = SUPPORT_CONFIG.boostyUrl || '#';
const DONATIONALERTS_URL = SUPPORT_CONFIG.donationAlertsUrl || '#';

const RANDOM_NICK_ADJECTIVES = [
  'Swift', 'Silent', 'Crimson', 'Silver', 'Golden', 'Shadow', 'Lunar', 'Solar', 'Misty', 'Stormy',
  'Frozen', 'Burning', 'Shining', 'Dark', 'Bright', 'Wild', 'Calm', 'Rapid', 'Lucky', 'Cosmic',
  'Electric', 'Ancient', 'Hidden', 'Secret', 'Fierce', 'Gentle', 'Brave', 'Noble', 'Clever', 'Crazy',
  'Dreamy', 'Ghostly', 'Royal', 'Tiny', 'Mega', 'Hyper', 'Epic', 'Magic', 'Cyber', 'Neon',
  'Velvet', 'Iron', 'Crystal', 'Phantom', 'Thunder', 'Ashen', 'Scarlet', 'Emerald', 'Ivory', 'Obsidian',
  'Azure', 'Ruby', 'Sapphire', 'Amber', 'Pearl', 'Snowy', 'Windy', 'Dizzy', 'Mellow', 'Glowing',
  'Stealthy', 'Vivid', 'Arcane', 'Quantum', 'Pixel', 'Turbo', 'Nova', 'Stellar', 'Void', 'Night',
  'Dawn', 'Dusk', 'Blazing', 'Chill', 'Savage', 'Elegant', 'Fearless', 'Wicked', 'Radiant', 'Hollow'
];

const RANDOM_NICK_NOUNS = [
  'Fox', 'Wolf', 'Tiger', 'Dragon', 'Phoenix', 'Raven', 'Falcon', 'Hawk', 'Panda', 'Rabbit',
  'Samurai', 'Ninja', 'Ronin', 'Knight', 'Wizard', 'Mage', 'Hunter', 'Rider', 'Pirate', 'Guardian',
  'Otter', 'Bear', 'Eagle', 'Shark', 'Panther', 'Lynx', 'Crow', 'Viper', 'Leopard', 'Cobra',
  'Kitsune', 'Tanuki', 'Yokai', 'Spirit', 'Ghost', 'Demon', 'Angel', 'Comet', 'Meteor', 'Star',
  'Moon', 'Blade', 'Arrow', 'Storm', 'Flame', 'Frost', 'Thunder', 'Shadow', 'Spark', 'Stone',
  'Echo', 'Whisper', 'Glitch', 'Pixel', 'Byte', 'Cipher', 'Nova', 'Orbit', 'Voyager', 'Drifter',
  'Wanderer', 'Sage', 'Monk', 'Brawler', 'Sniper', 'Scout', 'Captain', 'King', 'Queen', 'Prince',
  'Princess', 'Beast', 'Slayer', 'Seeker', 'Walker', 'Chaser', 'Nomad', 'Reaper', 'Sentinel', 'Alchemist'
];

function sanitizeUsername(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 30);
}

function pickRandomItem(items) {
  if (!Array.isArray(items) || !items.length) return null;
  const randomIndex = Math.floor(Math.random() * items.length);
  return items[randomIndex] || null;
}

function generateRandomNickname() {
  const variants = [];

  for (const adjective of RANDOM_NICK_ADJECTIVES) {
    for (const noun of RANDOM_NICK_NOUNS) {
      variants.push(`${adjective} ${noun}`);
    }
  }

  if (!variants.length) {
    return `Guest${Math.floor(1000 + Math.random() * 9000)}`;
  }

  const randomBase = pickRandomItem(variants) || 'Guest';
  const suffix = Math.floor(10 + Math.random() * 90);
  return `${randomBase}${suffix}`.slice(0, 30);
}

function saveUsername(name, isManual = true) {
  const username = sanitizeUsername(name);
  if (!username) return '';
  localStorage.setItem(USERNAME_STORAGE, username);
  localStorage.setItem(MANUAL_USERNAME_STORAGE, isManual ? '1' : '0');
  return username;
}

function getSavedUsername() {
  const saved = sanitizeUsername(localStorage.getItem(USERNAME_STORAGE));
  const hasManual = localStorage.getItem(MANUAL_USERNAME_STORAGE) === '1';

  if (hasManual && saved) return saved;

  const generated = generateRandomNickname();
  saveUsername(generated, false);
  return generated;
}

function sanitizeRoomId(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 50);
}

function generateRoomId() {
  return `room-${Math.random().toString(36).slice(2, 8)}`;
}

function redirectToRoom(roomId, username) {
  const safeRoomId = sanitizeRoomId(roomId);
  const safeUsername = sanitizeUsername(username);

  if (!safeRoomId) {
    alert('Не удалось определить ID комнаты');
    return;
  }

  const query = safeUsername ? `?username=${encodeURIComponent(safeUsername)}` : '';
  window.location.href = `/room/${encodeURIComponent(safeRoomId)}${query}`;
}

function setupRevealAnimations() {
  const items = document.querySelectorAll('.reveal');
  if (!items.length) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, {
    threshold: 0.12
  });

  items.forEach((item) => observer.observe(item));
}

function setupModal({
  modalId,
  openBtnId,
  closeBtnId,
  backdropId
}) {
  const modal = document.getElementById(modalId);
  const openBtn = document.getElementById(openBtnId);
  const closeBtn = document.getElementById(closeBtnId);
  const backdrop = document.getElementById(backdropId);

  if (!modal || !openBtn || !closeBtn || !backdrop) return null;

  let isAnimating = false;

  const open = () => {
    if (isAnimating) return;
    modal.classList.remove('hidden', 'is-hiding');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');

    requestAnimationFrame(() => {
      modal.classList.add('is-visible');
    });
  };

  const close = () => {
    if (isAnimating || modal.classList.contains('hidden')) return;

    isAnimating = true;
    modal.classList.remove('is-visible');
    modal.classList.add('is-hiding');

    setTimeout(() => {
      modal.classList.add('hidden');
      modal.classList.remove('is-hiding');
      modal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('modal-open');
      isAnimating = false;
    }, 220);
  };

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);

  return { modal, open, close };
}

function setupSupportContent() {
  const description = document.getElementById('supportModalDescription');
  const thanks = document.getElementById('supportModalThanks');
  const boostyLink = document.getElementById('supportBoostyLink');
  const donationAlertsLink = document.getElementById('supportDonationAlertsLink');

  if (description) {
    description.textContent = SUPPORT_CONFIG.description || '';
  }

  if (thanks) {
    thanks.textContent = SUPPORT_CONFIG.thanksText || '';
  }

  if (boostyLink) {
    boostyLink.href = BOOSTY_URL;
  }

  if (donationAlertsLink) {
    donationAlertsLink.href = DONATIONALERTS_URL;
  }
}

function setupHomeActions() {
  const usernameInput = document.getElementById('username');
  const roomIdInput = document.getElementById('roomId');
  const createRoomBtn = document.getElementById('createRoomBtn');
  const joinRoomBtn = document.getElementById('joinRoomBtn');
  const soloWatchBtn = document.getElementById('soloWatchBtn');

  if (!usernameInput || !roomIdInput || !createRoomBtn || !joinRoomBtn || !soloWatchBtn) {
    return;
  }

  usernameInput.value = getSavedUsername();

  const resolveUsername = () => {
    const raw = sanitizeUsername(usernameInput.value);
    const username = raw || generateRandomNickname();
    usernameInput.value = username;
    saveUsername(username, true);
    return username;
  };

  createRoomBtn.addEventListener('click', () => {
    const username = resolveUsername();
    const roomId = generateRoomId();
    redirectToRoom(roomId, username);
  });

  joinRoomBtn.addEventListener('click', () => {
    const username = resolveUsername();
    const roomId = sanitizeRoomId(roomIdInput.value);

    if (!roomId) {
      alert('Введите ID комнаты');
      roomIdInput.focus();
      return;
    }

    redirectToRoom(roomId, username);
  });

  soloWatchBtn.addEventListener('click', () => {
    const username = resolveUsername();
    redirectToRoom('solo', username);
  });

  usernameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      if (roomIdInput.value.trim()) {
        joinRoomBtn.click();
      } else {
        createRoomBtn.click();
      }
    }
  });

  roomIdInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      joinRoomBtn.click();
    }
  });
}

function init() {
  setupRevealAnimations();
  setupSupportContent();
  setupHomeActions();

  const aboutModalApi = setupModal({
    modalId: 'aboutModal',
    openBtnId: 'aboutServiceBtn',
    closeBtnId: 'closeAboutModalBtn',
    backdropId: 'aboutModalBackdrop'
  });

  const supportModalApi = setupModal({
    modalId: 'supportModal',
    openBtnId: 'supportProjectBtn',
    closeBtnId: 'closeSupportModalBtn',
    backdropId: 'supportModalBackdrop'
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;

    const supportModal = supportModalApi?.modal;
    const aboutModal = aboutModalApi?.modal;

    if (supportModal && !supportModal.classList.contains('hidden')) {
      supportModalApi.close();
      return;
    }

    if (aboutModal && !aboutModal.classList.contains('hidden')) {
      aboutModalApi.close();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);