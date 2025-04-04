const fs = require('fs');
const path = require('path');
const ethers = require('ethers');
const axios = require('axios');
const readline = require('readline');
const FormData = require('form-data');
const TelegramBot = require('node-telegram-bot-api');

// ---------------------------
// Persistent file names and defaults
// ---------------------------
const BLOCKED_FILE = 'blocked.json';
const USAGE_FILE = 'usage.json';
const STATS_FILE = 'stats.json';
const USERS_FILE = 'users.json';
const WALLETS_FILE = 'wallets.json';
const WELCOME_FILE = 'welcome.txt';
const SUFFIX_FILE = 'suffix.txt';
const MAXLIMIT_FILE = 'maxlimit.json';
const GLOBALCAPTION_FILE = 'globalcaption.txt';

const DEFAULT_WELCOME = `*This bot is for Quack AI referrals & auto-chat!*
Quack AI Airdrop Link: https://quack-ai-api.duckchain.io
This bot was made by @vikitoshi and @Muhannad2025`;

const DEFAULT_MAX_LIMIT = 100;

// ---------------------------
// Helper functions for persistence
// ---------------------------
function loadJSON(filename, defaultValue) {
  try {
    if (fs.existsSync(filename)) {
      return JSON.parse(fs.readFileSync(filename, 'utf8'));
    }
  } catch (err) {
    console.error(`Error reading ${filename}:`, err.message);
  }
  return defaultValue;
}

function saveJSON(filename, data) {
  fs.writeFileSync(filename, JSON.stringify(data, null, 2));
}

function loadText(filename, defaultText) {
  try {
    if (fs.existsSync(filename)) {
      return fs.readFileSync(filename, 'utf8');
    }
  } catch (err) {
    console.error(`Error reading ${filename}:`, err.message);
  }
  return defaultText;
}

let blockedUsers = loadJSON(BLOCKED_FILE, []);
let usageData = loadJSON(USAGE_FILE, {}); // { chatId: { date: 'YYYY-MM-DD', count: number } }
let stats = loadJSON(STATS_FILE, { totalUsers: 0, totalWalletRequests: 0 });
let usersList = loadJSON(USERS_FILE, []); // array of chat IDs
let walletsData = loadJSON(WALLETS_FILE, { wallets: [] });
let welcomeMessage = loadText(WELCOME_FILE, DEFAULT_WELCOME);
let suffix = loadText(SUFFIX_FILE, "");
let maxLimit = loadJSON(MAXLIMIT_FILE, DEFAULT_MAX_LIMIT);
let globalCaption = loadText(GLOBALCAPTION_FILE, "");

// ---------------------------
// Telegram and Admin Globals
// ---------------------------
let bot;
let ADMIN_ID; // set via CLI

// In-memory pending requests (to allow admin to cancel)
const pendingRequests = {}; // { chatId: { cancel: boolean } }

// Define adminState only once:
const adminState = {}; // { chatId: { stage: string } }

// ---------------------------
// Helper: Random delay between min and max milliseconds
// ---------------------------
function randomDelay(min, max) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, delay));
}

// ---------------------------
// Styling helpers
// ---------------------------
// sendMessageWithHeader sends a header in a code block (quote style) then a normal body
async function sendMessageWithHeader(chatId, header, body) {
  try {
    await bot.sendMessage(chatId, "```\n" + header + "\n```", { parse_mode: 'Markdown' });
    let fullBody = body;
    if (globalCaption) fullBody += "\n" + globalCaption;
    if (suffix) fullBody += "\n" + suffix;
    await bot.sendMessage(chatId, fullBody);
  } catch (err) {
    console.error("Error sending message with header:", err.message);
  }
}

// userLog sends a plain message with the suffix appended
async function userLog(chatId, message) {
  let fullMessage = message;
  if (suffix) fullMessage += "\n" + suffix;
  try {
    await bot.sendMessage(chatId, fullMessage);
  } catch (err) {
    console.error("Error sending log message to user:", err.message);
  }
}

// ---------------------------
// QUACK AI FUNCTIONS
// ---------------------------
const API_BASE_URL = 'https://quack-ai-api.duckchain.io';
const APP_REFERER = 'https://app.quackai.ai/';

function createAxiosInstance(proxy = null) {
  if (!proxy) return axios;
  return axios; // Proxy handling omitted for brevity.
}

