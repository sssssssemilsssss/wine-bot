const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

// ID роли и канала для оповещений о войнах — можно переопределить через .env,
// если не заданы — используются значения по умолчанию ниже.
const WAR_ROLE_ID = process.env.TG_WAR_ROLE_ID || '1515042126948335722';
const WAR_CHANNEL_ID = process.env.TG_WAR_CHANNEL_ID || '1515042128164552922';

// Канал KD-VZP, где живёт статус "когда доступна следующая атака/защита".
// Обязательно нужно задать в .env, иначе эта функция просто выключена.
const STATUS_CHANNEL_ID = process.env.TG_STATUS_CHANNEL_ID || '1531782412894343208';

// Кулдауны после объявления войны.
const ATT_COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3 часа
const DEFF_COOLDOWN_MS = 90 * 60 * 1000; // 1 час 30 минут

// Общий кусок в конце строки: "на 23:00, 20х20, алкоголь/анальгетики, косяки/SPANK разрешены."
const DETAILS_RE = /на (\d{1,2}:\d{2}),\s*([^,]+),\s*(.+?)\s*разрешены\.?\s*$/i;

// Опознаватели: по каким фразам в тексте понимаем, что сообщение нужно переслать,
// и как разобрать строку на составляющие (тип, соперник, локация, время, состав, разрешёнка).
const IDENTIFIERS = [
  {
    // "Ваша организация забила ... войну" — войну объявили вы (атака)
    type: 'att',
    match: (line) => line.includes('Ваша организация забила'),
    parse: (line) => {
      const head = line.match(/^Ваша организация забила (.+?) войну за (.+?) на /i);
      const details = line.match(DETAILS_RE);
      if (!head || !details) return null;
      return {
        type: 'att',
        opponent: head[1].trim(),
        location: head[2].trim(),
        time: details[1].trim(),
        size: details[2].trim(),
        items: details[3].trim(),
      };
    },
  },
  {
    // "... забили Вашей организации войну" — войну объявили вам (защита)
    type: 'deff',
    match: (line) => line.includes('забили Вашей организации'),
    parse: (line) => {
      const head = line.match(/^(.+?) забили Вашей организации войну за (.+?) на /i);
      const details = line.match(DETAILS_RE);
      if (!head || !details) return null;
      return {
        type: 'deff',
        opponent: head[1].trim(),
        location: head[2].trim(),
        time: details[1].trim(),
        size: details[2].trim(),
        items: details[3].trim(),
      };
    },
  },
];

// Из всего текста сообщения достаём именно нужную строку (без шапки
// "📋 Организация: события | ..." и пустых строк).
function findMatchingLine(text) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    const identifier = IDENTIFIERS.find((id) => id.match(line));
    if (identifier) return { line, identifier };
  }
  return null;
}

// Красиво собираем сообщение для Discord. Если распарсить детали не удалось —
// откатываемся на исходную строку, чтобы точно ничего не потерять.
function buildForwardMessage(line, identifier) {
  const parsed = identifier.parse(line);

  if (!parsed) {
    return `# ⚔️ Война объявлена\n${line}\n<@&${WAR_ROLE_ID}>`;
  }

  const isAttack = parsed.type === 'att';
  const header = isAttack ? '# ⚔️ ВЗП — АТАКА' : '# 🛡️ ВЗП — ЗАЩИТА';
  const opponentLabel = isAttack ? '🏴 Организация' : '🚨 Организация';

  const lines = [
    header,
    `${opponentLabel}: **${parsed.opponent}**`,
    `📍 Точка: **${parsed.location}**`,
    `🕒 Время: **${parsed.time}**`,
    `👥 Количество: **${parsed.size}**`,
    `🧪 Резисты: ${parsed.items}`,
    '',
    `<@&${WAR_ROLE_ID}>`,
  ];

  return lines.join('\n');
}

// ---------- Статус-таймеры в канале KD-VZP ----------

const TIMERS_FILE = path.join(__dirname, 'warTimers.json');

function loadTimers() {
  try {
    return JSON.parse(fs.readFileSync(TIMERS_FILE, 'utf8'));
  } catch {
    return { attAvailableAt: 0, deffAvailableAt: 0, statusMessageId: null };
  }
}

