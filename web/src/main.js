import { ethers } from 'ethers';
import './style.css';

const apiUrl = import.meta.env.VITE_API_URL;
const chainId = Number(import.meta.env.VITE_CHAIN_ID || 11124);
const depositContract = import.meta.env.VITE_DEPOSIT_CONTRACT;
const creditPriceWei = BigInt(import.meta.env.VITE_CREDIT_PRICE_WEI || '1000000000000000');
const unityUrl = import.meta.env.VITE_UNITY_URL;
const chatWsUrl = import.meta.env.VITE_CHAT_WS_URL || 'ws://localhost:4000';

const state = {
  walletAddress: null,
  provider: null,
  signer: null,
  creditBalance: 0,
  equippedNote: null,
  equippedGear: null,
};

const app = document.querySelector('#app');

app.innerHTML = `
  <div class="layout">
    <header class="header">
      <div>
        <h1>Enoch Musics MVP</h1>
        <p>Web3 rhythm game lobby & controls</p>
      </div>
      <div class="wallet">
        <button id="connectWallet">Connect Wallet</button>
        <div id="walletAddress" class="muted"></div>
      </div>
    </header>

    <section class="panel">
      <h2>Credits</h2>
      <div class="row">
        <div>Balance: <span id="creditBalance">0</span></div>
        <button id="buyCredits">Buy 1 Credit (0.001 ETH)</button>
      </div>
    </section>

    <section class="panel">
      <h2>Play</h2>
      <div class="row">
        <button id="launchUnity">Launch Unity WebGL</button>
        <span class="muted">Unity URL: ${unityUrl}</span>
      </div>
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
      <h2>NFT Skins</h2>
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
const buyCreditsBtn = document.querySelector('#buyCredits');
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
  const response = await fetch(`${apiUrl}${path}`, { ...options, headers });
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
    skinsContainer.innerHTML = '<p class="muted">Connect wallet to view skins.</p>';
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
}

async function connectWallet() {
  if (!window.ethereum) {
    alert('Wallet not detected');
    return;
  }
  state.provider = new ethers.BrowserProvider(window.ethereum);
  const accounts = await state.provider.send('eth_requestAccounts', []);
  state.walletAddress = accounts[0].toLowerCase();
  walletLabel.textContent = state.walletAddress;

  const network = await state.provider.getNetwork();
  if (Number(network.chainId) !== chainId) {
    alert(`Please switch to chain ${chainId}`);
  }

  await apiFetch('/auth/wallet-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress: state.walletAddress }),
  });

  await refreshMe();
  await loadSkins();
}

async function buyCredits() {
  if (!state.walletAddress) {
    alert('Connect wallet first');
    return;
  }
  const order = await apiFetch('/credits/create-order', { method: 'POST' });

  const signer = await state.provider.getSigner();
  const depositAbi = ['function deposit(bytes32 orderId) payable'];
  const contract = new ethers.Contract(depositContract, depositAbi, signer);
  await contract.deposit(order.orderId, { value: creditPriceWei });
  alert('Deposit sent. Credits will appear after confirmations.');
}

connectBtn.addEventListener('click', connectWallet);
buyCreditsBtn.addEventListener('click', buyCredits);

let chatSocket;
function connectChat() {
  chatSocket = new WebSocket(chatWsUrl);
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
