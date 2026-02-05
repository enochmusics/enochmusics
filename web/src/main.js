import './style.css';

const apiUrl = import.meta.env.VITE_API_URL;
const unityUrl = import.meta.env.VITE_UNITY_URL;
const chatWsUrl = import.meta.env.VITE_CHAT_WS_URL || 'wss://localhost:4000';
const allowInsecureLocal = import.meta.env.VITE_ALLOW_INSECURE_LOCAL === 'true' || import.meta.env.DEV;

const state = {
  walletAddress: null,
  creditBalance: 0,
  equippedNote: null,
  equippedGear: null,
};

const app = document.querySelector('#app');

function isLocalhost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function enforceSecureUrl(rawUrl, label) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new Error(`${label} must be a valid URL`);
  }
  if (parsed.protocol === 'https:' || parsed.protocol === 'wss:') {
    return parsed.toString();
  }
  if (allowInsecureLocal && (parsed.protocol === 'http:' || parsed.protocol === 'ws:') && isLocalhost(parsed.hostname)) {
    return parsed.toString();
  }
  throw new Error(`${label} must use TLS (https/wss).`);
}

let secureApiUrl;
let secureChatWsUrl;
try {
  secureApiUrl = enforceSecureUrl(apiUrl, 'VITE_API_URL');
  secureChatWsUrl = enforceSecureUrl(chatWsUrl, 'VITE_CHAT_WS_URL');
} catch (error) {
  console.error(error);
  app.innerHTML = '<p class="muted">Secure connection required. Check your HTTPS/WSS configuration.</p>';
  throw error;
}

app.innerHTML = `
  <div class="layout">
    <header class="header">
      <div>
        <p class="eyebrow">Hub / Lobby</p>
        <h1>Enoch Musics Command Center</h1>
        <p class="muted">Manage your wallet, credits, skins, and rankings before launching a run.</p>
      </div>
      <div class="wallet">
        <div class="wallet-status">
          <span class="status-dot" id="walletStatusDot"></span>
          <span id="walletStatusText">Disconnected</span>
        </div>
        <button id="connectWallet">Connect Account</button>
        <div id="walletAddress" class="muted"></div>
      </div>
    </header>

    <section class="panel grid">
      <div class="card">
        <h2>Wallet</h2>
        <p class="muted">Server-managed wallet session for gameplay and purchases.</p>
        <div class="stat">
          <span>Account</span>
          <strong id="walletSummary">Not connected</strong>
        </div>
        <div class="stat">
          <span>Credits</span>
          <strong><span id="creditBalance">0</span> available</strong>
        </div>
      </div>
      <div class="card">
        <h2>Credits Store</h2>
        <p class="muted">Purchase credits from the server. Credits appear after confirmations.</p>
        <div class="row">
          <button id="buyCredits">Buy 1 Credit (0.001 ETH)</button>
          <span id="purchaseStatus" class="muted">No purchase yet.</span>
        </div>
      </div>
      <div class="card">
        <h2>Launch Game</h2>
        <p class="muted">Unity WebGL handles live gameplay only.</p>
        <div class="row">
          <button id="launchUnity">Launch Unity WebGL</button>
          <span class="muted">Unity URL: ${unityUrl}</span>
        </div>
      </div>
    </section>

    <section class="panel">
      <h2>Unity WebGL - Gameplay Client</h2>
      <iframe id="unityFrame" title="Unity WebGL" class="unity" src="${unityUrl}"></iframe>
    </section>

    <section class="panel grid">
      <div>
        <h2>Score Leaderboard</h2>
        <ul id="scoreLeaderboard" class="leaderboard"></ul>
      </div>
      <div>
        <h2>Ticket Leaderboard</h2>
        <ul id="ticketLeaderboard" class="leaderboard"></ul>
      </div>
    </section>

    <section class="panel">
      <h2>Skins Hub</h2>
      <p class="muted">Equip skins in the lobby before your next run.</p>
      <div id="skins" class="skins"></div>
    </section>

    <section class="panel">
      <h2>Lobby Chat (UI-only)</h2>
      <div class="chat">
        <div id="chatLog" class="chat-log"></div>
        <div class="row">
          <input id="chatInput" placeholder="Say hello..." />
          <button id="sendChat">Send</button>
        </div>
      </div>
    </section>
  </div>
`;

const connectBtn = document.querySelector('#connectWallet');
const walletLabel = document.querySelector('#walletAddress');
const creditBalanceLabel = document.querySelector('#creditBalance');
const walletSummary = document.querySelector('#walletSummary');
const walletStatusDot = document.querySelector('#walletStatusDot');
const walletStatusText = document.querySelector('#walletStatusText');
const buyCreditsBtn = document.querySelector('#buyCredits');
const purchaseStatus = document.querySelector('#purchaseStatus');
const scoreLeaderboard = document.querySelector('#scoreLeaderboard');
const ticketLeaderboard = document.querySelector('#ticketLeaderboard');
const skinsContainer = document.querySelector('#skins');
const chatLog = document.querySelector('#chatLog');
const chatInput = document.querySelector('#chatInput');
const sendChat = document.querySelector('#sendChat');