async function createWallet() {
  const wallet = ethers.Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    mnemonic: wallet.mnemonic.phrase,
    registered: false,
    chats: 0,
    jwt: null,
    topics: [],       // user-provided topics will be stored here
    usedTopics: []    // to track used topics
  };
}

async function signMessage(privateKey) {
  const wallet = new ethers.Wallet(privateKey);
  const message = "Welcome to Quack AI";
  const signature = await wallet.signMessage(message);
  return signature;
}

async function registerWallet(wallet, referralCode) {
  try {
    console.log(`Registering wallet: ${wallet.address}`);
    const axiosInstance = createAxiosInstance();
    await axiosInstance.get(`${API_BASE_URL}/user/user_info?address=${wallet.address}`, {
      headers: { "Referer": APP_REFERER }
    });
    const signature = await signMessage(wallet.privateKey);
    const connectResponse = await axiosInstance.post(`${API_BASE_URL}/user/evm_connect`, {
      address: wallet.address,
      sign: signature
    }, {
      headers: { "content-type": "application/json; charset=utf-8", "Referer": APP_REFERER }
    });
    if (!connectResponse.data.data || !connectResponse.data.data.token) {
      throw new Error("Failed to get authentication token");
    }
    wallet.jwt = connectResponse.data.data.token;
    await axiosInstance.get(`${API_BASE_URL}/user/bind_invite?inviteCode=${referralCode}`, {
      headers: { "Referer": APP_REFERER, "authorization": `jwt ${wallet.jwt}` }
    });
    const userInfoResponse = await axiosInstance.get(`${API_BASE_URL}/user/user_info?address=${wallet.address}`, {
      headers: { "Referer": APP_REFERER, "authorization": `jwt ${wallet.jwt}` }
    });
    if (userInfoResponse.data.code === 200) {
      wallet.registered = true;
      console.log(`✅ Successfully registered wallet: ${wallet.address}`);
      return true;
    } else {
      console.log(`❌ Failed to register wallet: ${wallet.address}`);
      return false;
    }
  } catch (error) {
    console.error(`Error registering wallet ${wallet.address}:`, error.response?.data || error.message);
    return false;
  }
}

function getRandomTopic(wallet) {
  if (!wallet.topics || wallet.topics.length === 0) return "Default topic";
  const available = wallet.topics.filter(t => !wallet.usedTopics.includes(t));
  if (available.length === 0) {
    wallet.usedTopics = [];
    return wallet.topics[Math.floor(Math.random() * wallet.topics.length)];
  }
  const randomIndex = Math.floor(Math.random() * available.length);
  const topic = available[randomIndex];
  wallet.usedTopics.push(topic);
  return topic;
}

