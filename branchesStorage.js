const fs = require('fs');
const path = require('path');

// На bothost.ru папка /app/data — единственное место, которое переживает деплой
// (при обновлении из Git код перезаписывается, а /app/data — нет). Если её нет
// (например, локальная разработка не на bothost) — используем папку рядом с ботом.
const DATA_DIR = fs.existsSync('/app/data') ? '/app/data' : __dirname;
const FILE = path.join(DATA_DIR, 'branches.json');

// Хранит ветки отчётов (!ветка) как Map<threadId, branch>, на диске — как обычный объект.
function loadBranches() {
  if (!fs.existsSync(FILE)) return new Map();
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const obj = raw ? JSON.parse(raw) : {};
    return new Map(Object.entries(obj));
  } catch (e) {
    console.error('Не удалось прочитать branches.json, начинаю с пустого хранилища:', e);
    return new Map();
  }
}

function saveBranches(branches) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const obj = Object.fromEntries(branches);
  // Пишем во временный файл и переименовываем — так при падении процесса
  // посреди записи branches.json не остаётся битым (rename атомарен на диске).
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

module.exports = { loadBranches, saveBranches };