function renderLeaderboard(listEl, rows, valueKey) {
  listEl.innerHTML = rows
    .map((row, index) => `<li>${index + 1}. ${row.wallet_address} - ${row[valueKey]}</li>`)
    .join('');
}

async function apiFetch(path, options = {}) {
  const headers = options.headers || {};
  if (state.walletAddress) {
    headers['x-wallet-address'] = state.walletAddress;
  }
  const response = await fetch(`${secureApiUrl}${path}`, { ...options, headers });
  if (!response.ok) {
    throw new Error(`${response.status}`);
  }
  return response.json();
}

async function loadLeaderboards() {
  const score = await apiFetch('/leaderboards/score');
  const tickets = await apiFetch('/leaderboards/tickets');
  renderLeaderboard(scoreLeaderboard, score.leaderboard || [], 'raw_score');
  renderLeaderboard(ticketLeaderboard, tickets.leaderboard || [], 'raffle_tickets_total');
}

async function loadSkins() {
  if (!state.walletAddress) {
    skinsContainer.innerHTML = '<p class="muted">Connect account to view skins.</p>';
    return;
  }
  const data = await apiFetch('/skins/available');
  state.equippedNote = data.equipped_note_skin_id;
  state.equippedGear = data.equipped_gear_skin_id;
  skinsContainer.innerHTML = data.skins
    .map((skin) => {
      const isUnlocked = data.unlockedSkinIds.includes(skin.skin_id);
      const equipped = skin.skin_id === state.equippedNote || skin.skin_id === state.equippedGear;
      return `
        <div class="skin">
          <div class="skin-title">${skin.display_name}</div>
          <div class="muted">${skin.skin_type.toUpperCase()} | Asset: ${skin.asset_ref}</div>
          <div class="row">
            <span class="badge ${isUnlocked ? 'badge-ok' : 'badge-locked'}">${isUnlocked ? 'Unlocked' : 'Locked'}</span>
            <button data-skin="${skin.skin_id}" data-type="${skin.skin_type}" ${!isUnlocked ? 'disabled' : ''}>
              ${equipped ? 'Equipped' : 'Equip'}
            </button>
          </div>
        </div>
      `;
    })
    .join('');

  skinsContainer.querySelectorAll('button[data-skin]').forEach((button) => {
    button.addEventListener('click', async () => {
      const skinId = Number(button.dataset.skin);
      const skinType = button.dataset.type;
      await apiFetch('/skins/equip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skinId, skinType }),
      });
      await loadSkins();
    });
  });
}

async function refreshMe() {
  if (!state.walletAddress) return;
  const me = await apiFetch('/me');
  creditBalanceLabel.textContent = me.user.credit_balance;
  walletSummary.textContent = me.user.wallet_address;
}

async function connectWallet() {
  purchaseStatus.textContent = 'Connecting...';
  const response = await apiFetch('/auth/server-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  state.walletAddress = response.user.wallet_address;
  walletLabel.textContent = state.walletAddress;
  walletSummary.textContent = state.walletAddress;
  walletStatusDot.classList.add('active');
  walletStatusText.textContent = 'Connected';
  purchaseStatus.textContent = 'Ready to purchase credits.';

  await refreshMe();
  await loadSkins();
}

async function buyCredits() {
  if (!state.walletAddress) {
    alert('Connect account first');
    return;
  }
  purchaseStatus.textContent = 'Creating order...';
  const orderRequest = await apiFetch('/credits/create-order', { method: 'POST' });
  purchaseStatus.textContent = 'Sending deposit...';
  const order = await apiFetch('/credits/buy', {
    method: 'POST',
    body: JSON.stringify({ orderId: orderRequest.orderId }),
  });
  purchaseStatus.textContent = `Deposit sent. Tx: ${order.txHash}`;
  alert(`Deposit sent. Credits will appear after confirmations.\nTx: ${order.txHash}`);
}

connectBtn.addEventListener('click', connectWallet);
buyCreditsBtn.addEventListener('click', buyCredits);

let chatSocket;
function connectChat() {
  chatSocket = new WebSocket(secureChatWsUrl);
  chatSocket.onmessage = (event) => {
    const message = document.createElement('div');
    message.textContent = event.data;
    chatLog.appendChild(message);
    chatLog.scrollTop = chatLog.scrollHeight;
  };
  chatSocket.onopen = () => {
    const join = document.createElement('div');
    join.textContent = 'Connected to lobby chat.';
    chatLog.appendChild(join);
  };
  chatSocket.onerror = () => {
    const error = document.createElement('div');
    error.textContent = 'Chat connection error.';
    chatLog.appendChild(error);
  };
}

sendChat.addEventListener('click', () => {
  if (!chatSocket || chatSocket.readyState !== WebSocket.OPEN) {
    alert('Chat not connected');
    return;
  }
  chatSocket.send(`${state.walletAddress ?? 'guest'}: ${chatInput.value}`);
  chatInput.value = '';
});

connectChat();
loadLeaderboards();