function saveTimers(data) {
  try {
    fs.writeFileSync(TIMERS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Не удалось сохранить warTimers.json:', e);
  }
}

let timers = loadTimers();
let lastRenderedContent = null;

function buildStatusContent() {
  const now = Date.now();

  const attLine =
    timers.attAvailableAt && timers.attAvailableAt > now
      ? `⏳ <t:${Math.floor(timers.attAvailableAt / 1000)}:R>`
      : '✅ Доступно';

  const deffLine =
    timers.deffAvailableAt && timers.deffAvailableAt > now
      ? `⏳ <t:${Math.floor(timers.deffAvailableAt / 1000)}:R>`
      : '✅ Доступно';

  return ['# 📊 Статус ВЗП', '', `⚔️ **АТАКА**: ${attLine}`, `🛡️ **ЗАЩИТА**: ${deffLine}`].join('\n');
}

async function ensureStatusMessage(discordClient) {
  if (!STATUS_CHANNEL_ID) return null;

  const channel = await discordClient.channels.fetch(STATUS_CHANNEL_ID).catch(() => null);
  if (!channel) {
    console.error('Не найден канал KD-VZP для статуса:', STATUS_CHANNEL_ID);
    return null;
  }

  if (timers.statusMessageId) {
    const existing = await channel.messages.fetch(timers.statusMessageId).catch(() => null);
    if (existing) return existing;
  }

  const content = buildStatusContent();
  const msg = await channel.send({ content });
  timers.statusMessageId = msg.id;
  saveTimers(timers);
  lastRenderedContent = content;
  return msg;
}

async function updateStatusMessage(discordClient) {
  if (!STATUS_CHANNEL_ID) return;
  try {
    const msg = await ensureStatusMessage(discordClient);
    if (!msg) return;

    const content = buildStatusContent();
    if (content === lastRenderedContent) return; // ничего не поменялось — не дёргаем API зря

    lastRenderedContent = content;
    await msg.edit({ content });
  } catch (e) {
    console.error('Не удалось обновить статус ВЗП:', e);
  }
}

// ---------- Основной запуск ----------

async function startTelegramForwarder(discordClient) {
  const apiId = parseInt(process.env.API_ID, 10);
  const apiHash = process.env.API_HASH;
  const sessionString = process.env.TELEGRAM_SESSION;

  if (!apiId || !apiHash || !sessionString) {
    console.log('Пересылка Telegram → Discord выключена: не заданы API_ID / API_HASH / TELEGRAM_SESSION.');
    return;
  }

  const tgClient = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
  });

  await tgClient.connect();
  console.log('✅ Пересылка Telegram → Discord подключена (только сообщения о войнах организации).');

  // Статус ВЗП: сразу приводим сообщение в актуальный вид и дальше обновляем раз в минуту
  // (обновление нужно только чтобы вовремя переключить "⏳ ..." на "✅ Доступно").
  if (STATUS_CHANNEL_ID) {
    await updateStatusMessage(discordClient);
    setInterval(() => updateStatusMessage(discordClient), 60 * 1000);
  } else {
    console.log('ℹ️ Статус ВЗП выключен: не задан TG_STATUS_CHANNEL_ID.');
  }

  tgClient.addEventHandler(async (event) => {
    try {
      if (!event.isPrivate) return; // только личные сообщения
      const message = event.message;
      if (!message || message.out) return; // не пересылаем свои же исходящие
      if (!message.message) return; // без текста — нечего искать

      const found = findMatchingLine(message.message);
      if (!found) return; // не подошло ни под один опознаватель — игнорируем

      const content = buildForwardMessage(found.line, found.identifier).slice(0, 2000);

      const channel = await discordClient.channels.fetch(WAR_CHANNEL_ID).catch(() => null);
      if (!channel) {
        console.error('Не найден канал Discord для пересылки:', WAR_CHANNEL_ID);
        return;
      }

      await channel.send({ content });
      console.log('Переслано сообщение о войне:', found.line);

      // Запускаем/обновляем таймер соответствующего типа и обновляем статус в KD-VZP
      const cooldownMs = found.identifier.type === 'att' ? ATT_COOLDOWN_MS : DEFF_COOLDOWN_MS;
      const availableAt = Date.now() + cooldownMs;

      if (found.identifier.type === 'att') {
        timers.attAvailableAt = availableAt;
      } else {
        timers.deffAvailableAt = availableAt;
      }
      saveTimers(timers);

      await updateStatusMessage(discordClient);
    } catch (e) {
      console.error('Ошибка обработки входящего Telegram-сообщения:', e);
    }
  }, new NewMessage({ incoming: true }));
}

module.exports = { startTelegramForwarder };
