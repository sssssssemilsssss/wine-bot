const fs = require('fs');
const path = require('path');

// На bothost.ru папка /app/data — единственное место, которое переживает деплой
// (при обновлении из Git код перезаписывается, а /app/data — нет). Если её нет
// (например, локальная разработка не на bothost) — используем папку рядом с ботом.
const DATA_DIR = fs.existsSync('/app/data') ? '/app/data' : __dirname;
const FILE = path.join(DATA_DIR, 'lists.json');

function ensureFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, '{}', 'utf8');
  }
}

function loadLists() {
  ensureFile();
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const obj = JSON.parse(raw);
    const map = new Map();
    for (const [id, val] of Object.entries(obj)) {
      map.set(id, {
        ...val,
        participants: val.participants || [],
        admins: val.admins || [],
      });
    }
    return map;
  } catch (e) {
    console.error('Ошибка загрузки lists.json:', e);
    return new Map();
  }
}

function saveLists(map) {
  ensureFile();
  const obj = {};
  for (const [id, val] of map.entries()) obj[id] = val;
  // Пишем во временный файл и переименовываем — так при падении процесса
  // посреди записи lists.json не остаётся битым (rename атомарен на диске).
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

module.exports = { loadLists, saveLists };
