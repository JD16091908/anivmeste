window.ChatModule = (() => {
  function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  }

  function formatMessageWithLinks(text) {
    const escaped = escapeHtml(text);
    const urlRegex = /(https?:\/\/[^\s<]+)/g;
    return escaped.replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color: #4da6ff; text-decoration: none;">$1</a>');
  }

  function scrollToBottom(chatMessages) {
    if (!chatMessages) return;
    setTimeout(() => {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }, 10);
  }

  function appendMessage(chatMessages, { username, message, time, isSelf = false }) {
    if (!chatMessages) return;

    const div = document.createElement('div');
    div.className = `chat-message ${isSelf ? 'self-message' : ''}`;

    const header = document.createElement('div');
    header.className = 'chat-message-header';
    header.innerHTML = `
      <strong>${escapeHtml(username)}</strong>
      <span class="chat-time">${escapeHtml(time || '')}</span>
    `;

    const body = document.createElement('div');
    body.className = 'chat-message-body';
    body.innerHTML = formatMessageWithLinks(message || '');

    div.appendChild(header);
    div.appendChild(body);
    chatMessages.appendChild(div);

    scrollToBottom(chatMessages);
  }

  function appendSystemMessage(chatMessages, text) {
    if (!chatMessages) return;

    const div = document.createElement('div');
    div.className = 'chat-message system-message';
    div.innerHTML = `<em>${escapeHtml(text)}</em>`;

    chatMessages.appendChild(div);
    scrollToBottom(chatMessages);
  }

  function clearChat(chatMessages) {
    if (!chatMessages) return;
    chatMessages.innerHTML = '';
  }

  return {
    appendMessage,
    appendSystemMessage,
    clearChat,
    escapeHtml
  };
})();