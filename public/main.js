const usernameInput = document.getElementById('username');
const roomIdInput = document.getElementById('roomId');

const savedUsername = localStorage.getItem('username');
if (savedUsername) {
  usernameInput.value = savedUsername;
}

function getUsername() {
  const username = usernameInput.value.trim() || 'Гость';
  localStorage.setItem('username', username);
  return username;
}

document.getElementById('createRoomBtn').addEventListener('click', () => {
  const username = getUsername();
  const roomId = 'room-' + Math.random().toString(36).slice(2, 8);
  window.location.href = `/room/${roomId}?username=${encodeURIComponent(username)}`;
});

document.getElementById('joinRoomBtn').addEventListener('click', () => {
  const username = getUsername();
  const roomId = roomIdInput.value.trim();

  if (!roomId) {
    alert('Введите ID комнаты');
    return;
  }

  window.location.href = `/room/${roomId}?username=${encodeURIComponent(username)}`;
});

document.getElementById('soloWatchBtn').addEventListener('click', () => {
  const username = getUsername();
  window.location.href = `/room/solo?username=${encodeURIComponent(username)}`;
});