const fs = require('fs');
const path = require('path');

// На bothost.ru папка /app/data — единственное место, которое переживает деплой
// (при обновлении из Git код перезаписывается, а /app/data — нет). Если её нет
// (например, локальная разработка не на bothost) — используем папку рядом с ботом.
const DATA_DIR = fs.existsSync('/app/data') ? '/app/data' : __dirname;
const FILE = path.join(DATA_DIR, 'voicedata.json');

function ensureFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
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
  // Пишем во временный файл и переименовываем — так при падении процесса
  // посреди записи voicedata.json не остаётся битым (rename атомарен на диске).
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

module.exports = { loadVoiceData, saveVoiceData };
