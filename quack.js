const fs = require('fs');
const path = require('path');
const ethers = require('ethers');
const axios = require('axios');
const readline = require('readline');
const { HttpsProxyAgent } = require('https-proxy-agent'); 

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const INVITE_CODE = fs.existsSync('code.txt') 
  ? fs.readFileSync('code.txt', 'utf8').trim() 
  : 'texlm7';

const CHAT_TOPICS = fs.existsSync('topics.txt')
  ? fs.readFileSync('topics.txt', 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
  : [
      "How does Quack AI automate DAO governance?",
      "What are the benefits of AI in blockchain applications?",
      "How can AI improve decentralized finance systems?",
      "Explain the relationship between AI and smart contracts",
      "What is the future of AI in web3 technologies?",
      "How does Quack AI help with token analysis?",
      "What are the security implications of AI in blockchain?",
      "How can AI enhance crypto trading strategies?",
      "Explain how AI can improve blockchain scalability",
      "What role does AI play in decentralized identity systems?"
    ];

const PROXIES = fs.existsSync('proxies.txt')
  ? fs.readFileSync('proxies.txt', 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
  : [];

const API_BASE_URL = 'https://quack-ai-api.duckchain.io';
const APP_REFERER = 'https://app.quackai.ai/';
const WALLETS_FILE = path.join(__dirname, 'wallets.json');

const getDefaultHeaders = (jwt = '') => ({
  "accept": "*/*",
  "Referer": APP_REFERER,
  "sec-ch-ua": "\"Chromium\";v=\"134\", \"Not:A-Brand\";v=\"24\", \"Brave\";v=\"134\"",
  "sec-ch-ua-platform": "\"Windows\"",
  "sec-ch-ua-mobile": "?0",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "cross-site",
  "sec-gpc": "1",
  ...(jwt ? { "authorization": `jwt ${jwt}` } : {})
});

function getRandomProxy() {
  if (PROXIES.length === 0) return null;
  const randomIndex = Math.floor(Math.random() * PROXIES.length);
  return PROXIES[randomIndex];
}

function createAxiosInstance(proxy = null) {
  if (!proxy) return axios;
  
  let proxyUrl = proxy;
  if (!proxyUrl.startsWith('http://') && !proxyUrl.startsWith('https://')) {
    proxyUrl = `http://${proxyUrl}`; 
  }
  
  const agent = new HttpsProxyAgent(proxyUrl);
  return axios.create({
    httpsAgent: agent,
    httpAgent: agent,
    proxy: false 
  });
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
    usedTopics: [],
    proxy: getRandomProxy() 
  };
}

async function signMessage(privateKey) {
  const wallet = new ethers.Wallet(privateKey);
  const message = "Welcome to Quack AI";
  const signature = await wallet.signMessage(message);
  return signature;
}

async function registerWallet(wallet) {
  try {
    console.log(`Registering wallet: ${wallet.address} ${wallet.proxy ? `using proxy: ${wallet.proxy}` : 'without proxy'}`);
    
    const axiosInstance = createAxiosInstance(wallet.proxy);
    
    await axiosInstance.get(`${API_BASE_URL}/user/user_info?address=${wallet.address}`, {
      headers: getDefaultHeaders()
    });
    
    const signature = await signMessage(wallet.privateKey);
    const connectResponse = await axiosInstance.post(`${API_BASE_URL}/user/evm_connect`, {
      address: wallet.address,
      sign: signature
    }, {
      headers: {
        ...getDefaultHeaders(),
        "content-type": "application/json; charset=utf-8"
      }
    });
    
    if (!connectResponse.data.data || !connectResponse.data.data.token) {
      throw new Error("Failed to get authentication token");
    }
    
    wallet.jwt = connectResponse.data.data.token;
    
    await axiosInstance.get(`${API_BASE_URL}/user/bind_invite?inviteCode=${INVITE_CODE}`, {
      headers: getDefaultHeaders(wallet.jwt)
    });
    
    const userInfoResponse = await axiosInstance.get(`${API_BASE_URL}/user/user_info?address=${wallet.address}`, {
      headers: getDefaultHeaders(wallet.jwt)
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
  const availableTopics = CHAT_TOPICS.filter(topic => !wallet.usedTopics.includes(topic));
  if (availableTopics.length === 0) {
    wallet.usedTopics = [];
    return CHAT_TOPICS[Math.floor(Math.random() * CHAT_TOPICS.length)];
  }
  const randomIndex = Math.floor(Math.random() * availableTopics.length);
  const selectedTopic = availableTopics[randomIndex];
  wallet.usedTopics.push(selectedTopic);
  return selectedTopic;
}

async function performChat(wallet, chatIndex) {
  try {
    if (!wallet.jwt) {
      console.log(`No JWT available for wallet ${wallet.address}`);
      return false;
    }
    
    const axiosInstance = createAxiosInstance(wallet.proxy);
    const topic = getRandomTopic(wallet);
    console.log(`Wallet ${wallet.address} - Chat ${chatIndex + 1}/5: "${topic}"`);
    
    const chatResponse = await axiosInstance.post(`${API_BASE_URL}/api/v1/conversations`, {
      query: topic,
      conversation_id: "",
      address: wallet.address
    }, {
      headers: {
        ...getDefaultHeaders(wallet.jwt),
        "content-type": "application/json"
      }
    });
    
    await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
    
    if (chatResponse.status === 200) {
      wallet.chats++;
      console.log(`✅ Chat ${chatIndex + 1}/5 completed for wallet: ${wallet.address}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error(`Error performing chat for wallet ${wallet.address}:`, error.response?.data || error.message);
    return false;
  }
}

async function completeDailyChats(wallet) {
  console.log(`Starting daily chats for wallet: ${wallet.address}`);
  
  for (let i = 0; i < 5; i++) {
    const success = await performChat(wallet, i);
    if (!success) {
      console.log(`Stopped chat sequence for wallet ${wallet.address} due to error`);
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 3000));
  }
  
  console.log(`Completed ${wallet.chats}/5 chats for wallet: ${wallet.address}`);
}

function loadWallets() {
  try {
    if (fs.existsSync(WALLETS_FILE)) {
      const data = fs.readFileSync(WALLETS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading wallets file:', error.message);
  }
  return { wallets: [] };
}

function saveWallets(walletsData) {
  try {
    fs.writeFileSync(WALLETS_FILE, JSON.stringify(walletsData, null, 2));
    console.log(`Saved wallet data to ${WALLETS_FILE}`);
  } catch (error) {
    console.error('Error saving wallets file:', error.message);
  }
}

async function main() {
  console.log('\n=== Quack AI Auto Reff & Auto Chat Bot - Airdrop Insiders ===');
  console.log(`Using invite code: ${INVITE_CODE}`);
  console.log(`Loaded ${CHAT_TOPICS.length} chat topics`);
  console.log(`Loaded ${PROXIES.length} proxies`);
  
  const walletsData = loadWallets();
  
  rl.question('How many wallets do you want to create? ', async (answer) => {
    const count = parseInt(answer.trim());
    
    if (isNaN(count) || count <= 0) {
      console.log('Please enter a valid number greater than 0.');
      rl.close();
      return;
    }
    
    console.log(`Creating ${count} wallets...`);
    
    for (let i = 0; i < count; i++) {
      console.log(`\nProcessing wallet ${i + 1}/${count}`);
      
      const wallet = await createWallet();
      const registered = await registerWallet(wallet);
      
      if (registered) {
        await completeDailyChats(wallet);
      }
      
      walletsData.wallets.push(wallet);
      saveWallets(walletsData);
      
      if (i < count - 1) {
        console.log('Waiting before processing next wallet...');
        await new Promise(resolve => setTimeout(resolve, 3000 + Math.random() * 5000));
      }
    }
    
    console.log('\n=== Summary ===');
    console.log(`Total wallets created: ${count}`);
    console.log(`Successfully registered: ${walletsData.wallets.filter(w => w.registered).length}`);
    console.log(`Wallets that completed all chats: ${walletsData.wallets.filter(w => w.chats === 5).length}`);
    console.log(`\nAll wallet details saved to ${WALLETS_FILE}`);
    rl.close();
  });
}

rl.on('close', () => {
  console.log('\nThank you and dont forget to join channel');
  process.exit(0);
});

main().catch(error => {
  console.error('An error occurred:', error);
  rl.close();
});