async function performChat(wallet, chatIndex) {
  try {
    if (!wallet.jwt) {
      console.log(`No JWT for wallet ${wallet.address}`);
      return false;
    }
    const axiosInstance = createAxiosInstance();
    const topic = getRandomTopic(wallet);
    console.log(`Wallet ${wallet.address} - Chat ${chatIndex + 1}: "${topic}"`);
    const chatResponse = await axiosInstance.post(`${API_BASE_URL}/api/v1/conversations`, {
      query: topic,
      conversation_id: "",
      address: wallet.address
    }, {
      headers: {
        "content-type": "application/json",
        "Referer": APP_REFERER,
        "authorization": `jwt ${wallet.jwt}`
      }
    });
    await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
    if (chatResponse.status === 200) {
      wallet.chats++;
      console.log(`✅ Chat ${chatIndex + 1} completed for wallet: ${wallet.address}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error(`Error during chat for wallet ${wallet.address}:`, error.response?.data || error.message);
    return false;
  }
}

async function completeDailyChats(wallet) {
  console.log(`Starting daily chats for wallet: ${wallet.address}`);
  for (let i = 0; i < 5; i++) {
    const success = await performChat(wallet, i);
    if (!success) {
      console.log(`Chat sequence stopped for wallet ${wallet.address} due to error`);
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 3000));
  }
  console.log(`Completed ${wallet.chats}/5 chats for wallet: ${wallet.address}`);
}

// ---------------------------
// TELEGRAM BOT FUNCTIONS
// ---------------------------
const userState = {}; // { chatId: { stage, count, referralCode, topics } }

async function handleStart(chatId) {
  if (!usersList.includes(chatId)) {
    usersList.push(chatId);
    saveJSON(USERS_FILE, usersList);
    stats.totalUsers++;
    saveJSON(STATS_FILE, stats);
  }
  let fullWelcome = welcomeMessage;
  if (globalCaption) fullWelcome += "\n" + globalCaption;
  if (suffix) fullWelcome += "\n" + suffix;
  await bot.sendMessage(chatId, fullWelcome, { parse_mode: 'Markdown' });
  await bot.sendMessage(chatId, `Please enter the number of wallets you want to create (max ${maxLimit} per day):`);
  userState[chatId] = { stage: 'awaiting_count' };
}

async function processUserRequest(chatId, count, referralCode, topics) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (!usageData[chatId] || usageData[chatId].date !== today) {
      usageData[chatId] = { date: today, count: 0 };
    }
    if (usageData[chatId].count + count > maxLimit) {
      await bot.sendMessage(chatId, `Daily wallet creation limit reached. You have already created ${usageData[chatId].count} wallet(s) today. Maximum is ${maxLimit} per day.`);
      return;
    }
    stats.totalWalletRequests += count;
    saveJSON(STATS_FILE, stats);
    
    const createdWallets = [];
    for (let i = 0; i < count; i++) {
      await randomDelay(1000, 4000);
      if (pendingRequests[chatId] && pendingRequests[chatId].cancel) {
        await bot.sendMessage(chatId, "Your request has been cancelled by the admin.");
        break;
      }
      const wallet = await createWallet();
      wallet.topics = topics;
      if (referralCode.length !== 6) {
        await bot.sendMessage(chatId, "Referral code must be exactly 6 letters. Request cancelled.");
        break;
      }
      const registered = await registerWallet(wallet, referralCode);
      if (registered) {
        await completeDailyChats(wallet);
      }
      createdWallets.push(wallet);
      
      let existing = [];
      const userWalletFile = `wallet_${chatId}.json`;
      if (fs.existsSync(userWalletFile)) {
        try {
          existing = JSON.parse(fs.readFileSync(userWalletFile, 'utf8'));
        } catch (err) {
          await bot.sendMessage(chatId, `Error reading your wallet file: ${err.message}`);
        }
      }
      existing.push(wallet);
      fs.writeFileSync(userWalletFile, JSON.stringify(existing, null, 2));
      
      await sendMessageWithHeader(chatId, "✅️ Successful ✅️", `Wallet ${i + 1}️⃣ of ${count}️⃣ created`);
      
      usageData[chatId].count++;
      saveJSON(USAGE_FILE, usageData);
    }
    
    await bot.sendMessage(chatId, `Successfully processed ${createdWallets.length} wallet(s).`);
    try {
      const docMsg = await bot.sendDocument(chatId, `wallet_${chatId}.json`, { caption: "@Zoro_referralbot" });
      try {
        await bot.pinChatMessage(chatId, docMsg.message_id);
      } catch (e) {
        console.error("Error pinning message:", e.message);
      }
    } catch (error) {
      await bot.sendMessage(chatId, `Error sending your wallet file: ${error.message}`);
    }
  } catch (err) {
    console.error("Error in processUserRequest:", err);
  }
}

// ---------------------------
// TELEGRAM BOT SETUP & ADMIN PANEL
// ---------------------------
function getAdminMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🚫 Block User', callback_data: 'block_user' }, { text: '✅ Unblock User', callback_data: 'unblock_user' }],
        [{ text: '❌ Cancel User Request', callback_data: 'cancel_request' }],
        [{ text: '📊 Show Stats', callback_data: 'show_stats' }],
        [{ text: '✏️ Change Welcome Message', callback_data: 'change_welcome' }],
        [{ text: '📝 Set Suffix', callback_data: 'set_suffix' }, { text: '🗑 Remove Suffix', callback_data: 'remove_suffix' }],
        [{ text: '🔧 Change Max Limit', callback_data: 'change_max_limit' }],
        [{ text: '🖼 Set Global Caption', callback_data: 'set_global_caption' }],
        [{ text: '📢 Broadcast', callback_data: 'broadcast' }]
      ]
    }
  };
}

process.on('uncaughtException', err => {
  console.error("Uncaught Exception:", err);
});

const rlInterface = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rlInterface.question('Enter your Telegram Bot Token: ', token => {
  rlInterface.question('Enter your Admin Telegram ID: ', adminIdInput => {
    ADMIN_ID = parseInt(adminIdInput);
    bot = new TelegramBot(token, { polling: true });
    console.log('Telegram bot started.');

    bot.on('inline_query', query => {
      const results = [{
        type: 'article',
        id: '1',
        title: 'Quack AI Bot',
        input_message_content: {
          message_text: 'Use /start in a private chat with me to create wallets and chat with Quack AI.'
        }
      }];
      bot.answerInlineQuery(query.id, results);
    });

    bot.on('message', async msg => {
      const chatId = msg.chat.id;
      const text = msg.text;
      if (blockedUsers.includes(chatId)) {
        await bot.sendMessage(chatId, "You are blocked 🚫.");
        return;
      }
      if (chatId === ADMIN_ID && text === '/admin') {
        adminState[chatId] = { stage: 'idle' };
        await bot.sendMessage(chatId, "Admin Menu:", getAdminMenu());
        return;
      }
      if (chatId === ADMIN_ID && adminState[chatId] && adminState[chatId].stage !== 'idle') {
        switch (adminState[chatId].stage) {
          case 'block': {
            const targetId = parseInt(text.trim());
            if (isNaN(targetId)) {
              await bot.sendMessage(chatId, "Invalid chat ID. Please send a valid number.");
              return;
            }
            if (!blockedUsers.includes(targetId)) {
              blockedUsers.push(targetId);
              saveJSON(BLOCKED_FILE, blockedUsers);
              await bot.sendMessage(chatId, `User ${targetId} has been blocked 🚫.`);
            } else {
              await bot.sendMessage(chatId, `User ${targetId} is already blocked.`);
            }
            adminState[chatId].stage = 'idle';
            break;
          }
          case 'unblock': {
            const targetId = parseInt(text.trim());
            if (isNaN(targetId)) {
              await bot.sendMessage(chatId, "Invalid chat ID. Please send a valid number.");
              return;
            }
            if (blockedUsers.includes(targetId)) {
              blockedUsers = blockedUsers.filter(id => id !== targetId);
              saveJSON(BLOCKED_FILE, blockedUsers);
              await bot.sendMessage(chatId, `User ${targetId} has been unblocked.`);
            } else {
              await bot.sendMessage(chatId, `User ${targetId} is not in the blocked list.`);
            }
            adminState[chatId].stage = 'idle';
            break;
          }
          case 'cancel': {
            const targetId = parseInt(text.trim());
            if (isNaN(targetId)) {
              await bot.sendMessage(chatId, "Invalid chat ID. Please send a valid number.");
              return;
            }
            pendingRequests[targetId] = { cancel: true };
            await bot.sendMessage(chatId, `Wallet creation request for user ${targetId} has been cancelled.`);
            try {
              await bot.sendMessage(targetId, "Your wallet creation request has been cancelled by the admin.");
            } catch (e) { }
            adminState[chatId].stage = 'idle';
            break;
          }
          case 'change_welcome': {
            welcomeMessage = text;
            fs.writeFileSync(WELCOME_FILE, welcomeMessage);
            await bot.sendMessage(chatId, "Welcome message updated.");
            adminState[chatId].stage = 'idle';
            break;
          }
          case 'set_suffix': {
            suffix = text;
            fs.writeFileSync(SUFFIX_FILE, suffix);
            await bot.sendMessage(chatId, "Suffix updated.");
            adminState[chatId].stage = 'idle';
            break;
          }
          case 'change_max_limit': {
            const newLimit = parseInt(text.trim());
            if (isNaN(newLimit) || newLimit <= 0) {
              await bot.sendMessage(chatId, "Please provide a valid positive number for max limit.");
              return;
            }
            maxLimit = newLimit;
            saveJSON(MAXLIMIT_FILE, maxLimit);
            await bot.sendMessage(chatId, `Max wallet creation limit updated to ${maxLimit}.`);
            adminState[chatId].stage = 'idle';
            break;
          }
          case 'set_global_caption': {
            globalCaption = text;
            fs.writeFileSync(GLOBALCAPTION_FILE, globalCaption);
            await bot.sendMessage(chatId, "Global caption updated.");
            adminState[chatId].stage = 'idle';
            break;
          }
          case 'broadcast': {
            const header = "Broadcast";
            for (const userId of usersList) {
              try {
                await bot.sendMessage(userId, "```\n" + header + "\n```", { parse_mode: 'Markdown' });
                await bot.sendMessage(userId, text);
              } catch (e) { }
            }
            await bot.sendMessage(chatId, "Broadcast message sent to all users.");
            adminState[chatId].stage = 'idle';
            break;
          }
          default:
            break;
        }
        return;
      }
      if (text === '/start') {
        await handleStart(chatId);
        return;
      }
      if (!userState[chatId]) return;
      const state = userState[chatId];
      if (state.stage === 'awaiting_count') {
        const count = parseInt(text);
        if (isNaN(count) || count <= 0 || count > maxLimit) {
          await bot.sendMessage(chatId, `Please enter a valid number (1-${maxLimit}).`);
        } else {
          state.count = count;
          state.stage = 'awaiting_ref';
          await bot.sendMessage(chatId, "Please enter your referral code (exactly 6 letters):");
        }
        return;
      }
      if (state.stage === 'awaiting_ref') {
        const refCode = text.trim();
        if (refCode.length !== 6) {
          await bot.sendMessage(chatId, "Referral code must be exactly 6 letters. Please try again.");
          return;
        }
        state.referralCode = refCode;
        state.stage = 'awaiting_topics';
        await bot.sendMessage(chatId, "Please send your topics (separated by commas):");
        return;
      }
      if (state.stage === 'awaiting_topics') {
        const topics = text.split(",").map(t => t.trim()).filter(t => t.length > 0);
        if (topics.length === 0) {
          await bot.sendMessage(chatId, "You must provide at least one topic. Please try again.");
          return;
        }
        state.topics = topics;
        state.stage = 'processing';
        await bot.sendMessage(chatId, `Starting wallet creation for ${state.count} wallet(s) with referral code "${state.referralCode}" and topics: ${topics.join("; ")}.\nPlease wait...`);
        processUserRequest(chatId, state.count, state.referralCode, state.topics);
        delete userState[chatId];
        return;
      }
    });

    bot.on('callback_query', async callbackQuery => {
      const action = callbackQuery.data;
      const adminChatId = callbackQuery.from.id;
      if (adminChatId !== ADMIN_ID) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: "You are not authorized to perform this action." });
        return;
      }
      switch (action) {
        case 'block_user':
          adminState[adminChatId] = { stage: 'block' };
          await bot.sendMessage(adminChatId, "Please send the chat ID of the user to block:");
          break;
        case 'unblock_user':
          adminState[adminChatId] = { stage: 'unblock' };
          await bot.sendMessage(adminChatId, "Please send the chat ID of the user to unblock:");
          break;
        case 'cancel_request':
          adminState[adminChatId] = { stage: 'cancel' };
          await bot.sendMessage(adminChatId, "Please send the chat ID of the user whose request you want to cancel:");
          break;
        case 'show_stats':
          await bot.sendMessage(adminChatId, `*Stats:*\nTotal Users: ${stats.totalUsers}\nTotal Wallet Requests: ${stats.totalWalletRequests}\nMax Limit: ${maxLimit}`, { parse_mode: 'Markdown' });
          break;
        case 'change_welcome':
          adminState[adminChatId] = { stage: 'change_welcome' };
          await bot.sendMessage(adminChatId, "Please send the new welcome message:");
          break;
        case 'set_suffix':
          adminState[adminChatId] = { stage: 'set_suffix' };
          await bot.sendMessage(adminChatId, "Please send the new suffix text:");
          break;
        case 'change_max_limit':
          adminState[adminChatId] = { stage: 'change_max_limit' };
          await bot.sendMessage(adminChatId, "Please send the new maximum wallet creation limit:");
          break;
        case 'set_global_caption':
          adminState[adminChatId] = { stage: 'set_global_caption' };
          await bot.sendMessage(adminChatId, "Please send the new global caption text (this will be appended to all messages):");
          break;
        case 'broadcast':
          adminState[adminChatId] = { stage: 'broadcast' };
          await bot.sendMessage(adminChatId, "Please send the message to broadcast to all users:");
          break;
        default:
          break;
      }
      await bot.answerCallbackQuery(callbackQuery.id);
    });
  });
});
