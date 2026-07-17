const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'lists.json');

function ensureFile() {
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
  fs.writeFileSync(FILE, JSON.stringify(obj, null, 2), 'utf8');
}

module.exports = { loadLists, saveLists };
