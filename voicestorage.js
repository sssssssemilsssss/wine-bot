const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'voicedata.json');

function ensureFile() {
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ configs: {}, rooms: {}, waitingRooms: {} }, null, 2), 'utf8');
  }
}

function loadVoiceData() {
  ensureFile();
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const obj = JSON.parse(raw);
    return {
      configs: obj.configs || {},
      rooms: obj.rooms || {},
      waitingRooms: obj.waitingRooms || {},
    };
  } catch (e) {
    console.error('Ошибка загрузки voicedata.json:', e);
    return { configs: {}, rooms: {}, waitingRooms: {} };
  }
}

function saveVoiceData(data) {
  ensureFile();
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = { loadVoiceData, saveVoiceData };
